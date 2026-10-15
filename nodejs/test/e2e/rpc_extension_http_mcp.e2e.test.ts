/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, onTestFailed, onTestFinished } from "vitest";
import { z } from "zod";
import {
    approveAll,
    CopilotClient,
    RuntimeConnection,
    type CopilotSession,
    type PermissionHandler,
    type PermissionRequest,
} from "../../src/index.js";
import { resolvePreparedRuntimePath } from "../../scripts/prepare-runtime.js";
import {
    createSdkTestContext,
    DEFAULT_GITHUB_TOKEN,
    getLegacyCliPathForTests,
} from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

const directory = dirname(fileURLToPath(import.meta.url));
const extensionFixture = join(directory, "fixtures", "http-mcp-extension.mjs");
const extensionDigest = createHash("sha256")
    .update(await readFile(extensionFixture))
    .digest("hex");
const sdkDirectory = resolve(directory, "../../dist");
const nativeCliPath = await resolvePreparedRuntimePath({ option: "--print-path" });
const cliDirectory = process.env.COPILOT_EXTENSION_SDK_PATH
    ? dirname(process.env.COPILOT_EXTENSION_SDK_PATH)
    : resolve(dirname(nativeCliPath), "../..");
const stepTimeoutMs = process.platform === "win32" ? 60_000 : 30_000;
const testTimeoutMs = process.platform === "win32" ? 180_000 : 90_000;
const serverName = "extensionprobe";
const directToolName = "extension_direct_probe";
const httpToolName = "extensionprobe-http_probe";

const rpcFrame = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z
        .object({
            name: z.string().optional(),
            arguments: z.object({ marker: z.string() }).optional(),
        })
        .optional(),
});
const joinStatus = z.discriminatedUnion("state", [
    z.object({
        state: z.literal("joined"),
        sessionId: z.string(),
        sdkPath: z.string(),
        mcpServers: z.record(
            z.string(),
            z.object({
                type: z.literal("http"),
                url: z.string(),
                tools: z.array(z.string()),
                timeout: z.number(),
            })
        ),
    }),
    z.object({ state: z.literal("failed"), error: z.string() }),
]);

async function readOwnedLogTails(directory: string) {
    const files = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
        .map((entry) => entry.name)
        .sort();
    const logs = [];
    for (const file of files.slice(-8)) {
        const handle = await open(join(directory, file), "r");
        try {
            const { size } = await handle.stat();
            const offset = Math.max(0, size - 64 * 1024);
            const buffer = Buffer.alloc(size - offset);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            logs.push({
                file,
                size,
                bytesRead,
                truncated: offset > 0 || bytesRead < buffer.length,
                tail: buffer.toString("utf8", 0, bytesRead),
            });
        } finally {
            await handle.close();
        }
    }
    return { omittedFiles: Math.max(0, files.length - logs.length), logs };
}

/** Stateless Streamable HTTP exercises the real connector without an MCP package or credentials. */
function createHttpMcpFixture() {
    const joinGate = Promise.withResolvers<void>();
    const methods: string[] = [];
    const requests: string[] = [];
    const responses: Array<{ method: string; status: number; body: unknown }> = [];
    const calls: Array<{ marker: string }> = [];
    const errors: unknown[] = [];
    const server = createServer((request, response) => {
        if (request.url === "/join-gate" && request.method === "GET") {
            void joinGate.promise
                .then(() => {
                    response.writeHead(204).end();
                })
                .catch((error) => errors.push(error));
            return;
        }
        if (request.url !== "/mcp") {
            response.writeHead(404).end();
            return;
        }
        if (request.method === "GET") {
            response.writeHead(405, { Allow: "POST" }).end();
            return;
        }
        if (request.method !== "POST") {
            errors.push(new Error(`Unexpected HTTP method: ${request.method}`));
            response.writeHead(405, { Allow: "POST" }).end();
            return;
        }
        request.setEncoding("utf8");
        let body = "";
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("error", (error) => errors.push(error));
        request.on("end", () => {
            requests.push(body);
            try {
                const frame = rpcFrame.parse(JSON.parse(body));
                methods.push(frame.method);
                if (frame.id === undefined) {
                    if (frame.method !== "notifications/initialized") {
                        throw new Error(`Unexpected MCP notification: ${frame.method}`);
                    }
                    response.writeHead(202).end();
                    return;
                }
                let result: unknown;
                switch (frame.method) {
                    case "server/discover": {
                        // This ordinary MCP peer declines optional modern discovery.
                        const unsupportedResponse = {
                            jsonrpc: "2.0",
                            id: frame.id,
                            error: { code: -32601, message: "Method not found" },
                        };
                        responses.push({
                            method: frame.method,
                            status: 200,
                            body: unsupportedResponse,
                        });
                        response
                            .writeHead(200, { "Content-Type": "application/json" })
                            .end(JSON.stringify(unsupportedResponse));
                        return;
                    }
                    case "initialize":
                        result = {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "extension-http-probe", version: "1.0" },
                        };
                        break;
                    case "tools/list":
                        result = {
                            tools: [
                                {
                                    name: "http_probe",
                                    description:
                                        "Record a marker on the HTTP server and return it.",
                                    inputSchema: {
                                        type: "object",
                                        properties: { marker: { type: "string" } },
                                        required: ["marker"],
                                        additionalProperties: false,
                                    },
                                    annotations: { readOnlyHint: false },
                                },
                            ],
                        };
                        break;
                    case "tools/call":
                        if (frame.params?.name !== "http_probe" || !frame.params.arguments) {
                            throw new Error(`Unexpected MCP tool call: ${body}`);
                        }
                        calls.push(frame.params.arguments);
                        result = {
                            content: [
                                {
                                    type: "text",
                                    text: `EXTENSION_HTTP_REPLY_${frame.params.arguments.marker}`,
                                },
                            ],
                            isError: false,
                        };
                        break;
                    case "ping":
                        result = {};
                        break;
                    default:
                        throw new Error(`Unexpected MCP method: ${frame.method}`);
                }
                const reply = { jsonrpc: "2.0", id: frame.id, result };
                responses.push({ method: frame.method, status: 200, body: reply });
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(reply));
            } catch (error) {
                errors.push(error);
                response.writeHead(500).end(String(error));
            }
        });
    });
    server.on("error", (error) => errors.push(error));

    return {
        methods,
        requests,
        responses,
        calls,
        releaseJoin() {
            joinGate.resolve();
        },
        assertHealthy() {
            if (errors.length) throw new AggregateError(errors, "HTTP MCP fixture failed");
        },
        async start() {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("HTTP MCP fixture did not bind a TCP port");
            }
            return `http://127.0.0.1:${address.port}/mcp`;
        },
        async close() {
            joinGate.resolve();
            server.closeAllConnections();
            if (server.listening) {
                await new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                });
            }
        },
    };
}

describe("Extension-provided HTTP MCP host parity", async () => {
    const { env: harnessEnv, workDir } = await createSdkTestContext({
        copilotClientOptions: { connection: RuntimeConnection.forStdio() },
    });

    it.for([
        [
            "Node registers and invokes both tool sources (join after initialization: false)",
            "Node",
            false,
            undefined,
        ],
        [
            "native registers and invokes both tool sources (join after initialization: false)",
            "native",
            false,
            undefined,
        ],
        [
            "Node registers and invokes both tool sources (join after initialization: true)",
            "Node",
            true,
            undefined,
        ],
        [
            "native registers and invokes both tool sources (join after initialization: true)",
            "native",
            true,
            undefined,
        ],
        ["native preserves both HTTP maps after a second extension joins", "native", true, "http"],
        [
            "native preserves the HTTP map when a second extension omits MCP configuration",
            "native",
            true,
            "omitted",
        ],
        [
            "native preserves the HTTP map when a second extension supplies an empty MCP map",
            "native",
            true,
            "empty",
        ],
        ["Node preserves both HTTP maps after a second extension joins", "Node", true, "http"],
    ] as const)(
        "%s",
        { timeout: testTimeoutMs },
        async ([_title, host, joinAfterInitialization, secondJoin], { expect, signal, task }) => {
            const fixture = createHttpMcpFixture();
            const secondFixture = secondJoin ? createHttpMcpFixture() : undefined;
            const permissions: PermissionRequest[] = [];
            const observations: Record<string, unknown> = {
                host,
                joinAfterInitialization,
                secondJoin,
                extensionDigest,
                stage: "preparation",
            };
            let client: CopilotClient | undefined;
            let session: CopilotSession | undefined;
            let creatingDirectory: Promise<string> | undefined;
            let preparing: Promise<void> | undefined;
            let starting: Promise<string> | undefined;
            let startingSecond: Promise<string> | undefined;
            let logDirectory: string | undefined;
            let failed = false;
            onTestFailed(() => {
                failed = true;
                console.error(
                    "Extension HTTP MCP stages:",
                    JSON.stringify({
                        ...observations,
                        methods: fixture.methods,
                        requests: fixture.requests,
                        responses: fixture.responses,
                        calls: fixture.calls,
                        secondMethods: secondFixture?.methods,
                        secondCalls: secondFixture?.calls,
                    })
                );
            });
            onTestFinished(async () => {
                // Finished hooks can run before failure hooks; use the settled test result.
                failed ||= task.result?.state === "fail";
                const failures: unknown[] = [];
                secondFixture?.releaseJoin();
                await Promise.allSettled(preparing ? [preparing] : []);
                try {
                    if (client) failures.push(...(await client.stop()));
                } catch (error) {
                    failures.push(error);
                }
                if (failed && logDirectory) {
                    try {
                        console.error(
                            "Extension HTTP MCP shutdown logs:",
                            JSON.stringify(await readOwnedLogTails(logDirectory))
                        );
                    } catch (error) {
                        console.error("Could not retain extension HTTP MCP shutdown logs:", error);
                    }
                }
                await Promise.allSettled([
                    ...(starting ? [starting] : []),
                    ...(startingSecond ? [startingSecond] : []),
                ]);
                try {
                    await fixture.close();
                    fixture.assertHealthy();
                } catch (error) {
                    failures.push(error);
                }
                try {
                    await secondFixture?.close();
                    secondFixture?.assertHealthy();
                } catch (error) {
                    failures.push(error);
                }
                const [created] = await Promise.allSettled(
                    creatingDirectory ? [creatingDirectory] : []
                );
                if (created?.status === "fulfilled") {
                    try {
                        await rm(created.value, { recursive: true, force: true });
                    } catch (error) {
                        failures.push(error);
                    }
                }
                if (failures.length) {
                    const error = new AggregateError(failures, "Extension HTTP MCP cleanup failed");
                    if (failed) console.error(error);
                    else throw error;
                }
            });

            creatingDirectory = mkdtemp(join(workDir, "extension-http-mcp-"));
            const ownedDirectory = await realpath(await creatingDirectory);
            signal.throwIfAborted();
            const home = join(ownedDirectory, "home");
            logDirectory = join(home, "logs");
            const extensionDirectory = join(home, "extensions", "http-probe");
            const secondExtensionDirectory = join(home, "extensions", "http-probe-second");
            const statusPath = join(ownedDirectory, "join-status.json");
            const callsPath = join(ownedDirectory, "direct-calls.jsonl");
            const secondStatusPath = join(ownedDirectory, "second-join-status.json");
            const secondCallsPath = join(ownedDirectory, "second-direct-calls.jsonl");
            // Resolve the Node control only inside its case so native-only selectors need no legacy bundle.
            const cliPath = host === "Node" ? await getLegacyCliPathForTests() : nativeCliPath;
            signal.throwIfAborted();
            if (host === "Node") expect(cliPath).not.toBe(nativeCliPath);
            preparing = (async () => {
                for (const path of [
                    join(sdkDirectory, "index.js"),
                    join(sdkDirectory, "extension.js"),
                    join(cliDirectory, "preloads", "extension_bootstrap.mjs"),
                    join(cliDirectory, "preloads", "extension_sdk_resolver.mjs"),
                ]) {
                    expect((await stat(path)).isFile(), `Missing prepared artifact: ${path}`).toBe(
                        true
                    );
                }
                execFileSync("git", ["init", "--quiet", ownedDirectory], { windowsHide: true });
                await mkdir(extensionDirectory, { recursive: true });
                const installedExtension = join(extensionDirectory, "extension.mjs");
                await copyFile(extensionFixture, installedExtension);
                expect(
                    createHash("sha256")
                        .update(await readFile(installedExtension))
                        .digest("hex")
                ).toBe(extensionDigest);
                if (secondJoin) {
                    await mkdir(secondExtensionDirectory, { recursive: true });
                    await copyFile(
                        extensionFixture,
                        join(secondExtensionDirectory, "extension.mjs")
                    );
                }
            })();
            await preparing;
            signal.throwIfAborted();
            starting = fixture.start();
            const url = await starting;
            startingSecond = secondFixture?.start();
            const secondUrl = await startingSecond;
            signal.throwIfAborted();
            client = new CopilotClient({
                workingDirectory: ownedDirectory,
                gitHubToken: DEFAULT_GITHUB_TOKEN,
                logLevel: "debug",
                connection: RuntimeConnection.forStdio({ path: cliPath }),
                env: {
                    ...harnessEnv,
                    COPILOT_HOME: home,
                    XDG_CONFIG_HOME: home,
                    XDG_STATE_HOME: home,
                    GH_CONFIG_DIR: home,
                    GH_TOKEN: DEFAULT_GITHUB_TOKEN,
                    GITHUB_TOKEN: DEFAULT_GITHUB_TOKEN,
                    COPILOT_HMAC_KEY: "",
                    CAPI_HMAC_KEY: "",
                    COPILOT_CACHE_HOME: join(ownedDirectory, "cache"),
                    COPILOT_PKG_CACHE_HOME: join(ownedDirectory, "package-cache"),
                    COPILOT_DISABLE_KEYTAR: "1",
                    COPILOT_CLI_ENABLED_FEATURE_FLAGS: "EXTENSIONS",
                    TOOL_SEARCH_DISABLED: "1",
                    COPILOT_MCP_TOOL_CACHE: "false",
                    COPILOT_MCP_APPS: "false",
                },
                extensionLaunchProvider: {
                    resolve: async (request) => {
                        const isSecond =
                            request.modulePath === join(secondExtensionDirectory, "extension.mjs");
                        const extensionUrl = isSecond ? secondUrl : url;
                        if (!extensionUrl) throw new Error("Extension HTTP URL was not prepared");
                        const launch = {
                            executable: process.execPath,
                            args: [join(cliDirectory, "preloads", "extension_bootstrap.mjs")],
                            env: {
                                COPILOT_CLI_DIST_DIR: cliDirectory,
                                EXTENSION_PATH: request.modulePath,
                                EXTENSION_HTTP_MCP_URL: extensionUrl,
                                EXTENSION_HTTP_MCP_STATUS: isSecond ? secondStatusPath : statusPath,
                                EXTENSION_HTTP_MCP_CALLS: isSecond ? secondCallsPath : callsPath,
                                ...(isSecond
                                    ? {
                                          EXTENSION_HTTP_MCP_SERVER_NAME: "secondprobe",
                                          EXTENSION_DIRECT_TOOL_NAME: "second_direct_probe",
                                          EXTENSION_HTTP_MCP_OMIT_MAP:
                                              secondJoin === "omitted" ? "1" : "0",
                                          EXTENSION_HTTP_MCP_EMPTY_MAP:
                                              secondJoin === "empty" ? "1" : "0",
                                          EXTENSION_JOIN_GATE_URL: extensionUrl.replace(
                                              /\/mcp$/,
                                              "/join-gate"
                                          ),
                                      }
                                    : {}),
                            },
                        };
                        observations.launch = {
                            request,
                            executable: launch.executable,
                            args: launch.args,
                        };
                        return { launch };
                    },
                },
            });
            const onPermissionRequest: PermissionHandler = (request, invocation) => {
                permissions.push(request);
                return approveAll(request, invocation);
            };
            const config = {
                enableConfigDiscovery: true,
                extensionSdkPath: sdkDirectory,
                disabledMcpServers: ["github-mcp-server"],
                onPermissionRequest,
            };
            observations.stage = "session creation";
            session = await client.createSession({
                ...config,
                requestExtensions: !joinAfterInitialization,
            });
            if (joinAfterInitialization) {
                observations.stage = "initial tool graph without extensions";
                await session.rpc.tools.initializeAndValidate();
                expect((await session.rpc.tools.getCurrentMetadata()).tools).not.toBeNull();
                expect(fixture.methods).toEqual([]);
                observations.stage = "same-session resume with extensions";
                session = await client.resumeSession(session.sessionId, {
                    ...config,
                    requestExtensions: true,
                });
            }
            const activeSession = session;
            observations.stage = "extension join";
            await waitForCondition(
                async () => {
                    fixture.assertHealthy();
                    const extensions = (await activeSession.rpc.extensions.list()).extensions;
                    observations.extensions = extensions;
                    const statusText = await readFile(statusPath, "utf8").catch(
                        (error: NodeJS.ErrnoException) => {
                            if (error.code === "ENOENT") return undefined;
                            throw error;
                        }
                    );
                    const status =
                        statusText === undefined
                            ? undefined
                            : joinStatus.parse(JSON.parse(statusText));
                    observations.join = status;
                    if (status?.state === "failed") throw new Error(status.error);
                    if (extensions.some((extension) => extension.status === "failed")) {
                        throw new Error(
                            `Extension launch failed: ${JSON.stringify(extensions)}; join status: ${statusText ?? "not written"}`
                        );
                    }
                    if (status === undefined) return false;
                    expect(status).toMatchObject({
                        sessionId: activeSession.sessionId,
                        sdkPath: sdkDirectory,
                        mcpServers: {
                            extensionprobe: {
                                type: "http",
                                url,
                                tools: ["http_probe"],
                                timeout: 5000,
                            },
                        },
                    });
                    return true;
                },
                {
                    timeoutMs: stepTimeoutMs,
                    timeoutMessage: "Extension did not acknowledge its join",
                }
            );
            observations.stage = "configured inventory without reconciliation";
            const configured = await activeSession.rpc.mcp.listConfigured();
            observations.configuredBeforeInitialization = configured;
            expect(configured.servers).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: serverName, enabled: true }),
                ])
            );
            if (host === "native" && !joinAfterInitialization) {
                // Observing accepted configuration must not eagerly connect a cold native graph.
                expect(fixture.methods).toEqual([]);
            }
            if (!joinAfterInitialization) {
                observations.stage = "cold tool initialization";
                await activeSession.rpc.tools.initializeAndValidate();
            }
            observations.stage = "pure offered-tool catalog";
            let metadata = (await activeSession.rpc.tools.getCurrentMetadata()).tools;
            observations.metadata = metadata;
            expect(metadata?.map((tool) => tool.name)).toContain(directToolName);
            await waitForCondition(
                async () => {
                    fixture.assertHealthy();
                    metadata = (await activeSession.rpc.tools.getCurrentMetadata()).tools;
                    observations.metadata = metadata;
                    return metadata?.some((tool) => tool.name === httpToolName) ?? false;
                },
                {
                    timeoutMs: stepTimeoutMs,
                    timeoutMessage: "Extension HTTP tool absent from the unreconciled catalog",
                }
            );
            expect(fixture.methods).toContain("initialize");
            expect(fixture.methods).toContain("tools/list");
            expect(metadata).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        name: httpToolName,
                        mcpServerName: serverName,
                        mcpToolName: "http_probe",
                    }),
                ])
            );
            const directMarker = randomUUID();
            observations.stage = "direct callback invocation";
            expect(
                await activeSession.rpc.tools.execute({
                    name: directToolName,
                    arguments: { marker: directMarker },
                    toolCallId: `direct-${directMarker}`,
                })
            ).toMatchObject({
                resultType: "success",
                textResultForLlm: `EXTENSION_DIRECT_REPLY_${directMarker}`,
            });
            expect(
                (await readFile(callsPath, "utf8"))
                    .trim()
                    .split(/\r?\n/)
                    .map((line) => JSON.parse(line))
            ).toEqual([{ marker: directMarker }]);
            expect(fixture.calls).toEqual([]);
            const httpMarker = randomUUID();
            observations.stage = "HTTP tool invocation";
            expect(
                await activeSession.rpc.tools.execute({
                    name: httpToolName,
                    arguments: { marker: httpMarker },
                    toolCallId: `http-${httpMarker}`,
                })
            ).toMatchObject({
                resultType: "success",
                textResultForLlm: expect.stringContaining(`EXTENSION_HTTP_REPLY_${httpMarker}`),
            });
            expect(fixture.calls).toEqual([{ marker: httpMarker }]);
            expect(permissions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: "mcp",
                        serverName,
                        toolName: httpToolName,
                        toolCallId: `http-${httpMarker}`,
                        readOnly: false,
                        args: { marker: httpMarker },
                    }),
                ])
            );
            if (secondFixture) {
                observations.stage = "second extension joins after first HTTP invocation";
                secondFixture.releaseJoin();
                await waitForCondition(
                    async () => {
                        secondFixture.assertHealthy();
                        const text = await readFile(secondStatusPath, "utf8").catch(
                            (error: NodeJS.ErrnoException) => {
                                if (error.code === "ENOENT") return undefined;
                                throw error;
                            }
                        );
                        if (text === undefined) return false;
                        const status = joinStatus.parse(JSON.parse(text));
                        observations.secondJoinStatus = status;
                        if (status.state === "failed") throw new Error(status.error);
                        expect(status.sessionId).toBe(activeSession.sessionId);
                        if (secondJoin !== "http") expect(status.mcpServers).toEqual({});
                        else expect(status.mcpServers.secondprobe?.url).toBe(secondUrl);
                        return true;
                    },
                    {
                        timeoutMs: stepTimeoutMs,
                        timeoutMessage: "Second extension did not acknowledge its join",
                    }
                );
                await waitForCondition(
                    async () => {
                        metadata = (await activeSession.rpc.tools.getCurrentMetadata()).tools;
                        observations.metadataAfterSecondJoin = metadata;
                        if (!metadata) return false;
                        return metadata.some((tool) => tool.name === "second_direct_probe");
                    },
                    {
                        timeoutMs: stepTimeoutMs,
                        timeoutMessage: "Second extension did not publish its direct tool",
                    }
                );
                for (const name of [directToolName, "second_direct_probe"]) {
                    const marker = randomUUID();
                    expect(
                        await activeSession.rpc.tools.execute({
                            name,
                            arguments: { marker },
                            toolCallId: `second-join-direct-${marker}`,
                        })
                    ).toMatchObject({
                        resultType: "success",
                        textResultForLlm: `EXTENSION_DIRECT_REPLY_${marker}`,
                    });
                    const recordedCalls = await readFile(
                        name === directToolName ? callsPath : secondCallsPath,
                        "utf8"
                    );
                    expect(
                        recordedCalls
                            .trim()
                            .split(/\r?\n/)
                            .map((line) => JSON.parse(line))
                            .filter((call) => call.marker === marker)
                    ).toEqual([{ marker }]);
                }
                observations.stage = "both accepted HTTP maps remain configured";
                const afterSecondJoin = await activeSession.rpc.mcp.listConfigured();
                observations.configuredAfterSecondJoin = afterSecondJoin;
                expect(afterSecondJoin.servers.map((server) => server.name)).toContain(serverName);
                if (secondJoin === "http") {
                    expect(afterSecondJoin.servers.map((server) => server.name)).toContain(
                        "secondprobe"
                    );
                }
                await activeSession.rpc.tools.initializeAndValidate();
                await waitForCondition(
                    async () => {
                        metadata = (await activeSession.rpc.tools.getCurrentMetadata()).tools;
                        observations.metadataAfterSecondJoin = metadata;
                        return (
                            metadata?.some((tool) => tool.name === httpToolName) === true &&
                            (secondJoin !== "http" ||
                                metadata.some((tool) => tool.name === "secondprobe-http_probe"))
                        );
                    },
                    {
                        timeoutMs: stepTimeoutMs,
                        timeoutMessage: "Both configured HTTP tools were not published",
                    }
                );
                expect(metadata?.map((tool) => tool.name)).toContain(httpToolName);
                for (const name of [
                    httpToolName,
                    ...(secondJoin === "http" ? ["secondprobe-http_probe"] : []),
                ]) {
                    const marker = randomUUID();
                    expect(
                        await activeSession.rpc.tools.execute({
                            name,
                            arguments: { marker },
                            toolCallId: `second-join-http-${marker}`,
                        })
                    ).toMatchObject({
                        resultType: "success",
                        textResultForLlm: expect.stringContaining(`EXTENSION_HTTP_REPLY_${marker}`),
                    });
                    expect((name === httpToolName ? fixture : secondFixture).calls).toContainEqual({
                        marker,
                    });
                }
                if (secondJoin !== "http") expect(secondFixture.methods).toEqual([]);
                if (secondJoin === "http") {
                    observations.stage = "owner still authoritatively clears HTTP configuration";
                    session = await client.resumeSession(activeSession.sessionId, {
                        mcpServers: {},
                        onPermissionRequest,
                    });
                    // Resume can return while graph reload is still in progress.
                    await session.rpc.tools.initializeAndValidate();
                    const ownerConfigured = await session.rpc.mcp.listConfigured();
                    observations.ownerConfigured = ownerConfigured;
                    expect(ownerConfigured.servers.map((server) => server.name)).not.toContain(
                        serverName
                    );
                    expect(ownerConfigured.servers.map((server) => server.name)).not.toContain(
                        "secondprobe"
                    );
                    const clearedMetadata = (await session.rpc.tools.getCurrentMetadata()).tools;
                    observations.metadataAfterOwnerClear = clearedMetadata;
                    expect(clearedMetadata).toBeDefined();
                    const clearedNames = clearedMetadata?.map((tool) => tool.name);
                    expect(clearedNames).not.toContain(httpToolName);
                    expect(clearedNames).not.toContain("secondprobe-http_probe");
                    for (const name of [httpToolName, "secondprobe-http_probe"]) {
                        const marker = randomUUID();
                        expect(
                            await session.rpc.tools.execute({
                                name,
                                arguments: { marker },
                                toolCallId: `owner-clear-${marker}`,
                            })
                        ).toMatchObject({
                            resultType: "failure",
                            textResultForLlm: expect.stringContaining("does not exist"),
                        });
                        expect(
                            (name === httpToolName ? fixture : secondFixture).calls
                        ).not.toContainEqual({ marker });
                    }
                }
            }
            fixture.assertHealthy();
            observations.stage = "disconnect";
            await session.disconnect();
            console.info(
                "Extension HTTP MCP completed:",
                JSON.stringify({
                    host,
                    joinAfterInitialization,
                    configured,
                    offeredNames: metadata?.map((tool) => tool.name),
                    methods: fixture.methods,
                    requests: fixture.requests,
                    responses: fixture.responses,
                    calls: fixture.calls,
                    permissions,
                })
            );
        }
    );
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { describe, it } from "vitest";
import { approveAll, CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createIdentityForHost, generateCA } from "../../../test/harness/certUtils.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";

// Rust covers Git retry decisions; this exercises SDK-owned credentials across RPC.
describe("Plugin Git authentication fallback", async () => {
    const { workDir, env } = await createSdkTestContext({
        copilotClientOptions: { gitHubToken: DEFAULT_GITHUB_TOKEN },
    });

    it(
        "clones and refreshes a private marketplace with the signed-in token",
        { timeout: 90_000 },
        async (ctx) => {
            const home = join(workDir, "auth-home");
            const source = join(workDir, "source");
            await mkdir(home);
            await mkdir(source);
            const configPath = join(home, "gitconfig");
            const tracePath = join(home, "git-trace.jsonl");
            await writeFile(configPath, "");
            const gitEnv = {
                ...env,
                GIT_CONFIG_GLOBAL: configPath,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_COUNT: "0",
                GIT_TERMINAL_PROMPT: "0",
                GIT_TRACE_REDACT: "0",
                GIT_TRACE2_EVENT: tracePath,
                GIT_TRACE2_ENV_VARS: "GIT_CONFIG_VALUE_1,GIT_CONFIG_VALUE_2,GIT_CONFIG_VALUE_3",
                GIT_TRACE2_CONFIG_PARAMS: "http.*.extraheader",
            };
            const git = (...args: string[]) =>
                execFileSync("git", args, { cwd: source, env: gitEnv, windowsHide: true });
            await access(
                join(
                    git("--exec-path").toString().trim(),
                    process.platform === "win32" ? "git-http-backend.exe" : "git-http-backend"
                )
            );
            git("init", "--quiet");
            git("config", "user.name", "SDK Test");
            git("config", "user.email", "sdk-test@example.com");
            await writeFile(
                join(source, "marketplace.json"),
                JSON.stringify({
                    name: "private-auth-marketplace",
                    owner: { name: "SDK Test" },
                    plugins: [],
                })
            );
            git("add", "marketplace.json");
            git("commit", "--quiet", "-m", "fixture");
            git("clone", "--quiet", "--bare", ".", "../repo.git");

            const ca = generateCA();
            const identity = createIdentityForHost("127.0.0.1", ca);
            const caPath = join(home, "ca.pem");
            await writeFile(caPath, ca.certPem);
            const authorization = `Basic ${Buffer.from(`x-access-token:${DEFAULT_GITHUB_TOKEN}`).toString("base64")}`;
            const observed: Array<string | undefined> = [];
            const failures: Error[] = [];
            const backends = new Set<ChildProcess>();
            const server = createServer(
                { key: identity.keyPem, cert: identity.certPem },
                (request, response) => {
                    observed.push(request.headers.authorization);
                    if (request.headers.authorization !== authorization) {
                        response.writeHead(401, {
                            "WWW-Authenticate": 'Basic realm="marketplace"',
                        });
                        response.end();
                        return;
                    }
                    const target = new URL(request.url!, "https://127.0.0.1");
                    const backend = spawn("git", ["http-backend"], {
                        cwd: workDir,
                        env: {
                            ...gitEnv,
                            GIT_PROJECT_ROOT: workDir,
                            GIT_HTTP_EXPORT_ALL: "1",
                            PATH_INFO: target.pathname,
                            QUERY_STRING: target.search.slice(1),
                            REQUEST_METHOD: request.method,
                            CONTENT_TYPE: request.headers["content-type"],
                            REMOTE_USER: "sdk-test",
                        },
                        windowsHide: true,
                        stdio: ["pipe", "pipe", "pipe"],
                    });
                    backends.add(backend);
                    const chunks: Buffer[] = [];
                    const stderr: Buffer[] = [];
                    backend.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
                    backend.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
                    backend.on("error", (error) => {
                        failures.push(error);
                        response.destroy(error);
                    });
                    backend.on("close", (code) => {
                        backends.delete(backend);
                        if (code !== 0) {
                            const error = new Error(
                                `git http-backend exited ${code}: ${Buffer.concat(stderr)}`
                            );
                            failures.push(error);
                            response.destroy(error);
                            return;
                        }
                        const output = Buffer.concat(chunks);
                        const boundary = output.indexOf("\r\n\r\n");
                        if (boundary < 0) {
                            const error = new Error("git http-backend returned no CGI headers");
                            failures.push(error);
                            response.destroy(error);
                            return;
                        }
                        for (const header of output
                            .subarray(0, boundary)
                            .toString()
                            .split("\r\n")) {
                            const colon = header.indexOf(":");
                            response.setHeader(
                                header.slice(0, colon),
                                header.slice(colon + 1).trim()
                            );
                        }
                        response.end(output.subarray(boundary + 4));
                    });
                    request.pipe(backend.stdin!);
                }
            );
            let client: CopilotClient | undefined;
            ctx.onTestFinished(async () => {
                try {
                    await client?.stop();
                } finally {
                    server.closeAllConnections();
                    if (server.listening) {
                        await new Promise<void>((resolve, reject) =>
                            server.close((error) => (error ? reject(error) : resolve()))
                        );
                    }
                    for (const backend of backends) {
                        backend.kill();
                    }
                }
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (address === null || typeof address === "string") {
                throw new Error("HTTPS fixture has no TCP address");
            }
            const host = `https://127.0.0.1:${address.port}`;
            await writeFile(
                configPath,
                `[http]\nsslCAInfo = ${caPath.replaceAll("\\", "/")}\nproxy =\n` +
                    // The fixture CA has no revocation service; retain certificate verification.
                    (process.platform === "win32"
                        ? "sslBackend = schannel\nschannelUseSSLCAInfo = true\nschannelCheckRevoke = false\n"
                        : "")
            );
            client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
                gitHubToken: DEFAULT_GITHUB_TOKEN,
                env: {
                    ...gitEnv,
                    GIT_SSL_CAINFO: caPath,
                    COPILOT_HOME: home,
                    COPILOT_CACHE_HOME: join(home, "cache"),
                    COPILOT_GH_HOST: host,
                    GH_HOST: "",
                    GH_CONFIG_DIR: home,
                },
                logLevel: "error",
            });
            await client.start();
            ctx.expect((await client.getAuthStatus()).host).toBe(host);
            const remote = `${host}/repo.git`;
            const added = await client.rpc.plugins.marketplaces.add({ source: remote });
            ctx.expect(added.name).toBe("private-auth-marketplace");
            const refreshed = await client.rpc.plugins.marketplaces.refresh({
                name: "private-auth-marketplace",
            });
            ctx.expect(refreshed.results).toEqual([
                { name: "private-auth-marketplace", success: true },
            ]);
            const session = await client.createSession({ onPermissionRequest: approveAll });
            try {
                const sessionRefresh = await session.rpc.plugins.marketplaces.refresh({
                    name: "private-auth-marketplace",
                });
                ctx.expect(sessionRefresh.results).toEqual([
                    { name: "private-auth-marketplace", success: true },
                ]);
            } finally {
                await session.disconnect();
            }
            ctx.expect(failures).toEqual([]);
            ctx.expect(observed[0]).toBeUndefined();
            ctx.expect(observed).toContain(authorization);
            const marketplace = (await client.rpc.plugins.marketplaces.list()).marketplaces.find(
                (entry) => entry.name === "private-auth-marketplace"
            );
            ctx.expect(marketplace?.source).toBe(`URL: ${remote}`);
            const cache = join(home, "cache", "marketplaces");
            const directories = (await readdir(cache, { withFileTypes: true })).filter((entry) =>
                entry.isDirectory()
            );
            ctx.expect(directories).toHaveLength(1);
            const persisted = await readFile(
                join(cache, directories[0].name, ".git", "config"),
                "utf8"
            );
            ctx.expect(persisted).toContain(remote);
            ctx.expect(persisted).not.toContain(DEFAULT_GITHUB_TOKEN);
            ctx.expect(persisted).not.toContain("extraheader");
            const trace = await readFile(tracePath, "utf8");
            ctx.expect(trace).not.toContain(DEFAULT_GITHUB_TOKEN);
            ctx.expect(trace).not.toContain(authorization);
        }
    );
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
    approveAll,
    CopilotClient,
    GitHubTelemetryNotification,
    RuntimeConnection,
} from "../../src/index.js";
import { resolvePreparedRuntimePath } from "../../scripts/prepare-runtime.js";
import { readDiagnosticTail } from "../../../test/harness/sdk-diagnostics.mjs";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

type HydroEnvelope = {
    data?: {
        baseData?: {
            properties?: {
                payload?: string;
            };
        };
    };
    tags?: Record<string, string>;
};

type UploadedEvent = {
    payload: Record<string, unknown>;
    userId?: string;
};

type TelemetryCollector = Awaited<ReturnType<typeof startTelemetryCollector>>;

async function startTelemetryCollector(): Promise<{
    server: Server;
    url: string;
    events: UploadedEvent[];
    errors: string[];
}> {
    const events: UploadedEvent[] = [];
    const errors: string[] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            try {
                if (request.url !== "/telemetry") {
                    throw new Error(`Unexpected telemetry path ${request.url}`);
                }
                if (request.headers["content-encoding"] !== "gzip") {
                    throw new Error(
                        `Expected gzip telemetry, got ${request.headers["content-encoding"]}`
                    );
                }
                const body = gunzipSync(Buffer.concat(chunks)).toString("utf8");
                for (const line of body.split("\n").filter(Boolean)) {
                    const envelope = JSON.parse(line) as HydroEnvelope;
                    const payload = envelope.data?.baseData?.properties?.payload;
                    if (typeof payload !== "string") {
                        throw new Error("Telemetry envelope did not contain a Hydro payload");
                    }
                    events.push({
                        payload: JSON.parse(payload) as Record<string, unknown>,
                        userId: envelope.tags?.["ai.user.id"],
                    });
                }
                response.writeHead(200).end();
            } catch (error) {
                errors.push(String(error));
                response.writeHead(400).end();
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Telemetry collector did not bind to a TCP port");
    }
    return { server, url: `http://127.0.0.1:${address.port}`, events, errors };
}

async function stopTelemetryCollector(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

async function withTelemetryCollector<T>(
    run: (collector: TelemetryCollector) => Promise<T>
): Promise<T> {
    const collector = await startTelemetryCollector();
    try {
        return await run(collector);
    } finally {
        await stopTelemetryCollector(collector.server);
    }
}

async function withTelemetryClient<T>(
    createClient: () => CopilotClient,
    run: (client: CopilotClient, stopClient: () => ReturnType<CopilotClient["stop"]>) => Promise<T>
): Promise<T> {
    const client = createClient();
    let stopPromise: ReturnType<CopilotClient["stop"]> | undefined;
    const stopClient = () => (stopPromise ??= client.stop());
    try {
        return await run(client, stopClient);
    } finally {
        if (!stopPromise) await stopClient();
    }
}

async function readTelemetryUploadDiagnostics(logDirectory: string, priorLogs: Set<string>) {
    // Project only fixed counters: native logs can contain credentials and user content.
    const patterns = {
        sandboxStateAccepted: /^Sending telemetry event: .* \(kind: sandbox_session_state\)$/,
        sessionStartAccepted: /^Sending telemetry event: .* \(kind: session_start\)$/,
        modelChangeAccepted: /^Sending telemetry event: .* \(kind: session_model_change\)$/,
        flushBatches: /^\[telemetry-queue\] Flushing \d+ events /,
        postsAccepted: /^\[telemetry-queue\] POST accepted\b/,
        postsRejected: /^\[telemetry-queue\] POST was not accepted; events dropped\b/,
        queueCreationFailures: /^\[telemetry\] failed to create telemetry queue\b/,
        workerStartupFailures: /^\[telemetry-queue\] failed to start worker runtime\b/,
        httpClientFailures:
            /^\[telemetry-queue\] (?:invalid proxy URL|failed to assemble explicit root certificates|invalid extra CA certificate|failed to build HTTP client)/,
        gzipFailures: /^\[telemetry-queue\] gzip failed\b/,
        startupBufferOverflows: /^Native startup telemetry buffer full; dropping oldest event\b/,
        eligibilityFailures: /^Unable to resolve native telemetry upload eligibility\b/,
    };
    const counts: Record<string, number> = Object.fromEntries(
        Object.keys(patterns).map((name) => [name, 0])
    );
    const files = (await readdir(logDirectory)).filter(
        (file) => file.endsWith(".log") && !priorLogs.has(file)
    );
    for (const file of files) {
        const lines = createInterface({
            input: createReadStream(join(logDirectory, file)),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            const message = /^\S+ \[(?:DEBUG|WARN|WARNING)\] \[rust:[\w:]+\] (.*)$/.exec(line)?.[1];
            if (!message) continue;
            for (const [name, pattern] of Object.entries(patterns)) {
                if (pattern.test(message)) counts[name] = (counts[name] ?? 0) + 1;
            }
        }
    }
    return { logFiles: files.length, counts };
}

// Experimental: exercises the end-to-end GitHub (hydro) telemetry forwarding
// path. The runtime forwards per-session telemetry to opted-in connections via
// the `gitHubTelemetry.event` JSON-RPC *notification*; the SDK opts in
// automatically whenever an `onGitHubTelemetry` handler is registered. Creating
// a session emits an early `session.start` hydro event, so no model round-trip
// (and therefore no recorded CAPI exchange) is needed to observe forwarding.
describe("GitHub telemetry forwarding", async () => {
    const received: GitHubTelemetryNotification[] = [];

    const { copilotClient: client } = await createSdkTestContext({
        copilotClientOptions: {
            onGitHubTelemetry: (notification) => {
                received.push(notification);
            },
        },
    });

    it(
        "forwards gitHubTelemetry.event notifications from a live session",
        { timeout: 60_000 },
        async () => {
            received.length = 0;

            const session = await client.createSession({
                onPermissionRequest: approveAll,
            });

            // The CLI forwards telemetry over the JSON-RPC connection
            // asynchronously, so wait until at least one event arrives or we
            // time out.
            await waitForCondition(() => received.length > 0, {
                timeoutMs: 30_000,
                timeoutMessage: "Timed out waiting for a gitHubTelemetry.event notification.",
            });

            expect(received.length).toBeGreaterThan(0);

            const notification = received[0];
            expect(typeof notification.sessionId).toBe("string");
            expect(notification.sessionId?.length).toBeGreaterThan(0);
            expect(typeof notification.restricted).toBe("boolean");
            expect(notification.event).toBeDefined();
            expect(typeof notification.event.kind).toBe("string");

            await session.disconnect();
        }
    );

    it("keeps telemetry ownership across disconnect and same-id recreation", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        const firstIdentity = await session.rpc.telemetry.getEngagementId();
        try {
            await session.setModel("gpt-4.1");
            await waitForCondition(
                () =>
                    received.some(
                        (notification) =>
                            notification.sessionId === session.sessionId &&
                            notification.event.kind === "session_model_change" &&
                            notification.event.properties?.engagement_id ===
                                firstIdentity.engagementId
                    ),
                { timeoutMessage: "The original pipeline did not forward its model change." }
            );
        } finally {
            await session.disconnect();
        }

        // Native race tests control delayed enrichment. This boundary test proves
        // the close/recreate path and forwarding transport retain the same ownership.
        const resumeOffset = received.length;
        const resumed = await client.createSession({
            sessionId: session.sessionId,
            model: "gpt-4.1",
            onPermissionRequest: approveAll,
        });
        try {
            const secondIdentity = await resumed.rpc.telemetry.getEngagementId();
            expect(firstIdentity.engagementId).toBeTruthy();
            expect(secondIdentity.engagementId).toBeTruthy();
            expect(secondIdentity.engagementId).not.toBe(firstIdentity.engagementId);
            await resumed.setModel("gpt-5.4");
            await waitForCondition(
                () =>
                    received
                        .slice(resumeOffset)
                        .some(
                            (notification) =>
                                notification.sessionId === resumed.sessionId &&
                                notification.event.kind === "session_model_change" &&
                                notification.event.properties?.engagement_id ===
                                    secondIdentity.engagementId
                        ),
                { timeoutMessage: "The replacement pipeline did not forward its model change." }
            );
            const afterResume = received
                .slice(resumeOffset)
                .filter((notification) => notification.sessionId === resumed.sessionId);
            expect(
                afterResume.some(
                    (notification) =>
                        notification.event.properties?.engagement_id === firstIdentity.engagementId
                )
            ).toBe(false);
        } finally {
            await resumed.disconnect();
        }
    });
});

describe("GitHub telemetry uploads", async () => {
    const nativeCliPath = await resolvePreparedRuntimePath({ option: "--print-path" });
    const nativeConnection = RuntimeConnection.forStdio({ path: nativeCliPath });
    const uploadEnvironment = {
        COPILOT_E2E_TEST_HOOKS: "1",
        COPILOT_TEST_TELEMETRY_FLUSH_INTERVAL_MS: "100",
        COPILOT_GITHUB_TELEMETRY_DISABLED: "false",
    };
    const { createClient, openAiEndpoint, env, workDir } = await createSdkTestContext({
        logLevel: "debug",
        backend: "capi",
        copilotClientOptions: {
            connection: nativeConnection,
            env: uploadEnvironment,
            gitHubToken: undefined,
            useLoggedInUser: false,
            clientInfo: { applicationName: "vscode-agent-host" },
        },
    });

    it("distinguishes native host uploads from session telemetry opt-out", async ({ expect }) => {
        const results: {
            name: string;
            sessionTelemetry: boolean;
            offline: boolean;
            disableUploads?: boolean;
            restrictedTelemetry: boolean;
            uploadedKinds: unknown[];
            hostUploads: number;
            sessionUploads: number;
            hostForwarded: number;
        }[] = [];
        for (const scenario of [
            {
                name: "enabled",
                sessionTelemetry: true,
                offline: false,
                restrictedTelemetry: false,
            },
            {
                name: "session-disabled",
                sessionTelemetry: false,
                offline: false,
                restrictedTelemetry: false,
            },
            {
                name: "offline",
                sessionTelemetry: false,
                offline: true,
                restrictedTelemetry: false,
            },
            {
                name: "host-disabled",
                sessionTelemetry: true,
                offline: false,
                disableUploads: true,
                restrictedTelemetry: true,
            },
            {
                name: "host-and-session-disabled",
                sessionTelemetry: false,
                offline: false,
                disableUploads: true,
                restrictedTelemetry: false,
            },
        ]) {
            await withTelemetryCollector(async (collector) => {
                const token = `native-process-${scenario.name}`;
                const forwarded: GitHubTelemetryNotification[] = [];
                const user = {
                    login: token,
                    id: 92000,
                    copilot_plan: "individual_pro",
                    is_staff: scenario.restrictedTelemetry,
                    restricted_telemetry: scenario.restrictedTelemetry,
                    endpoints: { api: env.COPILOT_API_URL, telemetry: collector.url },
                    analytics_tracking_id: token,
                } as const;
                await openAiEndpoint.setCopilotUserByToken(token, user);
                await withTelemetryClient(
                    () =>
                        new CopilotClient({
                            connection: nativeConnection,
                            workingDirectory: workDir,
                            gitHubToken: token,
                            useLoggedInUser: false,
                            env: {
                                ...env,
                                COPILOT_OFFLINE: String(scenario.offline),
                                COPILOT_GITHUB_TELEMETRY_DISABLED: String(
                                    scenario.disableUploads ?? false
                                ),
                            },
                            onGitHubTelemetry: (notification) => {
                                forwarded.push(notification);
                            },
                        }),
                    async (client, stopClient) => {
                        const session = await client.createSession({
                            onPermissionRequest: approveAll,
                            clientName: "vscode-agent-host",
                            enableSessionTelemetry: scenario.sessionTelemetry,
                        });
                        expect((await session.rpc.gitHubAuth.getStatus()).isAuthenticated).toBe(
                            !scenario.offline
                        );
                        if (scenario.restrictedTelemetry) {
                            await session.setModel("gpt-5.4");
                            await waitForCondition(
                                () =>
                                    forwarded.some(
                                        ({ sessionId, event, restricted }) =>
                                            sessionId === session.sessionId &&
                                            event.kind === "session_model_change" &&
                                            restricted
                                    ),
                                {
                                    timeoutMessage:
                                        "The host upload opt-out must preserve eligible restricted telemetry forwarding.",
                                }
                            );
                        }
                        const corruptId = randomUUID();
                        const directory = join(env.COPILOT_HOME, "session-state", corruptId);
                        await mkdir(directory, { recursive: true });
                        // The failed load emits a host-owned bag before any session pipeline exists.
                        await writeFile(
                            join(directory, "events.jsonl"),
                            '{"type":"user.message","data":\n'
                        );
                        await expect(
                            client.resumeSession(corruptId, {
                                onPermissionRequest: approveAll,
                                enableSessionTelemetry: scenario.sessionTelemetry,
                            })
                        ).rejects.toThrow("Session file is corrupted");
                        await session.disconnect();
                        expect(await stopClient()).toEqual([]);
                        expect(collector.errors).toEqual([]);
                        const hostEvents = collector.events.filter(
                            ({ payload }) => payload.kind === "session_resume_failure"
                        );
                        expect(hostEvents).toHaveLength(
                            scenario.offline || scenario.disableUploads ? 0 : 1
                        );
                        for (const { payload } of hostEvents) {
                            expect(payload.session_id).toBeUndefined();
                            expect(payload.properties).toMatchObject({
                                failure_kind: "log_corrupt",
                            });
                        }
                        const sessionEvents = collector.events.filter(
                            ({ payload }) => payload.session_id === session.sessionId
                        );
                        if (scenario.sessionTelemetry && !scenario.disableUploads) {
                            expect(
                                sessionEvents.some(
                                    ({ payload }) => payload.kind === "session_start"
                                )
                            ).toBe(true);
                        } else {
                            expect(sessionEvents).toEqual([]);
                        }
                        expect(
                            forwarded.filter(({ event }) => event.kind === "session_resume_failure")
                        ).toHaveLength(1);
                        if (scenario.disableUploads) {
                            expect(collector.events).toEqual([]);
                            if (scenario.sessionTelemetry) {
                                expect(
                                    forwarded.some(
                                        ({ sessionId, event }) =>
                                            sessionId === session.sessionId &&
                                            event.kind === "session_start"
                                    )
                                ).toBe(true);
                            }
                        }
                        results.push({
                            ...scenario,
                            uploadedKinds: collector.events.map(({ payload }) => payload.kind),
                            hostUploads: hostEvents.length,
                            sessionUploads: sessionEvents.length,
                            hostForwarded: forwarded.filter(
                                ({ event }) => event.kind === "session_resume_failure"
                            ).length,
                        });
                    }
                );
            });
        }
        console.info("Native process upload controls", JSON.stringify(results));
    });

    it("honors session telemetry opt-out on create and resume", async ({ expect }) => {
        await withTelemetryCollector(async (collector) => {
            const token = "native-sdk-opt-out-token";
            const sessionConfig = {
                onPermissionRequest: approveAll,
                clientName: "vscode-agent-host",
                gitHubToken: token,
            };
            const clientOptions = {
                connection: nativeConnection,
                gitHubToken: token,
                useLoggedInUser: false,
            };
            await openAiEndpoint.setCopilotUserByToken(token, {
                login: "native-sdk-opt-out",
                id: 91000,
                copilot_plan: "individual_pro",
                endpoints: { api: env.COPILOT_API_URL, telemetry: collector.url },
                analytics_tracking_id: "native-sdk-opt-out",
            });

            const { enabledSessionId, disabledSessionId, enabledEvents } =
                await withTelemetryClient(
                    () => createClient(clientOptions),
                    async (client, stopClient) => {
                        const enabled = await client.createSession({
                            ...sessionConfig,
                            enableSessionTelemetry: true,
                        });
                        const enabledSessionId = enabled.sessionId;
                        const disabled = await client.createSession({
                            ...sessionConfig,
                            enableSessionTelemetry: false,
                        });
                        const disabledSessionId = disabled.sessionId;
                        expect(disabledSessionId).not.toBe(enabledSessionId);
                        expect((await disabled.rpc.gitHubAuth.getStatus()).isAuthenticated).toBe(
                            true
                        );
                        await disabled.setModel("gpt-4.1");
                        const enabledEvents = await enabled.getEvents();
                        await client.rpc.sessions.save({ sessionId: enabledSessionId });
                        await disabled.disconnect();
                        await enabled.disconnect();
                        expect(await stopClient()).toEqual([]);
                        return { enabledSessionId, disabledSessionId, enabledEvents };
                    }
                );

            expect(
                collector.events.filter(
                    ({ payload }) =>
                        payload.session_id === enabledSessionId && payload.kind === "session_start"
                )
            ).not.toHaveLength(0);
            expect
                .soft(
                    collector.events
                        .filter(({ payload }) => payload.session_id === disabledSessionId)
                        .map(({ payload }) => payload.kind)
                )
                .toEqual([]);
            const resumeOffset = collector.events.length;

            // A no-turn session has no journal; seed its actual emitted history for cold resume.
            const sessionDirectory = join(env.COPILOT_HOME, "session-state", enabledSessionId);
            await mkdir(sessionDirectory, { recursive: true });
            await writeFile(
                join(sessionDirectory, "events.jsonl"),
                `${enabledEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
            );
            await withTelemetryClient(
                () => createClient(clientOptions),
                async (resumeClient, stopClient) => {
                    const resumed = await resumeClient.resumeSession(enabledSessionId, {
                        ...sessionConfig,
                        enableSessionTelemetry: false,
                    });
                    expect(resumed.sessionId).toBe(enabledSessionId);
                    expect((await resumed.rpc.gitHubAuth.getStatus()).isAuthenticated).toBe(true);
                    await resumed.setModel("gpt-4.1");
                    await resumed.disconnect();
                    expect(await stopClient()).toEqual([]);
                }
            );

            expect
                .soft(
                    collector.events
                        .slice(resumeOffset)
                        .filter(({ payload }) => payload.session_id === enabledSessionId)
                        .map(({ payload }) => payload.kind)
                )
                .toEqual([]);
            expect(collector.errors).toEqual([]);
            console.info("Native telemetry opt-out process uploads", {
                create: collector.events
                    .slice(0, resumeOffset)
                    .filter(({ payload }) => !payload.session_id)
                    .map(({ payload }) => payload.kind),
                resume: collector.events
                    .slice(resumeOffset)
                    .filter(({ payload }) => !payload.session_id)
                    .map(({ payload }) => payload.kind),
            });
        });
    });

    it("preserves prior resident telemetry policy when a resume attempt fails", async ({
        expect,
    }) => {
        await withTelemetryCollector(async (collector) => {
            for (const scenario of [
                { name: "disable", initial: true, requested: false },
                { name: "reenable", initial: false, requested: true },
            ]) {
                const token = `native-sdk-failed-resume-${scenario.name}-token`;
                await openAiEndpoint.setCopilotUserByToken(token, {
                    login: `native-sdk-failed-resume-${scenario.name}`,
                    id: scenario.name === "disable" ? 91001 : 91003,
                    copilot_plan: "individual_pro",
                    endpoints: { api: env.COPILOT_API_URL, telemetry: collector.url },
                    analytics_tracking_id: `native-sdk-failed-resume-${scenario.name}`,
                });

                await withTelemetryClient(
                    () =>
                        createClient({
                            connection: nativeConnection,
                            gitHubToken: token,
                            useLoggedInUser: false,
                        }),
                    async (client, stopClient) => {
                        const session = await client.createSession({
                            onPermissionRequest: approveAll,
                            enableSessionTelemetry: scenario.initial,
                        });
                        await expect(
                            client.resumeSession(session.sessionId, {
                                onPermissionRequest: approveAll,
                                enableSessionTelemetry: scenario.requested,
                                agent: "missing-resume-agent",
                            })
                        ).rejects.toThrow("missing-resume-agent");

                        await session.disconnect();
                        expect(await stopClient()).toEqual([]);
                        expect(
                            collector.events.some(
                                ({ payload }) =>
                                    payload.session_id === session.sessionId &&
                                    payload.kind === "session_shutdown"
                            )
                        ).toBe(scenario.initial);
                    }
                );
            }
            expect(collector.errors).toEqual([]);
        });
    });

    it("does not upload agent selection from a successful resident opt-out", async ({ expect }) => {
        await withTelemetryCollector(async (collector) => {
            const token = "native-sdk-resident-opt-out-token";
            const customAgents = [
                {
                    name: "resident-opt-out-agent",
                    description: "Agent used to verify resident resume telemetry opt-out.",
                    prompt: "You are a test agent.",
                },
            ];
            await openAiEndpoint.setCopilotUserByToken(token, {
                login: "native-sdk-resident-opt-out",
                id: 91002,
                copilot_plan: "individual_pro",
                endpoints: { api: env.COPILOT_API_URL, telemetry: collector.url },
                analytics_tracking_id: "native-sdk-resident-opt-out",
            });

            await withTelemetryClient(
                () =>
                    createClient({
                        connection: nativeConnection,
                        gitHubToken: token,
                        useLoggedInUser: false,
                    }),
                async (client, stopClient) => {
                    const session = await client.createSession({
                        onPermissionRequest: approveAll,
                        customAgents,
                        enableSessionTelemetry: true,
                    });
                    const resumeOffset = collector.events.length;
                    const resumed = await client.resumeSession(session.sessionId, {
                        onPermissionRequest: approveAll,
                        customAgents,
                        enableSessionTelemetry: false,
                        agent: "resident-opt-out-agent",
                    });
                    expect(
                        (await resumed.getEvents()).some(
                            (event) =>
                                event.type === "subagent.selected" &&
                                typeof event.data === "object" &&
                                event.data !== null &&
                                "agentName" in event.data &&
                                event.data.agentName === "resident-opt-out-agent"
                        )
                    ).toBe(true);
                    await resumed.disconnect();
                    expect(await stopClient()).toEqual([]);

                    expect(
                        collector.events
                            .slice(resumeOffset)
                            .filter(
                                ({ payload }) =>
                                    payload.session_id === session.sessionId &&
                                    payload.kind === "subagent_selected"
                            )
                    ).toEqual([]);
                    expect(collector.errors).toEqual([]);
                }
            );
        });
    });

    it(
        "uploads session telemetry for session tokens, token providers, and client tokens",
        { timeout: 120_000 },
        async () => {
            await withTelemetryCollector(async (collector) => {
                const credentials = [
                    {
                        name: "session token",
                        token: "native-session-static-token",
                        sessionConfig: (token: string) => ({ gitHubToken: token }),
                    },
                    {
                        name: "session token provider",
                        token: "native-session-provider-token",
                        sessionConfig: (token: string) => ({
                            gitHubTokenProvider: async () => ({
                                kind: "token" as const,
                                accessToken: token,
                                tokenType: "Bearer" as const,
                                expiresIn: 28_800,
                            }),
                        }),
                    },
                    {
                        name: "client token",
                        token: "native-client-token",
                        sessionConfig: (_token: string) => ({}),
                    },
                    {
                        name: "session token without client identity",
                        token: "native-session-without-client-identity-token",
                        clientToken: "native-client-without-copilot-user",
                        sessionConfig: (token: string) => ({ gitHubToken: token }),
                    },
                ];

                for (const [index, credential] of credentials.entries()) {
                    const trackingId = `native-sdk-upload-${index}`;
                    await openAiEndpoint.setCopilotUserByToken(credential.token, {
                        login: `native-sdk-upload-${index}`,
                        id: 90000 + index,
                        copilot_plan: "individual_pro",
                        endpoints: {
                            api: env.COPILOT_API_URL,
                            telemetry: collector.url,
                        },
                        analytics_tracking_id: trackingId,
                    });

                    const diagnosticHome = join(workDir, "telemetry-upload", String(index));
                    const logDirectory = join(diagnosticHome, "logs");
                    await mkdir(logDirectory, { recursive: true });
                    const forwarded: GitHubTelemetryNotification[] = [];
                    const priorLogs = new Set(await readdir(logDirectory));
                    await withTelemetryClient(
                        () =>
                            new CopilotClient({
                                connection: RuntimeConnection.forStdio({
                                    path: nativeCliPath,
                                    args: ["--log-dir", join(diagnosticHome, "logs")],
                                }),
                                workingDirectory: workDir,
                                env: {
                                    ...env,
                                    ...uploadEnvironment,
                                    COPILOT_RUNTIME_PROCESS_FILE_LOGGING: "1",
                                },
                                logLevel: "debug",
                                gitHubToken:
                                    credential.clientToken ??
                                    (index === 2 ? credential.token : env.GITHUB_TOKEN),
                                useLoggedInUser: false,
                                clientInfo: { applicationName: "vscode-agent-host" },
                                onGitHubTelemetry: (notification) => {
                                    forwarded.push(notification);
                                },
                            }),
                        async (client, stopClient) => {
                            await client.start();
                            expect((await client.getAuthStatus()).isAuthenticated).toBe(true);
                            const session = await client.createSession({
                                onPermissionRequest: approveAll,
                                clientName: "vscode-agent-host",
                                // Pin assignments so this credential matrix stays offline.
                                expAssignments: {
                                    Features: [],
                                    Flights: {},
                                    Configs: [],
                                    AssignmentContext: "native-telemetry-e2e",
                                },
                                ...credential.sessionConfig(credential.token),
                            });
                            const sessionId = session.sessionId;
                            const authStatus = await session.rpc.gitHubAuth.getStatus();
                            expect(authStatus.isAuthenticated).toBe(true);
                            expect(authStatus.login).toBe(`native-sdk-upload-${index}`);
                            await session.setModel("gpt-5.4");

                            await waitForCondition(
                                () =>
                                    ["session_start", "session_model_change"].every((kind) =>
                                        forwarded.some(
                                            ({ sessionId: eventSessionId, event }) =>
                                                eventSessionId === sessionId && event.kind === kind
                                        )
                                    ),
                                {
                                    timeoutMessage:
                                        `Native host did not forward session_start and session_model_change for ${credential.name} ` +
                                        `(session ${sessionId}); received ` +
                                        `${JSON.stringify(
                                            forwarded.map(
                                                ({ sessionId: eventSessionId, event }) => ({
                                                    kind: event.kind,
                                                    session_id: eventSessionId,
                                                })
                                            )
                                        )}`,
                                }
                            );
                            expect((await session.rpc.gitHubAuth.getStatus()).login).toBe(
                                `native-sdk-upload-${index}`
                            );

                            const uploadedSessionEvents = () =>
                                collector.events.filter(
                                    ({ payload }) => payload.session_id === sessionId
                                );
                            const expectedUploadKinds = [
                                "sandbox_session_state",
                                "session_start",
                                "session_model_change",
                            ];
                            const uploadState = () => ({
                                uploadedKinds: uploadedSessionEvents().map(
                                    ({ payload }) => payload.kind
                                ),
                                collectorEvents: collector.events.map(({ payload }) => [
                                    payload.kind,
                                    payload.session_id,
                                ]),
                                forwardedEvents: forwarded.map(({ sessionId: id, event }) => [
                                    event.kind,
                                    id,
                                ]),
                                collectorErrors: [...collector.errors],
                            });
                            try {
                                await expect
                                    .poll(uploadState, {
                                        timeout: 30_000,
                                        interval: 100,
                                        message:
                                            `Native host did not upload all expected session events for ${credential.name} ` +
                                            `(session ${sessionId})`,
                                    })
                                    .toMatchObject({
                                        uploadedKinds: expect.arrayContaining(expectedUploadKinds),
                                        collectorErrors: [],
                                    });
                            } catch (error) {
                                const finalUploadState = uploadState();
                                const [shutdown] = await Promise.allSettled([stopClient()]);
                                const [diagnostics, audited] = await Promise.allSettled([
                                    readTelemetryUploadDiagnostics(logDirectory, priorLogs),
                                    readDiagnosticTail(diagnosticHome),
                                ]);
                                const failures = [error];
                                if (shutdown.status === "rejected") {
                                    failures.push(shutdown.reason);
                                } else {
                                    failures.push(...shutdown.value);
                                }
                                if (diagnostics.status === "rejected") {
                                    failures.push(diagnostics.reason);
                                }
                                if (audited.status === "rejected") {
                                    failures.push(audited.reason);
                                }
                                throw new Error(
                                    `${error instanceof Error ? error.message : String(error)}\n` +
                                        `Final telemetry upload state: ${JSON.stringify(finalUploadState)}\n` +
                                        `Telemetry upload state after shutdown: ${JSON.stringify(uploadState())}\n` +
                                        `Native telemetry upload diagnostics: ${JSON.stringify(
                                            diagnostics.status === "fulfilled"
                                                ? diagnostics.value
                                                : { unavailable: true }
                                        )}\n` +
                                        `Audited native telemetry diagnostics: ${JSON.stringify(
                                            audited.status === "fulfilled"
                                                ? audited.value.filter((line) =>
                                                      line.startsWith("github telemetry ")
                                                  )
                                                : { unavailable: true }
                                        )}`,
                                    {
                                        cause: new AggregateError(
                                            failures,
                                            "Telemetry upload failed"
                                        ),
                                    }
                                );
                            }

                            for (const kind of expectedUploadKinds) {
                                const uploaded = uploadedSessionEvents().find(
                                    ({ payload }) => payload.kind === kind
                                );
                                expect(uploaded?.payload.copilot_tracking_id, kind).toBe(
                                    trackingId
                                );
                                expect(uploaded?.payload.client, kind).toMatchObject({
                                    client_name: "vscode-agent-host",
                                });
                                expect(uploaded?.userId, kind).toBe(trackingId);
                            }
                            await session.disconnect();
                            expect(await stopClient()).toEqual([]);
                        }
                    );
                }
                expect(collector.errors).toEqual([]);
            });
        }
    );
});

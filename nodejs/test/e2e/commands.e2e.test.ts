/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { CopilotClient, approveAll, RuntimeConnection } from "../../src/index.js";
import type { AssistantUsageData, CommandContext, SessionEvent } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

const KNOWN_BUILTIN_COMMANDS = ["help", "model", "compact"];

describe("Commands", async () => {
    // Use TCP mode so a second client can connect to the same CLI process
    const tcpConnectionToken = "commands-test-token";
    const ctx = await createSdkTestContext({
        useStdio: false,
        copilotClientOptions: {
            connection: RuntimeConnection.forTcp({ connectionToken: tcpConnectionToken }),
        },
    });
    const client1 = ctx.copilotClient;

    let client2: CopilotClient;
    beforeAll(async () => {
        // Trigger connection after the context has created its working directory.
        const initSession = await client1.createSession({ onPermissionRequest: approveAll });
        await initSession.disconnect();
        const { runtimePort } = client1 as unknown as { runtimePort: number };
        client2 = new CopilotClient({
            connection: RuntimeConnection.forUri(`localhost:${runtimePort}`, {
                connectionToken: tcpConnectionToken,
            }),
        });
    });

    afterAll(async () => {
        await client2?.stop();
    });

    it(
        "client receives commands.changed when another client joins with commands",
        { timeout: 20_000 },
        async () => {
            const session1 = await client1.createSession({
                onPermissionRequest: approveAll,
            });

            type CommandsChangedEvent = Extract<SessionEvent, { type: "commands.changed" }>;

            // Wait for the commands.changed event deterministically
            const commandsChangedPromise = new Promise<CommandsChangedEvent>((resolve) => {
                session1.on((event) => {
                    if (event.type === "commands.changed") resolve(event);
                });
            });

            // Client2 joins with commands
            const session2 = await client2.resumeSession(session1.sessionId, {
                onPermissionRequest: approveAll,
                commands: [
                    { name: "deploy", description: "Deploy the app", handler: async () => {} },
                ],
                suppressResumeEvent: true,
            });

            // Rely on default vitest timeout
            const commandsChanged = await commandsChangedPromise;
            expect(commandsChanged.data.commands).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "deploy", description: "Deploy the app" }),
                ])
            );

            await session2.disconnect();
        }
    );

    it("session commands list returns builtins and respects client command filter", async () => {
        const session = await client1.createSession({
            onPermissionRequest: approveAll,
            commands: [
                { name: "deploy", description: "Deploy the app", handler: async () => {} },
                { name: "rollback", description: "Rollback the app", handler: async () => {} },
            ],
        });
        try {
            let clientCommands: Awaited<ReturnType<typeof session.rpc.commands.list>> | undefined;
            await waitForCondition(
                async () => {
                    clientCommands = await session.rpc.commands.list({
                        includeBuiltins: false,
                        includeClientCommands: true,
                        includeSkills: false,
                    });
                    return (
                        clientCommands.commands.some((c) => isCommand(c, "deploy", "client")) &&
                        clientCommands.commands.some((c) => isCommand(c, "rollback", "client"))
                    );
                },
                { timeoutMessage: "Timed out waiting for client commands to be listed." }
            );

            expect(clientCommands!.commands).toContainEqual(
                expect.objectContaining({ name: "deploy", kind: "client" })
            );
            expect(clientCommands!.commands).toContainEqual(
                expect.objectContaining({ name: "rollback", kind: "client" })
            );
            expect(clientCommands!.commands.some((c) => c.kind === "builtin")).toBe(false);

            const builtinCommands = await session.rpc.commands.list({
                includeBuiltins: true,
                includeClientCommands: false,
                includeSkills: false,
            });
            expect(builtinCommands.commands.some(isKnownBuiltin)).toBe(true);
            expect(builtinCommands.commands.some((c) => c.name.toLowerCase() === "deploy")).toBe(
                false
            );
        } finally {
            await session.disconnect();
        }
    });

    it("session commands invoke known builtin returns expected result", async () => {
        const session = await client1.createSession({ onPermissionRequest: approveAll });
        try {
            const builtinCommands = await session.rpc.commands.list({
                includeBuiltins: true,
                includeClientCommands: false,
                includeSkills: false,
            });
            const commandName = KNOWN_BUILTIN_COMMANDS.find((name) =>
                builtinCommands.commands.some((c) => isCommand(c, name, "builtin"))
            );
            expect(commandName).toBeDefined();

            const result = await session.rpc.commands.invoke({ name: commandName! });
            switch (result.kind) {
                case "text":
                    expect(result.text.trim()).toBeTruthy();
                    break;
                case "select-subcommand":
                    expect(result.title.trim()).toBeTruthy();
                    expect(result.options.length).toBeGreaterThan(0);
                    break;
                case "agent-prompt":
                    expect(result.displayPrompt.trim()).toBeTruthy();
                    expect(result.prompt.trim()).toBeTruthy();
                    break;
                case "completed":
                    expect(result.message === undefined || result.message.trim().length > 0).toBe(
                        true
                    );
                    break;
                default:
                    throw new Error(`Unexpected invocation result: ${JSON.stringify(result)}`);
            }
        } finally {
            await session.disconnect();
        }
    });

    it("session commands execute runs registered command handler", async () => {
        let capturedContext: CommandContext | undefined;
        const session = await client1.createSession({
            onPermissionRequest: approveAll,
            commands: [
                {
                    name: "deploy",
                    description: "Deploy the app",
                    handler: async (ctx) => {
                        capturedContext = ctx;
                    },
                },
            ],
        });
        try {
            await waitForCondition(
                async () =>
                    (
                        await session.rpc.commands.list({
                            includeBuiltins: false,
                            includeClientCommands: true,
                            includeSkills: false,
                        })
                    ).commands.some((c) => isCommand(c, "deploy", "client")),
                { timeoutMessage: "Timed out waiting for registered command to be listed." }
            );

            const result = await session.rpc.commands.execute({
                commandName: "deploy",
                args: "production",
            });
            expect(result.error).toBeUndefined();

            await waitForCondition(() => capturedContext !== undefined, {
                timeoutMs: 10_000,
                timeoutMessage: "Timed out waiting for command handler execution.",
            });
            expect(capturedContext).toEqual({
                sessionId: session.sessionId,
                command: "/deploy production",
                commandName: "deploy",
                args: "production",
            });
        } finally {
            await session.disconnect();
        }
    });

    it("session commands enqueue accepts deterministic command", async () => {
        const session = await client1.createSession({ onPermissionRequest: approveAll });
        try {
            const result = await session.rpc.commands.enqueue({ command: "/help" });
            expect(result.queued).toBe(true);
        } finally {
            await session.disconnect();
        }
    });

    it("session commands respondToQueuedCommand returns false for unknown requestId", async () => {
        const session = await client1.createSession({ onPermissionRequest: approveAll });
        try {
            const result = await session.rpc.commands.respondToQueuedCommand({
                requestId: "missing-queued-command-request",
                result: { handled: false },
            });
            expect(result.success).toBe(false);
        } finally {
            await session.disconnect();
        }
    });

    it("session with commands creates successfully", async () => {
        const session = await client1.createSession({
            onPermissionRequest: approveAll,
            commands: [
                { name: "deploy", description: "Deploy the app", handler: async () => {} },
                { name: "rollback", handler: async () => {} },
            ],
        });

        expect(session).toBeDefined();
        expect(session.sessionId).toMatch(/^[a-f0-9-]+$/);

        await session.disconnect();
    });

    it("session with commands resumes successfully", async () => {
        const session1 = await client1.createSession({ onPermissionRequest: approveAll });
        const sessionId = session1.sessionId;

        const session2 = await client1.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            commands: [{ name: "deploy", description: "Deploy", handler: async () => {} }],
        });

        expect(session2).toBeDefined();
        expect(session2.sessionId).toBe(sessionId);

        await session2.disconnect();
    });

    it("session with no commands creates successfully", async () => {
        const session = await client1.createSession({
            onPermissionRequest: approveAll,
        });

        expect(session).toBeDefined();
        expect(session.sessionId).toMatch(/^[a-f0-9-]+$/);

        await session.disconnect();
    });
});

describe("Usage command after restart", async () => {
    // Custom-provider sessions bypass the server's Copilot billing account.
    const { createClient, openAiEndpoint, env } = await createSdkTestContext({
        backend: "capi",
    });

    it.each([
        {
            status: "partial",
            totalNanoAiu: 23_275_500_000,
            expected: "Requests: 23.28 AI Credits reported (partial)",
        },
        {
            status: "unavailable",
            totalNanoAiu: 0,
            expected: "Requests: unavailable AI Credits",
        },
    ])("reports $status checkpoint AI credits", async ({ status, totalNanoAiu, expected }) => {
        const token = `usage-command-checkpoint-token-${randomUUID()}`;
        await openAiEndpoint.setCopilotUserByToken(token, {
            login: "usage-command-user",
            copilot_plan: "individual_pro",
            token_based_billing: true,
            endpoints: { api: openAiEndpoint.url },
        });
        const originalClient = createClient({
            connection: RuntimeConnection.forStdio(),
            gitHubToken: token,
        });
        onTestFinished(async () => {
            expect(await originalClient.stop()).toHaveLength(0);
        });
        const original = await originalClient.createSession({
            onPermissionRequest: approveAll,
        });
        await original.rpc.name.set({ name: "Usage checkpoint fixture" });
        const events = await original.getEvents();
        const checkpoint: SessionEvent = {
            type: "session.usage_checkpoint",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            parentId: events.at(-1)?.id ?? null,
            data: { totalNanoAiu, totalPremiumRequests: 1 },
        };
        await originalClient.rpc.sessions.save({ sessionId: original.sessionId });
        await originalClient.rpc.sessions.close({ sessionId: original.sessionId });
        expect(await originalClient.stop()).toHaveLength(0);

        // Seed durable accounting only after the session writer has stopped.
        await writeFile(
            join(env.COPILOT_HOME, "session-state", original.sessionId, "events.jsonl"),
            `${[...events, checkpoint].map((event) => JSON.stringify(event)).join("\n")}\n`
        );
        const resumedClient = createClient({
            connection: RuntimeConnection.forStdio(),
            gitHubToken: token,
        });
        onTestFinished(async () => {
            expect(await resumedClient.stop()).toHaveLength(0);
        });
        const resumed = await resumedClient.resumeSession(original.sessionId, {
            onPermissionRequest: approveAll,
        });
        expect(await resumed.rpc.usage.getMetrics()).toMatchObject({
            totalNanoAiu: checkpoint.data.totalNanoAiu,
            totalPremiumRequestCost: checkpoint.data.totalPremiumRequests,
            aiCreditsStatus: status,
        });
        const result = await resumed.rpc.commands.invoke({ name: "usage" });
        expect(result.kind).toBe("text");
        if (result.kind !== "text") throw new Error(`Unexpected usage result: ${result.kind}`);
        expect(result.text).toContain(expected);
        expect(result.text).not.toContain("1 AI Units");
    });

    it("keeps complete credits after replaying an empty legacy shutdown", async () => {
        const token = `usage-command-empty-shutdown-token-${randomUUID()}`;
        await openAiEndpoint.setCopilotUserByToken(token, {
            login: "usage-command-user",
            copilot_plan: "individual_pro",
            token_based_billing: true,
            endpoints: { api: openAiEndpoint.url },
        });
        const originalClient = createClient({
            connection: RuntimeConnection.forStdio(),
            gitHubToken: token,
        });
        onTestFinished(async () => {
            expect(await originalClient.stop()).toHaveLength(0);
        });
        const original = await originalClient.createSession({
            onPermissionRequest: approveAll,
        });
        await original.rpc.name.set({ name: "Empty legacy shutdown fixture" });
        const events = await original.getEvents();
        const shutdown: SessionEvent = {
            type: "session.shutdown",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            parentId: events.at(-1)?.id ?? null,
            data: {
                shutdownType: "routine",
                totalPremiumRequests: 0,
                totalNanoAiu: 0,
                totalApiDurationMs: 0,
                sessionStartTime: Date.now(),
                codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
                modelMetrics: {},
            },
        };
        const legacyResume: SessionEvent = {
            type: "session.resume",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            parentId: shutdown.id,
            data: {
                eventCount: events.length + 1,
                resumeTime: new Date().toISOString(),
            },
        };
        const usage: AssistantUsageData = {
            model: "gemini-4-argon",
            modelDisplayName: "Gemini 4 Argon",
            provider: { id: "copilot", kind: "copilot", label: "GitHub Copilot" },
            initiator: "user",
            inputTokens: 79_949,
            outputTokens: 13,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 1,
            aiCreditsStatus: "complete",
            accounting: {
                sourceSessionId: original.sessionId,
                sequence: 1,
                usageId: randomUUID(),
            },
            copilotUsage: {
                totalNanoAiu: 16_002_800_000,
                tokenDetails: [
                    {
                        batchSize: 1_000_000,
                        costPerBatch: 200_000_000_000,
                        tokenCount: 79_949,
                        tokenType: "input",
                        model: "gemini-4-argon",
                    },
                    {
                        batchSize: 1_000_000,
                        costPerBatch: 10_000_000_000,
                        tokenCount: 0,
                        tokenType: "cache_read",
                        model: "gemini-4-argon",
                    },
                    {
                        batchSize: 1_000_000,
                        costPerBatch: 0,
                        tokenCount: 0,
                        tokenType: "cache_write",
                        model: "gemini-4-argon",
                    },
                    {
                        batchSize: 1_000_000,
                        costPerBatch: 1_000_000_000_000,
                        tokenCount: 13,
                        tokenType: "output",
                        model: "gemini-4-argon",
                    },
                ],
            },
        };
        const usageRecord = {
            type: "session.usage_record",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            parentId: legacyResume.id,
            data: { usage },
        };
        await originalClient.rpc.sessions.save({ sessionId: original.sessionId });
        await originalClient.rpc.sessions.close({ sessionId: original.sessionId });
        expect(await originalClient.stop()).toHaveLength(0);

        await writeFile(
            join(env.COPILOT_HOME, "session-state", original.sessionId, "events.jsonl"),
            `${[...events, shutdown, legacyResume, usageRecord]
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`
        );
        const resumedClient = createClient({
            connection: RuntimeConnection.forStdio(),
            gitHubToken: token,
        });
        onTestFinished(async () => {
            expect(await resumedClient.stop()).toHaveLength(0);
        });
        const resumed = await resumedClient.resumeSession(original.sessionId, {
            onPermissionRequest: approveAll,
        });

        const metrics = await resumed.rpc.usage.getMetrics();
        expect(metrics).toMatchObject({
            totalNanoAiu: 16_002_800_000,
            aiCreditsStatus: "complete",
        });
        expect(metrics.providerModelMetrics).toHaveLength(1);
        expect(metrics.providerModelMetrics?.[0]).toMatchObject({
            provider: { id: "copilot", kind: "copilot", label: "GitHub Copilot" },
            modelId: "gemini-4-argon",
            metrics: {
                totalNanoAiu: 16_002_800_000,
                aiCreditsStatus: "complete",
            },
        });
        const result = await resumed.rpc.commands.invoke({ name: "usage" });
        expect(result.kind).toBe("text");
        if (result.kind !== "text") throw new Error(`Unexpected usage result: ${result.kind}`);
        expect(result.text).toContain("Requests: 16 AI Credits");
        expect(result.text).not.toContain("partial");
    });
});

function isCommand(command: { name: string; kind: string }, name: string, kind: string): boolean {
    return command.name.toLowerCase() === name.toLowerCase() && command.kind === kind;
}

function isKnownBuiltin(command: { name: string; kind: string }): boolean {
    return (
        command.kind === "builtin" &&
        KNOWN_BUILTIN_COMMANDS.some((name) => name.toLowerCase() === command.name.toLowerCase())
    );
}

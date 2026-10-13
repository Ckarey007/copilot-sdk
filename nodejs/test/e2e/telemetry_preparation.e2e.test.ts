/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { z } from "zod";
import {
    type CopilotSession,
    defineTool,
    type PermissionRequestResult,
    RuntimeConnection,
    type SessionEvent,
} from "../../src/index.js";
import {
    createSdkTestContext,
    DEFAULT_GITHUB_TOKEN,
    getLegacyCliPathForTests,
} from "./harness/sdkTestContext.js";

async function telemetryWarnings(session: CopilotSession) {
    return (await session.getEvents()).filter(
        (event) => event.type === "session.warning" && event.data.warningType === "telemetry"
    );
}

describe.each(["native", "legacy"] as const)("Telemetry preparation (%s)", async (host) => {
    const policyFile = "managed-telemetry-policy.json";
    const telemetryFile = "session-telemetry.jsonl";
    const harness = await createSdkTestContext({
        copilotClientOptions: {
            connection: RuntimeConnection.forStdio(),
            env: {
                COPILOT_E2E_TEST_HOOKS: "1",
                COPILOT_TEST_MANAGED_SETTINGS_FILE_PATH: policyFile,
                COPILOT_MANAGED_SETTINGS_CACHE: "false",
            },
        },
    });

    it("keeps create and resume usable after exporter failure", async ({ expect }) => {
        await writeFile(
            join(harness.workDir, policyFile),
            JSON.stringify({
                telemetry: {
                    enabled: true,
                    endpoint: "ftp://collector.example",
                    headers: { "x-routing-key": "managed-value" },
                },
            })
        );
        const options = {
            gitHubToken: DEFAULT_GITHUB_TOKEN,
            connection: RuntimeConnection.forStdio({
                path:
                    host === "legacy"
                        ? await getLegacyCliPathForTests()
                        : process.env.COPILOT_CLI_PATH,
            }),
            telemetry: {
                exporterType: "file" as const,
                filePath: telemetryFile,
                sourceName: "ts-sdk-telemetry-e2e",
                captureContent: true,
            },
        };
        const client = harness.createClient(options);
        onTestFinished(() => client.stop());
        const receivedWarnings: SessionEvent[] = [];
        const sessionOptions = {
            enableManagedSettings: true,
            onEvent: (event: SessionEvent) => {
                if (event.type === "session.warning" && event.data.warningType === "telemetry") {
                    receivedWarnings.push(event);
                }
            },
            onPermissionRequest: (): PermissionRequestResult => ({ kind: "approve-once" }),
            tools: [
                defineTool("echo_telemetry_marker", {
                    description: "Echoes a marker string for telemetry validation.",
                    parameters: z.object({ value: z.string() }),
                    handler: ({ value }) => value,
                }),
            ],
        };
        const session = await client.createSession(sessionOptions);
        const failedSessionId = session.sessionId;
        const initialWarnings = await telemetryWarnings(session);
        expect(initialWarnings).toMatchObject([
            {
                data: {
                    warningType: "telemetry",
                    message:
                        "OpenTelemetry could not be initialized and is disabled for this session. You can continue using the session.",
                },
            },
        ]);
        const replay = {
            filePath: join(
                import.meta.dirname,
                "..",
                "..",
                "..",
                "test",
                "snapshots",
                "telemetry",
                "should_export_file_telemetry_for_sdk_interactions.yaml"
            ),
            workDir: harness.workDir,
        };
        const prompt =
            "Use the echo_telemetry_marker tool with value 'copilot-sdk-telemetry-e2e', then respond with TELEMETRY_E2E_DONE.";
        await harness.openAiEndpoint.updateConfig(replay);
        const assistant = await session.sendAndWait({ prompt }, 90_000);
        expect(assistant?.data.content).toContain("TELEMETRY_E2E_DONE");
        expect(receivedWarnings.map((event) => event.id)).toEqual(
            initialWarnings.map((event) => event.id)
        );
        await client.rpc.sessions.save({ sessionId: failedSessionId });
        const resident = await client.resumeSession(failedSessionId, sessionOptions);
        expect(resident.sessionId).toBe(failedSessionId);
        await expect(resident.rpc.model.getCurrent()).resolves.toHaveProperty("modelId");
        expect(await telemetryWarnings(resident)).toHaveLength(1);
        await resident.disconnect();
        await session.disconnect();
        expect(await client.stop()).toEqual([]);

        const resumedClient = harness.createClient(options);
        onTestFinished(() => resumedClient.stop());
        const cold = await resumedClient.resumeSession(failedSessionId, sessionOptions);
        expect(cold.sessionId).toBe(failedSessionId);
        await expect(cold.rpc.model.getCurrent()).resolves.toHaveProperty("modelId");
        expect(await telemetryWarnings(cold)).toHaveLength(1);
        await cold.disconnect();

        await writeFile(join(harness.workDir, policyFile), "{}");
        let healthyClient = resumedClient;
        if (host === "legacy") {
            // The legacy host retains its startup device policy until the next process.
            expect(await resumedClient.stop()).toEqual([]);
            healthyClient = harness.createClient(options);
            onTestFinished(() => healthyClient.stop());
        }
        const healthy = await healthyClient.createSession(sessionOptions);
        await harness.openAiEndpoint.updateConfig(replay);
        const healthyAssistant = await healthy.sendAndWait({ prompt }, 90_000);
        expect(healthyAssistant?.data.content).toContain("TELEMETRY_E2E_DONE");
        expect(await telemetryWarnings(healthy)).toEqual([]);
        await healthy.disconnect();
        expect(await healthyClient.stop()).toEqual([]);

        const entries: Array<{ attributes?: Record<string, unknown> }> = (
            await readFile(join(harness.workDir, telemetryFile), "utf8")
        )
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        expect(
            entries.some(
                (entry) => entry.attributes?.["gen_ai.conversation.id"] === healthy.sessionId
            )
        ).toBe(true);
        expect(
            entries.some(
                (entry) => entry.attributes?.["gen_ai.conversation.id"] === failedSessionId
            )
        ).toBe(false);
    });
});

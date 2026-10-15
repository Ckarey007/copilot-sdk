/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { approveAll } from "../../src/index.js";
import type { CopilotSession } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Session-scoped sandbox commands", async () => {
    const ctx = await createSdkTestContext({
        copilotClientOptions: {
            env: { COPILOT_CLI_ENABLED_FEATURE_FLAGS: "SANDBOX", COPILOT_DISABLE_KEYTAR: "1" },
        },
    });

    it("changes only the selected session without writing saved settings", async ({
        expect,
        onTestFinished,
        skip,
    }) => {
        const settingsPath = join(ctx.env.COPILOT_HOME, "settings.json");
        const settings =
            '{"sandbox":{"enabled":false,"allowBypass":false},"showTipsOnStartup":false}\n';
        await writeFile(settingsPath, settings);
        await ctx.copilotClient.start();
        const support = await ctx.copilotClient.rpc.sandbox.getHostSupport();
        if (!support.supported) {
            skip(`Sandbox is unavailable: ${JSON.stringify(support)}`);
            return;
        }
        let session: CopilotSession | undefined;
        let other: CopilotSession | undefined;
        onTestFinished(async () => {
            await Promise.all([session?.disconnect(), other?.disconnect()]);
        });
        session = await ctx.copilotClient.createSession({ onPermissionRequest: approveAll });
        other = await ctx.copilotClient.createSession({ onPermissionRequest: approveAll });
        for (const enabled of [true, false]) {
            const result = await session.rpc.commands.invoke({
                name: "sandbox",
                input: `${enabled ? "enable" : "disable"} session`,
            });
            expect(result).toMatchObject({
                kind: "text",
                sandboxSessionChange: enabled ? "restored" : "disabled",
            });
            if (result.kind !== "text")
                throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
            expect(result.runtimeSettingsChanged).not.toBe(true);
            const status = await session.rpc.commands.invoke({ name: "sandbox", input: "status" });
            if (status.kind !== "text")
                throw new Error(`Unexpected status: ${JSON.stringify(status)}`);
            expect(status.text).toContain(
                `Current sandbox status: ${enabled ? "enabled" : "disabled"}`
            );
            const otherStatus = await other.rpc.commands.invoke({
                name: "sandbox",
                input: "status",
            });
            if (otherStatus.kind !== "text")
                throw new Error(`Unexpected status: ${JSON.stringify(otherStatus)}`);
            expect(otherStatus.text).toContain("Current sandbox status: disabled");
            expect(await readFile(settingsPath, "utf8")).toBe(settings);
        }
        await expect(
            session.rpc.commands.invoke({ name: "sandbox", input: "disable session extra" })
        ).rejects.toThrow("Sandbox Command Usage");
        expect(await readFile(settingsPath, "utf8")).toBe(settings);
    });
});

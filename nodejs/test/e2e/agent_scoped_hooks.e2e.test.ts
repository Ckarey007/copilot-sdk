/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Agent-scoped hooks", async () => {
    const { copilotClient: client, workDir } = await createSdkTestContext();

    it("runs scoped commands additively and follows selection without model requests", async () => {
        const script = join(workDir, "scoped-hook.cjs");
        const log = join(workDir, "scoped-hook.log");
        await writeFile(
            script,
            `const fs = require("node:fs");
const [log, label] = process.argv.slice(2);
fs.appendFileSync(log, label + "\\n");
process.stdout.write(JSON.stringify({ handled: true, responseContent: label }));
`
        );
        let sessionHookCalls = 0;
        const scoped = (name: string) => ({
            name,
            prompt: "No model request is necessary for this test.",
            hooks: {
                userPromptSubmitted: [
                    { type: "command", exec: process.execPath, args: [script, log, name] },
                ],
            },
        });
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            customAgents: [scoped("FIRST_SCOPE"), scoped("SECOND_SCOPE")],
            hooks: {
                onUserPromptSubmitted: () => {
                    sessionHookCalls++;
                    return {
                        additionalContext: "Session hook ran.",
                        handled: true,
                        responseContent: "SESSION_ONLY",
                    };
                },
            },
        });
        try {
            const selected = await session.rpc.agent.select({ name: "FIRST_SCOPE" });
            expect(selected.agent.hooks).toBeDefined();
            expect((await session.sendAndWait({ prompt: "First request" }))?.data.content).toBe(
                "FIRST_SCOPE"
            );
            await session.rpc.agent.select({ name: "SECOND_SCOPE" });
            expect((await session.sendAndWait({ prompt: "Second request" }))?.data.content).toBe(
                "SECOND_SCOPE"
            );
            await session.rpc.agent.deselect();
            expect((await session.sendAndWait({ prompt: "Default request" }))?.data.content).toBe(
                "SESSION_ONLY"
            );
            expect(sessionHookCalls).toBe(3);
            expect(await readFile(log, "utf8")).toBe("FIRST_SCOPE\nSECOND_SCOPE\n");
        } finally {
            await session.disconnect();
        }
    });
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { expect, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const { copilotClient: client, workDir } = await createSdkTestContext();

it("reduces goal completion before idle and pauses a goal when leaving autopilot", async () => {
    const config = {
        onPermissionRequest: approveAll,
        workingDirectory: workDir,
        remoteSession: "off" as const,
    };
    const completed = await client.createSession(config);
    const goal = await completed.rpc.commands.invoke({
        name: "goal",
        input: "Call task_complete immediately with summary 'The release is ready.' Do not call other tools or perform any work.",
    });
    if (goal.kind !== "agent-prompt") throw new Error(`Unexpected goal result: ${goal.kind}`);
    await completed.sendAndWait({ prompt: goal.prompt, agentMode: "autopilot" });
    expect((await completed.rpc.autopilotObjective.getState()).state).toMatchObject({
        status: "completed",
        turnCount: 1,
    });

    const paused = await client.createSession(config);
    await paused.rpc.commands.invoke({ name: "goal", input: "Prepare another release" });
    await paused.rpc.mode.set({ mode: "autopilot" });
    await paused.rpc.mode.set({ mode: "interactive" });
    expect((await paused.rpc.autopilotObjective.getState()).state).toMatchObject({
        status: "paused",
        pauseReason: "autopilot_off",
    });
});

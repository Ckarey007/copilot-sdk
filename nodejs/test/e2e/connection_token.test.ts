/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Connection token", async () => {
    const ctx = await createSdkTestContext({
        copilotClientOptions: {
            connection: RuntimeConnection.forTcp({ connectionToken: "right-token" }),
        },
    });
    const goodClient = ctx.copilotClient;
    let wrongClient: CopilotClient;
    let noTokenClient: CopilotClient;
    beforeAll(async () => {
        await goodClient.start();
        const port = (goodClient as unknown as { runtimePort: number }).runtimePort;
        wrongClient = new CopilotClient({
            connection: RuntimeConnection.forUri(`localhost:${port}`, { connectionToken: "wrong" }),
        });
        noTokenClient = new CopilotClient({
            connection: RuntimeConnection.forUri(`localhost:${port}`),
        });
    });

    afterAll(async () => {
        await Promise.all([wrongClient?.forceStop(), noTokenClient?.forceStop()]);
    });

    it("connects with the matching token", async () => {
        await expect(goodClient.ping("hi")).resolves.toMatchObject({ message: "pong: hi" });
    });

    it("rejects a wrong token", async () => {
        await expect(wrongClient.start()).rejects.toThrow(/AUTHENTICATION_FAILED/);
    });

    it("rejects a missing token when one is required", async () => {
        await expect(noTokenClient.start()).rejects.toThrow(/AUTHENTICATION_FAILED/);
    });
});

describe("Connection token (auto-generated)", async () => {
    const { copilotClient } = await createSdkTestContext({ useStdio: false });

    it("the SDK-auto-generated UUID round-trips through the spawned CLI", async () => {
        await copilotClient.start();
        await expect(copilotClient.ping("hi")).resolves.toMatchObject({ message: "pong: hi" });
    });
});

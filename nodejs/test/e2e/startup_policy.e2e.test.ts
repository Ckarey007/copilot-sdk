/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Sandbox proxy CA policy", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("reports relevance without installation or caller config changes", async () => {
        await client.start();
        const configured = { sandboxConfig: { enabled: true, auth: { gh: true } } };
        const before = structuredClone(configured);
        expect(await client.rpc.sandbox.proxyCa.checkRelevance(configured)).toBe(true);
        expect(configured).toEqual(before);
        expect(
            await client.rpc.sandbox.proxyCa.checkRelevance({
                sandboxConfig: { enabled: false, auth: { gh: true } },
            })
        ).toBe(false);
        expect(await client.rpc.sandbox.proxyCa.checkRelevance({})).toBe(false);
    });

    it("reports installation support without an elevation prompt", async () => {
        await client.start();
        const supported = await client.rpc.sandbox.proxyCa.checkInstallationSupport();
        expect(typeof supported).toBe("boolean");
        if (process.platform !== "win32") {
            expect(supported).toBe(true);
        }
    });
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { validateContentExclusionPolicies } from "../../examples/content-exclusion.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Content-exclusion policy validation", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("runs the policy example without a session and preserves validation errors", async () => {
        await client.start();
        expect(await client.listSessions()).toEqual([]);
        expect(await validateContentExclusionPolicies(client)).toEqual({
            policies: [
                {
                    rules: [
                        {
                            paths: ["secrets/**"],
                            source: { name: "Example", type: "Organization" },
                            futureRuleField: { enabled: true },
                        },
                    ],
                    last_updated_at: "2026-10-05T12:00:00Z",
                    scope: "all",
                    futurePolicyField: { nullable: null },
                },
            ],
        });
        await expect(
            client.rpc.contentExclusion.validatePolicies({ policiesJson: "[{" })
        ).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining("Invalid JSON: "),
        });
        await expect(
            client.rpc.contentExclusion.validatePolicies({
                policiesJson: '[{"rules":[],"last_updated_at":true,"scope":"invalid"}]',
            })
        ).rejects.toMatchObject({
            code: -32602,
            message: expect.stringMatching(/0\.last_updated_at[\s\S]*0\.scope/),
        });
        expect(await client.listSessions()).toEqual([]);
    });
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { approveAll, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext, getLegacyCliPathForTests } from "./harness/sdkTestContext.js";

describe("read_memories availability", async () => {
    // The CLI-hosted session registers the experiment's ExP assignments.
    const { copilotClient: client } = await createSdkTestContext({
        copilotClientOptions: {
            connection: RuntimeConnection.forStdio({ path: await getLegacyCliPathForTests() }),
        },
    });

    it.each([
        { scenario: "unassigned", memoryEnabled: true, holdback: null, readAvailable: true },
        { scenario: "assigned control", memoryEnabled: true, holdback: false, readAvailable: true },
        { scenario: "Configs holdback", memoryEnabled: true, holdback: true, readAvailable: false },
        {
            scenario: "Flights holdback",
            memoryEnabled: true,
            holdback: "flight",
            readAvailable: false,
        },
        {
            scenario: "Memory disabled",
            memoryEnabled: false,
            holdback: false,
            readAvailable: false,
        },
    ] as const)(
        "offers read_memories in $scenario only when cloud Memory is available",
        async ({ scenario, memoryEnabled, holdback, readAvailable }) => {
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                customAgents: [
                    {
                        name: "memory-reader",
                        description: "Reads cloud memories",
                        prompt: "Read memories when requested.",
                        tools: ["read_memories"],
                    },
                ],
                agent: "memory-reader",
                memory: { enabled: memoryEnabled },
                ...(holdback === null
                    ? {}
                    : {
                          expAssignments: {
                              Features: [],
                              Flights:
                                  holdback === "flight"
                                      ? { "/default/memory_holdback_after_enabled": "true" }
                                      : {},
                              Configs:
                                  holdback === "flight"
                                      ? []
                                      : [
                                            {
                                                Id: "default",
                                                Parameters: {
                                                    memory_holdback_after_enabled: holdback,
                                                },
                                            },
                                        ],
                              AssignmentContext: "sdk-memory-read-holdback",
                          },
                      }),
            });
            try {
                await session.rpc.tools.initializeAndValidate();
                const { tools } = await session.rpc.tools.getCurrentMetadata();
                expect(tools).not.toBeNull();
                expect(
                    tools?.some((tool) => tool.name === "read_memories"),
                    JSON.stringify({ scenario, tools: tools?.map((tool) => tool.name) })
                ).toBe(readAvailable);
            } finally {
                await session.disconnect();
            }
        }
    );
});

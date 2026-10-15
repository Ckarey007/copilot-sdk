/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    approveAll,
    type CopilotExpAssignmentResponse,
    type MCPStdioServerConfig,
} from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { retry } from "./harness/sdkTestHelper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_MCP_SERVER = resolve(__dirname, "../../../test/harness/test-mcp-server.mjs");
const SEMANTIC_FACTORIAL_FLAG = "copilot_cli_semantic_code_search_factorial";

function semanticFactorialAssignment(
    cell: "eager_current" | "deferred_current" | "eager_focused" | "deferred_focused"
): CopilotExpAssignmentResponse {
    return {
        Features: [SEMANTIC_FACTORIAL_FLAG],
        Flights: { [SEMANTIC_FACTORIAL_FLAG]: cell },
        Configs: [
            {
                Id: "default",
                Parameters: { [SEMANTIC_FACTORIAL_FLAG]: cell },
            },
        ],
        AssignmentContext: `sdk-semantic-${cell}`,
    };
}

describe("create-time ExP assignments", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("selects the semantic search mode", async () => {
        for (const [mode, expected] of [
            ["absent", false],
            ["eager", true],
        ] as const) {
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                expAssignments: {
                    Features: ["copilot_cli_semantic_code_search_mode"],
                    Flights: {
                        copilot_cli_semantic_code_search_mode: mode,
                    },
                    Configs: [
                        {
                            Id: "default",
                            Parameters: {
                                copilot_cli_semantic_code_search_mode: mode,
                            },
                        },
                    ],
                    AssignmentContext: `sdk-semantic-${mode}`,
                },
            });

            try {
                await session.rpc.tools.initializeAndValidate();
                const { tools } = await session.rpc.tools.getCurrentMetadata();
                expect(tools).not.toBeNull();
                if (tools === null) {
                    throw new Error("tool metadata was not initialized");
                }
                const names = tools.map((tool) => tool.name);
                expect(names.includes("semantic_code_search")).toBe(expected);
            } finally {
                await session.disconnect();
            }
        }
    });

    it("selects every semantic search factorial cell", async () => {
        for (const [cell, focused, deferred] of [
            ["eager_current", false, false],
            ["deferred_current", false, true],
            ["eager_focused", true, false],
            ["deferred_focused", true, true],
        ] as const) {
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                expAssignments: semanticFactorialAssignment(cell),
            });

            try {
                await session.rpc.tools.initializeAndValidate();
                const semantic = ((await session.rpc.tools.getCurrentMetadata()).tools ?? []).find(
                    (tool) => tool.name === "semantic_code_search"
                );
                expect(semantic, cell).toBeDefined();
                expect(semantic?.description.startsWith("Find code by behavior"), cell).toBe(
                    focused
                );
                expect(
                    semantic?.input_schema?.properties &&
                        typeof semantic.input_schema.properties === "object" &&
                        "query" in semantic.input_schema.properties
                        ? (
                              semantic.input_schema.properties.query as {
                                  description?: string;
                              }
                          ).description?.startsWith("Ask one focused question")
                        : false,
                    cell
                ).toBe(focused);
                expect(semantic?.deferLoading, cell).toBe(deferred ? true : undefined);
            } finally {
                await session.disconnect();
            }
        }
    });

    it("drops malformed assignments and preserves a resident assignment", async () => {
        const malformed = {
            Features: [],
            Flights: "invalid",
            Configs: [],
            AssignmentContext: "malformed",
        } as unknown as CopilotExpAssignmentResponse;
        const malformedCreate = await client.createSession({
            onPermissionRequest: approveAll,
            expAssignments: malformed,
        });
        try {
            await malformedCreate.rpc.tools.initializeAndValidate();
            const { tools } = await malformedCreate.rpc.tools.getCurrentMetadata();
            expect(tools).not.toBeNull();
            if (tools === null) {
                throw new Error("tool metadata was not initialized");
            }
            expect(tools.map((tool) => tool.name)).not.toContain("semantic_code_search");
        } finally {
            await malformedCreate.disconnect();
        }

        const focusedDeferred = await client.createSession({
            onPermissionRequest: approveAll,
            expAssignments: semanticFactorialAssignment("deferred_focused"),
        });
        try {
            await focusedDeferred.rpc.tools.initializeAndValidate();
            const semantic = (
                (await focusedDeferred.rpc.tools.getCurrentMetadata()).tools ?? []
            ).find((tool) => tool.name === "semantic_code_search");
            expect(semantic?.description).toMatch(/^Find code by behavior/);
            expect(semantic?.deferLoading).toBe(true);

            const resumed = await client.resumeSession(focusedDeferred.sessionId, {
                onPermissionRequest: approveAll,
                expAssignments: malformed,
            });
            try {
                await resumed.rpc.tools.initializeAndValidate();
                const resumedSemantic = (
                    (await resumed.rpc.tools.getCurrentMetadata()).tools ?? []
                ).find((tool) => tool.name === "semantic_code_search");
                expect(resumedSemantic?.description).toBe(semantic?.description);
                expect(resumedSemantic?.input_schema).toEqual(semantic?.input_schema);
                expect(resumedSemantic?.deferLoading).toBe(true);
            } finally {
                await resumed.disconnect();
            }
        } finally {
            await focusedDeferred.disconnect();
        }
    });

    it("selects native lexical search and suppresses GitHub MCP code search", async () => {
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            expAssignments: {
                Features: ["copilot_cli_blackbird_lexical_search"],
                Flights: {
                    copilot_cli_blackbird_lexical_search: "treatment",
                },
                Configs: [
                    {
                        Id: "default",
                        Parameters: {
                            copilot_cli_blackbird_lexical_search: true,
                        },
                    },
                ],
                AssignmentContext: "sdk-lexical-treatment",
            },
            mcpServers: {
                "github-mcp-server": {
                    type: "local",
                    command: "node",
                    args: [
                        TEST_MCP_SERVER,
                        "--server-name",
                        "github-mcp-server",
                        "--tool-name",
                        "search_code",
                    ],
                    workingDirectory: dirname(TEST_MCP_SERVER),
                    tools: ["*"],
                } satisfies MCPStdioServerConfig,
            },
        });

        try {
            await retry(
                "connect GitHub MCP test server",
                async () => {
                    const servers = await session.rpc.mcp.list();
                    expect(
                        servers.servers.find((server) => server.name === "github-mcp-server")
                            ?.status
                    ).toBe("connected");
                },
                1_200
            );

            for (const operation of ["initialize first turn", "reuse catalog on second turn"]) {
                await session.rpc.tools.initializeAndValidate();
                const { tools } = await session.rpc.tools.getCurrentMetadata();
                const names = (tools ?? []).map((tool) => tool.name);
                expect(names).toContain("lexical_code_search");
                expect(
                    names,
                    `${operation}: GitHub MCP search_code must be suppressed`
                ).not.toContain("github-mcp-server-search_code");
            }
        } finally {
            await session.disconnect();
        }
    });
});

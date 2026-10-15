/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// CLI v1.0.92's session-closure watcher sent idle liveness pings to stateless MCP
// servers, causing a flood of traffic and 404s (fixed by #25149). This regression
// test keeps a real server idle for 90 seconds with no ping or keepalive traffic,
// then proves a stateless tool request still succeeds.

import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { text } from "node:stream/consumers";
import { describe, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";

const PROTOCOL_VERSION = "2026-07-28";
const OBSERVATION_MS = 90_000;
const SERVER_NAME = "stateless-no-ping";
const TOOL_NAME = "connection_check";

describe("mcp_stateless_no_ping", async () => {
    const { copilotClient: client } = await createSdkTestContext({
        copilotClientOptions: {
            env: { COPILOT_MCP_APPS: "true", MCP_APPS: "true" },
        },
    });

    it(
        "sends no ping for 90 seconds on MCP 2026-07-28 and then calls a tool",
        { timeout: 240_000 },
        async ({ expect, onTestFinished, signal }) => {
            const requests: Array<{
                httpMethod: string | undefined;
                url: string | undefined;
                method?: string;
                params?: unknown;
                protocolVersion: string | string[] | undefined;
                sessionId: string | string[] | undefined;
            }> = [];
            const fixtureErrors: unknown[] = [];
            const server = createServer((request, response) => {
                const observed: (typeof requests)[number] = {
                    httpMethod: request.method,
                    url: request.url,
                    protocolVersion: request.headers["mcp-protocol-version"],
                    sessionId: request.headers["mcp-session-id"],
                };
                requests.push(observed);
                void (async () => {
                    if (request.method !== "POST" || request.url !== "/mcp") {
                        response.writeHead(405).end();
                        return;
                    }
                    const message = JSON.parse(await text(request)) as {
                        id?: string | number;
                        method: string;
                        params?: unknown;
                    };
                    observed.method = message.method;
                    observed.params = message.params;
                    if (message.id === undefined) {
                        response.writeHead(202).end();
                        return;
                    }
                    let result: unknown;
                    switch (message.method) {
                        case "server/discover":
                            result = {
                                resultType: "complete",
                                supportedVersions: [PROTOCOL_VERSION],
                                capabilities: { tools: {} },
                                serverInfo: { name: SERVER_NAME, version: "1.0.0" },
                                ttlMs: 0,
                                cacheScope: "public",
                            };
                            break;
                        case "tools/list":
                            result = {
                                tools: [
                                    {
                                        name: TOOL_NAME,
                                        description:
                                            "Checks that the stateless server is reachable.",
                                        inputSchema: {
                                            type: "object",
                                            properties: {},
                                            additionalProperties: false,
                                        },
                                        _meta: { "ui.visibility": ["model", "app"] },
                                    },
                                ],
                            };
                            break;
                        case "tools/call":
                            result = {
                                content: [{ type: "text", text: "stateless connection alive" }],
                                isError: false,
                            };
                            break;
                    }
                    // No session header or legacy initialize/ping support: this is a
                    // stateless 2026-07-28 endpoint, not a legacy server without an ID.
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: message.id,
                            ...(result === undefined
                                ? { error: { code: -32601, message: "Method not found" } }
                                : { result }),
                        })
                    );
                })().catch((error: unknown) => {
                    fixtureErrors.push(error);
                    response.writeHead(500).end();
                });
            });
            let startingServer: Promise<void> | undefined;
            onTestFinished(async () => {
                const errors: unknown[] = [];
                try {
                    errors.push(...(await client.stop()));
                } catch (error) {
                    errors.push(error);
                }
                await Promise.allSettled(startingServer ? [startingServer] : []);
                if (server.listening) {
                    try {
                        await new Promise<void>((resolve, reject) => {
                            server.close((error) => (error ? reject(error) : resolve()));
                            server.closeAllConnections();
                        });
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length) {
                    throw new AggregateError(errors, "Failed to stop stateless MCP test resources");
                }
            });
            startingServer = new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            await startingServer;
            signal.throwIfAborted();
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("Expected a TCP address for the stateless MCP server");
            }
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                enableMcpApps: true,
                mcpServers: {
                    [SERVER_NAME]: {
                        type: "http",
                        url: `http://127.0.0.1:${address.port}/mcp`,
                        tools: ["*"],
                    },
                },
            });
            expect(session.capabilities.ui?.mcpApps).toBe(true);
            await expect
                .poll(
                    async () =>
                        (await session.rpc.mcp.list()).servers.find(
                            (entry) => entry.name === SERVER_NAME
                        )?.status,
                    { timeout: 60_000, message: "Stateless MCP server did not connect" }
                )
                .toBe("connected");
            const tools = await session.rpc.mcp.listTools({ serverName: SERVER_NAME });
            expect(tools.tools.map((tool) => tool.name)).toContain(TOOL_NAME);
            expect(requests.filter((entry) => entry.method === "server/discover")).toHaveLength(1);
            expect(requests.some((entry) => entry.method === "tools/list")).toBe(true);
            expect(
                requests.every((entry) =>
                    ["server/discover", "tools/list"].includes(entry.method ?? "")
                )
            ).toBe(true);
            const connectedRequests = requests.slice();
            const connectedAt = performance.now();

            // Poll only local observations so traffic cannot suppress idle probes.
            await waitForCondition(
                () => {
                    signal.throwIfAborted();
                    expect(fixtureErrors).toEqual([]);
                    return (
                        requests.length !== connectedRequests.length ||
                        performance.now() - connectedAt >= OBSERVATION_MS
                    );
                },
                {
                    timeoutMs: OBSERVATION_MS + 10_000,
                    timeoutMessage: "The 90-second no-traffic observation did not complete",
                }
            );
            expect(requests).toEqual(connectedRequests);
            expect(performance.now() - connectedAt).toBeGreaterThanOrEqual(OBSERVATION_MS);

            // Verify the server remains usable after the idle window.
            const result = await session.rpc.mcp.apps.callTool({
                serverName: SERVER_NAME,
                originServerName: SERVER_NAME,
                toolName: TOOL_NAME,
                arguments: {},
            });
            expect(result.content).toEqual([{ type: "text", text: "stateless connection alive" }]);
            expect(requests.slice(connectedRequests.length).map((entry) => entry.method)).toEqual([
                "tools/list",
                "tools/call",
            ]);
            expect(requests.filter((entry) => entry.method === "tools/call")).toEqual([
                expect.objectContaining({
                    httpMethod: "POST",
                    url: "/mcp",
                    method: "tools/call",
                    params: expect.objectContaining({ name: TOOL_NAME, arguments: {} }),
                    protocolVersion: PROTOCOL_VERSION,
                    sessionId: undefined,
                }),
            ]);
            for (const request of requests) {
                expect(request.protocolVersion).toBe(PROTOCOL_VERSION);
                expect(request.sessionId).toBeUndefined();
            }
            expect(fixtureErrors).toEqual([]);
        }
    );
});

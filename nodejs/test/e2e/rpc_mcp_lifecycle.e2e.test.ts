/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CopilotSession, MCPServerConfig, MCPStdioServerConfig } from "../../src/index.js";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { formatError, waitForCondition } from "./harness/sdkTestHelper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_MCP_SERVER = resolve(__dirname, "../../../test/harness/test-mcp-server.mjs");
const TEST_HARNESS_DIR = dirname(TEST_MCP_SERVER);

describe("Session-scoped MCP lifecycle RPC", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    function createTestMcpServers(...serverNames: string[]): Record<string, MCPServerConfig> {
        return Object.fromEntries(
            serverNames.map((name) => [
                name,
                {
                    type: "local",
                    command: "node",
                    args: [TEST_MCP_SERVER],
                    workingDirectory: TEST_HARNESS_DIR,
                    tools: ["*"],
                } as MCPStdioServerConfig,
            ])
        );
    }

    async function createSessionWithMcp(serverName: string): Promise<CopilotSession> {
        return client.createSession({
            onPermissionRequest: approveAll,
            mcpServers: createTestMcpServers(serverName),
        });
    }

    async function waitForMcpServerStatus(
        session: CopilotSession,
        serverName: string,
        expectedStatus = "connected"
    ): Promise<void> {
        let lastStatus = "<not listed>";
        await waitForCondition(
            async () => {
                const result = await session.rpc.mcp.list();
                const server = result.servers.find((entry) => entry.name === serverName);
                lastStatus = server?.status ?? "<not listed>";
                return server?.status === expectedStatus;
            },
            {
                timeoutMs: 60_000,
                intervalMs: 200,
                timeoutMessage: `${serverName} did not reach ${expectedStatus}; last status was ${lastStatus}`,
            }
        );
    }

    async function waitForMcpRunning(
        session: CopilotSession,
        serverName: string,
        expectedRunning: boolean
    ): Promise<void> {
        await waitForCondition(
            async () =>
                (await session.rpc.mcp.isServerRunning({ serverName })).running === expectedRunning,
            {
                timeoutMs: 60_000,
                intervalMs: 200,
                timeoutMessage: `${serverName} running=${expectedRunning}`,
            }
        );
    }

    function missingName(prefix: string): string {
        return `${prefix}-${randomUUID().replace(/-/g, "")}`;
    }

    function assertNotUnhandledMethod(message: string): void {
        expect(message.toLowerCase()).not.toContain("unhandled method");
    }

    async function offeredToolNames(session: CopilotSession): Promise<string[]> {
        await session.rpc.tools.initializeAndValidate();
        const { tools } = await session.rpc.tools.getCurrentMetadata();
        if (tools === null) {
            throw new Error("initializeAndValidate did not initialize session tools");
        }
        return tools.map((tool) => tool.name);
    }

    it("should start an ephemeral server from caller config and reuse its replacement", async () => {
        const serverName = missingName("ephemeral");
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const persistedBefore = await client.rpc.mcp.config.list();
            const initialConfig = {
                type: "stdio" as const,
                command: "node",
                args: [TEST_MCP_SERVER, "--tool-name", "ephemeral_initial"],
                cwd: TEST_HARNESS_DIR,
                excludeTools: ["ephemeral_initial"],
                disableToolCache: true,
            };
            await session.rpc.mcp.startServer({ serverName, config: initialConfig });
            expect(
                (await session.rpc.mcp.listTools({ serverName })).tools.map((tool) => tool.name)
            ).toEqual(["ephemeral_initial"]);
            expect(await offeredToolNames(session)).not.toContain(
                `${serverName}-ephemeral_initial`
            );
            expect((await session.rpc.mcp.isServerRunning({ serverName })).running).toBe(true);

            await session.rpc.mcp.restartServer({
                serverName,
                config: {
                    ...initialConfig,
                    args: [TEST_MCP_SERVER, "--tool-name", "ephemeral_replacement"],
                },
            });
            expect(await offeredToolNames(session)).toContain(
                `${serverName}-ephemeral_replacement`
            );
            await session.rpc.mcp.stopServer({ serverName });
            expect((await session.rpc.mcp.isServerRunning({ serverName })).running).toBe(false);
            await session.rpc.mcp.startServer({ serverName });
            await session.rpc.mcp.restartServer({ serverName });
            expect(
                (await session.rpc.mcp.listTools({ serverName })).tools.map((tool) => tool.name)
            ).toEqual(["ephemeral_replacement"]);
            expect(await client.rpc.mcp.config.list()).toEqual(persistedBefore);
        } finally {
            await session.disconnect();
        }
        const nextSession = await client.createSession({ onPermissionRequest: approveAll });
        try {
            expect(
                (await nextSession.rpc.mcp.listConfigured()).servers.some(
                    (server) => server.name === serverName
                )
            ).toBe(false);
        } finally {
            await nextSession.disconnect();
        }
    });

    it("should replace the registered config when restarting an installed server", async () => {
        const serverName = "rpc-lifecycle-replace-server";
        const session = await createSessionWithMcp(serverName);
        try {
            await waitForMcpServerStatus(session, serverName);
            expect(
                (await session.rpc.mcp.listTools({ serverName })).tools.map((tool) => tool.name)
            ).toEqual(["get_env"]);
            expect(await offeredToolNames(session)).toContain(`${serverName}-get_env`);
            await session.rpc.mcp.restartServer({
                serverName,
                config: {
                    type: "stdio",
                    command: "node",
                    args: [TEST_MCP_SERVER, "--tool-name", "installed_replacement"],
                    cwd: TEST_HARNESS_DIR,
                    tools: ["*"],
                    excludeTools: ["installed_replacement"],
                    disableToolCache: true,
                },
            });
            expect(
                (await session.rpc.mcp.listTools({ serverName })).tools.map((tool) => tool.name)
            ).toEqual(["installed_replacement"]);
            const offered = await offeredToolNames(session);
            expect(offered).not.toContain(`${serverName}-installed_replacement`);
            expect(offered).not.toContain(`${serverName}-get_env`);
            expect((await session.rpc.mcp.isServerRunning({ serverName })).running).toBe(true);
        } finally {
            await session.disconnect();
        }
    });

    it(
        "should list tools and report running status for connected server",
        { timeout: 120_000 },
        async () => {
            const serverName = "rpc-lifecycle-list-server";
            const session = await createSessionWithMcp(serverName);
            try {
                await waitForMcpServerStatus(session, serverName);

                const tools = await session.rpc.mcp.listTools({ serverName });
                expect(tools.tools.length).toBeGreaterThan(0);
                for (const tool of tools.tools) {
                    expect(tool.name).toBeTruthy();
                }

                expect((await session.rpc.mcp.isServerRunning({ serverName })).running).toBe(true);
                expect(
                    (
                        await session.rpc.mcp.isServerRunning({
                            serverName: missingName("missing"),
                        })
                    ).running
                ).toBe(false);
            } finally {
                await session.disconnect();
            }
        }
    );

    it("should throw when listing tools for unconnected server", { timeout: 120_000 }, async () => {
        const serverName = "rpc-lifecycle-unconnected-host";
        const session = await createSessionWithMcp(serverName);
        try {
            await waitForMcpServerStatus(session, serverName);

            await expect(
                session.rpc.mcp.listTools({ serverName: missingName("missing") })
            ).rejects.toSatisfy((error: unknown) => {
                const message = formatError(error);
                assertNotUnhandledMethod(message);
                expect(message.toLowerCase()).toContain("not connected");
                return true;
            });
        } finally {
            await session.disconnect();
        }
    });

    it("should stop running mcp server", { timeout: 180_000 }, async () => {
        const serverName = "rpc-lifecycle-stop-server";
        const session = await createSessionWithMcp(serverName);
        try {
            await waitForMcpServerStatus(session, serverName);
            expect((await session.rpc.mcp.isServerRunning({ serverName })).running).toBe(true);

            await session.rpc.mcp.stopServer({ serverName });

            await waitForMcpRunning(session, serverName, false);
        } finally {
            await session.disconnect();
        }
    });
});

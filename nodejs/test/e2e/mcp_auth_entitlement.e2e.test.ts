/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const testServer = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../test/harness/test-mcp-server.mjs"
);

describe("MCP account entitlement changes", async () => {
    const { copilotClient: client, workDir } = await createSdkTestContext();

    it("restores policy-filtered servers and revokes them when static credentials change", async ({
        expect,
    }) => {
        const serverName = "account-entitlement-probe";
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            requestExtensions: false,
            mcpServers: {
                [serverName]: {
                    type: "local",
                    command: process.execPath,
                    args: [testServer],
                    workingDirectory: dirname(testServer),
                    tools: ["*"],
                },
            },
        });
        try {
            for (const enabled of [false, true, false, true]) {
                const updated = await session.rpc.gitHubAuth.setCredentials({
                    credentials: {
                        type: "token",
                        host: "https://github.com",
                        token: "synthetic-mcp-entitlement-token",
                        copilotUser: { is_mcp_enabled: enabled },
                    },
                });
                expect(updated).toMatchObject({ success: true, copilotUserResolved: true });
                const snapshot = await session.rpc.mcp.list();
                expect(snapshot.host?.mcp3pEnabled).toBe(enabled);
                expect(snapshot.host?.filteredServers.includes(serverName)).toBe(!enabled);
                expect(await session.rpc.mcp.isServerRunning({ serverName })).toEqual({
                    running: enabled,
                });
                if (enabled) {
                    expect(
                        (await session.rpc.mcp.listTools({ serverName })).tools.map(
                            (tool) => tool.name
                        )
                    ).toEqual(["get_env"]);
                }
            }
        } finally {
            await session.disconnect();
        }
    });

    it.for(["connected", "failed"] as const)(
        "starts independent restored servers concurrently before reporting auth success with a %s peer",
        { timeout: 120_000 },
        async (peerStatus, { expect, onTestFinished }) => {
            const fixtureId = randomUUID();
            const servers = [0, 1, 2].map((index) => ({
                name: `parallel-entitlement-${index}`,
                marker: join(workDir, `${fixtureId}-${index}.marker`),
                gate: join(workDir, `${fixtureId}-${index}.gate`),
            }));
            const session = await client.createSession({
                onPermissionRequest: approveAll,
                requestExtensions: false,
                mcpServers: Object.fromEntries(
                    servers.map((server, index) => [
                        server.name,
                        {
                            type: "local",
                            command: process.execPath,
                            args: [
                                testServer,
                                "--startup-marker",
                                server.marker,
                                "--startup-gate",
                                server.gate,
                                ...(index === 1 && peerStatus === "failed"
                                    ? ["--fail-startup"]
                                    : []),
                            ],
                            workingDirectory: dirname(testServer),
                            tools: ["*"],
                        },
                    ])
                ),
            });
            const setCredentials = (enabled: boolean) =>
                session.rpc.gitHubAuth.setCredentials({
                    credentials: {
                        type: "token",
                        host: "https://github.com",
                        token: "synthetic-parallel-mcp-entitlement-token",
                        copilotUser: { is_mcp_enabled: enabled },
                    },
                });
            let restoring: ReturnType<typeof setCredentials> | undefined;
            onTestFinished(async () => {
                for (const server of servers) {
                    writeFileSync(server.gate, "release");
                }
                if (restoring) {
                    await Promise.allSettled([restoring]);
                }
                await session.disconnect();
            });

            // Cover deferred configs first, then configs removed from live servers.
            for (const starts of [1, 2]) {
                expect(await setCredentials(false)).toMatchObject({ success: true });
                const denied = await session.rpc.mcp.list();
                for (const server of servers) {
                    expect(denied.host?.filteredServers).toContain(server.name);
                    expect(
                        await session.rpc.mcp.isServerRunning({ serverName: server.name })
                    ).toEqual({
                        running: false,
                    });
                    rmSync(server.gate, { force: true });
                }

                let restorationCompleted = false;
                restoring = setCredentials(true).then((result) => {
                    restorationCompleted = true;
                    return result;
                });
                await expect
                    .poll(
                        () =>
                            servers.map((server) =>
                                existsSync(server.marker)
                                    ? readFileSync(server.marker, "utf8")
                                          .split("\n")
                                          .filter(Boolean).length
                                    : 0
                            ),
                        { timeout: 30_000 }
                    )
                    .toEqual([starts, starts, starts]);
                expect(restorationCompleted).toBe(false);
                for (const server of servers) {
                    writeFileSync(server.gate, "release");
                }
                expect(await restoring).toMatchObject({ success: true, copilotUserResolved: true });

                const restored = await session.rpc.mcp.list();
                expect(restored.host?.mcp3pEnabled).toBe(true);
                for (const [index, server] of servers.entries()) {
                    const connected = index !== 1 || peerStatus === "connected";
                    expect(restored.host?.filteredServers).not.toContain(server.name);
                    expect(
                        await session.rpc.mcp.isServerRunning({ serverName: server.name })
                    ).toEqual({
                        running: connected,
                    });
                    if (connected) {
                        expect(
                            (
                                await session.rpc.mcp.listTools({ serverName: server.name })
                            ).tools.map((tool) => tool.name)
                        ).toEqual(["get_env"]);
                    } else {
                        expect(
                            restored.servers.find((entry) => entry.name === server.name)?.status
                        ).toBe("failed");
                    }
                }
            }
            expect(await setCredentials(false)).toMatchObject({ success: true });
            for (const server of servers) {
                expect(await session.rpc.mcp.isServerRunning({ serverName: server.name })).toEqual({
                    running: false,
                });
            }
        }
    );
});

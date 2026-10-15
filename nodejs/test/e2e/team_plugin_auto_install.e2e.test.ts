/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext, isInProcessTransport } from "./harness/sdkTestContext.js";

const MARKETPLACE_NAME = "team-auto-install-market";
const PLUGIN_NAME = "team-auto-install-plugin";
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const SKILL_NAME = "team-auto-install-skill";

async function startGitHubApi(token: string, capiUrl: string) {
    const requests: string[] = [];
    const teamRequests: Array<{ authorization?: string; ifNoneMatch?: string }> = [];
    const server: Server = createServer((request, response) => {
        const url = request.url ?? "/";
        requests.push(url);
        if (request.method === "GET" && url.startsWith("/copilot_internal/user")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    login: "team-plugin-user",
                    copilot_plan: "individual_pro",
                    endpoints: { api: capiUrl },
                })
            );
            return;
        }
        if (request.method === "GET" && url.startsWith("/copilot_internal/team_customizations")) {
            teamRequests.push({
                authorization:
                    typeof request.headers.authorization === "string"
                        ? request.headers.authorization
                        : undefined,
                ifNoneMatch:
                    typeof request.headers["if-none-match"] === "string"
                        ? request.headers["if-none-match"]
                        : undefined,
            });
            response.writeHead(200, {
                "cache-control": "private, max-age=3600",
                "content-type": "application/json",
                etag: '"team-plugins-v1"',
            });
            response.end(
                JSON.stringify({
                    pluginAssignments: {
                        [PLUGIN_SPEC]: { state: "defaultEnabled" },
                    },
                })
            );
            return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Not Found" }));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        teamRequests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
        token,
    };
}

describe("Team plugin auto-install", async () => {
    const { env, workDir } = await createSdkTestContext();

    it.skipIf(isInProcessTransport)(
        "installs and activates a team-assigned default through the shared host",
        { timeout: 120_000 },
        async () => {
            const marketplaceDir = join(workDir, "team-marketplace");
            const pluginDir = join(marketplaceDir, "plugins", PLUGIN_NAME);
            mkdirSync(join(marketplaceDir, ".github", "plugin"), { recursive: true });
            mkdirSync(join(pluginDir, "skills", SKILL_NAME), { recursive: true });
            writeFileSync(
                join(marketplaceDir, ".github", "plugin", "marketplace.json"),
                JSON.stringify({
                    name: MARKETPLACE_NAME,
                    owner: { name: "SDK E2E" },
                    plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}` }],
                })
            );
            writeFileSync(
                join(pluginDir, "plugin.json"),
                JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0" })
            );
            writeFileSync(
                join(pluginDir, "skills", SKILL_NAME, "SKILL.md"),
                `---\nname: ${SKILL_NAME}\ndescription: Team auto-install verification skill.\n---\n`
            );
            execFileSync("git", ["init", "--initial-branch=main"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.name", "SDK E2E"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.email", "sdk-e2e@example.invalid"], {
                cwd: marketplaceDir,
            });
            execFileSync("git", ["add", "."], { cwd: marketplaceDir });
            execFileSync("git", ["commit", "-m", "Publish team plugin"], { cwd: marketplaceDir });

            const home = env.COPILOT_HOME!;
            mkdirSync(home, { recursive: true });
            writeFileSync(
                join(home, "settings.json"),
                JSON.stringify({
                    extraKnownMarketplaces: {
                        [MARKETPLACE_NAME]: {
                            source: {
                                source: "git",
                                url: pathToFileURL(marketplaceDir).toString(),
                                ref: "main",
                            },
                        },
                    },
                })
            );

            const token = "team-plugin-token";
            const gitHubApi = await startGitHubApi(token, env.COPILOT_API_URL);
            let client: CopilotClient | undefined;
            onTestFinished(async () => {
                await client?.stop();
                await gitHubApi.close();
            });
            client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({
                    path: process.env.COPILOT_CLI_PATH,
                }),
                env: {
                    ...env,
                    COPILOT_DEBUG_GITHUB_API_URL: gitHubApi.url,
                    COPILOT_HOME: home,
                    COPILOT_OFFLINE: "false",
                    GH_CONFIG_DIR: home,
                    XDG_CONFIG_HOME: home,
                    XDG_STATE_HOME: home,
                },
                logLevel: "error",
            });
            await client.start();

            const session = await client.createSession({
                enableConfigDiscovery: true,
                gitHubToken: token,
            });
            try {
                await expect(session.rpc.gitHubAuth.getStatus()).resolves.toMatchObject({
                    isAuthenticated: true,
                    login: "team-plugin-user",
                });
                expect(
                    gitHubApi.requests.some((request) =>
                        request.startsWith("/copilot_internal/user")
                    )
                ).toBe(true);
                await vi.waitFor(() => expect(gitHubApi.teamRequests.length).toBeGreaterThan(0), {
                    timeout: 10_000,
                });
                await vi.waitFor(
                    async () => {
                        const installed = (await client!.rpc.plugins.list()).plugins.find(
                            (plugin) =>
                                plugin.name === PLUGIN_NAME &&
                                plugin.marketplace === MARKETPLACE_NAME
                        );
                        expect(installed).toMatchObject({ enabled: false });
                    },
                    { timeout: 45_000 }
                );
                await vi.waitFor(
                    async () => {
                        await session.rpc.skills.ensureLoaded();
                        const skills = await session.rpc.skills.list();
                        expect(
                            skills.skills.find((skill) => skill.name === SKILL_NAME)?.enabled
                        ).toBe(true);
                    },
                    { timeout: 45_000 }
                );
                expect(gitHubApi.teamRequests.length).toBeLessThanOrEqual(2);
                for (const request of gitHubApi.teamRequests) {
                    expect(request.authorization).toMatch(
                        new RegExp(`^(?:Bearer|token) ${token}$`, "i")
                    );
                    expect(request.ifNoneMatch).toBeUndefined();
                }
            } finally {
                await session.disconnect();
            }
        }
    );
});

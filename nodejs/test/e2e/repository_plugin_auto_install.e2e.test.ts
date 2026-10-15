/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext, isInProcessTransport } from "./harness/sdkTestContext.js";

const MARKETPLACE_NAME = "repository-auto-install-market";
const PLUGIN_NAME = "repository-auto-install-plugin";
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const SKILL_NAME = "repository-auto-install-skill";

describe("Repository plugin auto-install", async () => {
    const { env, workDir } = await createSdkTestContext();

    it.skipIf(isInProcessTransport)(
        "installs trusted repository requirements through the shared host",
        { timeout: 120_000 },
        async () => {
            execFileSync("git", ["init", "--initial-branch=main"], { cwd: workDir });

            const marketplaceDir = join(workDir, "marketplace");
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
                `---\nname: ${SKILL_NAME}\ndescription: Repository auto-install verification skill.\n---\n`
            );
            execFileSync("git", ["init", "--initial-branch=main"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.name", "SDK E2E"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.email", "sdk-e2e@example.invalid"], {
                cwd: marketplaceDir,
            });
            execFileSync("git", ["add", "."], { cwd: marketplaceDir });
            execFileSync("git", ["commit", "-m", "Publish repository plugin"], {
                cwd: marketplaceDir,
            });

            const repoSettingsDir = join(workDir, ".github", "copilot");
            mkdirSync(repoSettingsDir, { recursive: true });
            writeFileSync(
                join(repoSettingsDir, "settings.json"),
                JSON.stringify({
                    enabledPlugins: { [PLUGIN_SPEC]: true },
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

            const home = join(workDir, "sdk-home");
            mkdirSync(home, { recursive: true });
            const client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({
                    path: process.env.COPILOT_CLI_PATH,
                }),
                env: {
                    ...env,
                    COPILOT_HOME: home,
                    GH_CONFIG_DIR: home,
                    XDG_CONFIG_HOME: home,
                    XDG_STATE_HOME: home,
                },
            });
            onTestFinished(() => client.stop());
            await client.start();

            const bootstrap = await client.createSession({ enableConfigDiscovery: false });
            try {
                await bootstrap.rpc.permissions.folderTrust.addTrusted({ path: workDir });
            } finally {
                await bootstrap.disconnect();
            }

            const session = await client.createSession({ enableConfigDiscovery: true });
            try {
                await vi.waitFor(
                    async () => {
                        const installed = (await client.rpc.plugins.list()).plugins.find(
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
            } finally {
                await session.disconnect();
            }
        }
    );
});

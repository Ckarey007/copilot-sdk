/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext, isInProcessTransport } from "./harness/sdkTestContext.js";

const MARKETPLACE_NAME = "managed-live-market";
const PLUGIN_NAME = "managed-live-plugin";
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const SKILL_NAME = "managed-live-skill";

describe("Managed directory marketplace", async () => {
    const { env, workDir } = await createSdkTestContext();

    it.skipIf(isInProcessTransport)(
        "activates a late managed directory plugin live without copying it",
        { timeout: 120_000 },
        async () => {
            const marketplaceDir = join(workDir, "managed-live-marketplace");
            const pluginDir = join(marketplaceDir, "plugins", PLUGIN_NAME);
            const skillDir = join(pluginDir, "skills", SKILL_NAME);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(
                join(marketplaceDir, "marketplace.json"),
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
                join(skillDir, "SKILL.md"),
                [
                    "---",
                    `name: ${SKILL_NAME}`,
                    "description: Skill from a managed directory marketplace.",
                    "---",
                    "",
                    "Managed live skill.",
                ].join("\n")
            );

            // The policy starts without the marketplace so the session resolves
            // plugins first, as it does when a Policy Helper answers late.
            const policyPath = join(workDir, "managed-live-policy.json");
            writeFileSync(
                policyPath,
                JSON.stringify({ permissions: { deny: ["Shell(managed-live-placeholder *)"] } })
            );

            const home = join(workDir, "managed-live-home");
            mkdirSync(home, { recursive: true });
            const client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
                useLoggedInUser: false,
                gitHubToken: env.GITHUB_TOKEN,
                env: {
                    ...env,
                    COPILOT_HOME: home,
                    GH_CONFIG_DIR: home,
                    XDG_CONFIG_HOME: home,
                    XDG_STATE_HOME: home,
                    COPILOT_E2E_TEST_HOOKS: "1",
                    COPILOT_TEST_MANAGED_SETTINGS_FILE_PATH: policyPath,
                    COPILOT_TEST_MANAGED_SETTINGS_REFRESH_INTERVAL_MS: "1000",
                },
            });
            onTestFinished(() => client.stop());
            await client.start();

            const observedEventTypes: string[] = [];
            // Directory marketplace plugins load through the ambient live tier,
            // which hosts such as VS Code enable with config discovery.
            const session = await client.createSession({
                enableConfigDiscovery: true,
                requestExtensions: false,
                enableManagedSettings: true,
                onEvent: (event) => observedEventTypes.push(event.type),
            });
            try {
                await vi.waitFor(
                    () => expect(observedEventTypes).toContain("session.managed_settings_resolved"),
                    { timeout: 10_000 }
                );
                await session.rpc.skills.ensureLoaded();
                expect(skillNames(await session.rpc.skills.list())).not.toContain(SKILL_NAME);

                writeFileSync(
                    policyPath,
                    JSON.stringify({
                        extraKnownMarketplaces: {
                            [MARKETPLACE_NAME]: {
                                source: { source: "directory", path: marketplaceDir },
                            },
                        },
                        enabledPlugins: { [PLUGIN_SPEC]: true },
                    })
                );
                await vi.waitFor(
                    async () =>
                        expect((await session.rpc.managedSettings.get()).settings).toMatchObject({
                            enabledPlugins: { [PLUGIN_SPEC]: true },
                        }),
                    { timeout: 10_000 }
                );

                await vi.waitFor(
                    async () =>
                        expect(skillNames(await session.rpc.skills.list())).toContain(SKILL_NAME),
                    { timeout: 45_000 }
                );
                // Config discovery creates an empty installed-plugins root at startup.
                const installedPluginsDir = join(home, "installed-plugins");
                expect(
                    existsSync(installedPluginsDir) ? readdirSync(installedPluginsDir) : []
                ).toEqual([]);
                const configPath = join(home, "config.json");
                if (existsSync(configPath)) {
                    const config = JSON.parse(
                        readFileSync(configPath, "utf8").replace(/^\/\/.*$/gmu, "")
                    ) as { installedPlugins?: { name: string }[] };
                    expect(config.installedPlugins ?? []).not.toContainEqual(
                        expect.objectContaining({ name: PLUGIN_NAME })
                    );
                }
            } finally {
                await session.disconnect();
            }
        }
    );
});

function skillNames(result: { skills: { name: string }[] }): string[] {
    return result.skills.map((skill) => skill.name.split(":").at(-1) ?? skill.name);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CopilotClient, RuntimeConnection, type SessionEvent } from "../../src/index.js";
import { createSdkTestContext, isInProcessTransport } from "./harness/sdkTestContext.js";

const MARKETPLACE_NAME = "managed-progress-market";
const PLUGIN_NAME = "managed-progress-plugin";
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

type ManagedPluginProgressEvent = Extract<
    SessionEvent,
    { type: "session.managed_plugin_progress" }
>;

describe("Managed plugin progress", async () => {
    const { env, workDir } = await createSdkTestContext();

    it.skipIf(isInProcessTransport)(
        "emits presentation-neutral completion after installing required plugins",
        { timeout: 120_000 },
        async () => {
            const marketplaceDir = join(workDir, "managed-progress-marketplace");
            const pluginDir = join(marketplaceDir, "plugins", PLUGIN_NAME);
            const marketplaceManifest = join(
                marketplaceDir,
                ".github",
                "plugin",
                "marketplace.json"
            );
            mkdirSync(join(marketplaceDir, ".github", "plugin"), { recursive: true });
            mkdirSync(pluginDir, { recursive: true });
            writeFileSync(
                marketplaceManifest,
                JSON.stringify({
                    name: MARKETPLACE_NAME,
                    owner: { name: "SDK E2E" },
                    plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}` }],
                })
            );
            writeFileSync(
                join(pluginDir, "plugin.json"),
                JSON.stringify({
                    name: PLUGIN_NAME,
                    version: "1.0.0",
                })
            );
            execFileSync("git", ["init", "--initial-branch=main"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.name", "SDK E2E"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.email", "sdk-e2e@example.invalid"], {
                cwd: marketplaceDir,
            });
            execFileSync("git", ["add", "."], { cwd: marketplaceDir });
            execFileSync("git", ["commit", "-m", "Publish managed plugin"], {
                cwd: marketplaceDir,
            });

            const policyPath = join(workDir, "managed-progress-policy.json");
            const managedPluginPolicy = {
                extraKnownMarketplaces: {
                    [MARKETPLACE_NAME]: {
                        source: {
                            source: "git",
                            url: pathToFileURL(marketplaceDir).toString(),
                            ref: "main",
                        },
                    },
                },
                enabledPlugins: { [PLUGIN_SPEC]: true },
            };
            writeFileSync(
                policyPath,
                JSON.stringify({
                    permissions: {
                        deny: ["Shell(managed-progress-empty-policy *)"],
                    },
                })
            );

            const home = join(workDir, "managed-progress-home");
            mkdirSync(home, { recursive: true });
            const client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({
                    path: process.env.COPILOT_CLI_PATH,
                }),
                useLoggedInUser: false,
                gitHubToken: env.GITHUB_TOKEN,
                env: {
                    ...env,
                    COPILOT_HOME: home,
                    GH_CONFIG_DIR: home,
                    XDG_CONFIG_HOME: home,
                    XDG_STATE_HOME: home,
                    GH_TOKEN: "",
                    GITHUB_TOKEN: "",
                    COPILOT_GITHUB_TOKEN: "",
                    GITHUB_COPILOT_API_TOKEN: "",
                    COPILOT_HMAC_KEY: "",
                    CAPI_HMAC_KEY: "",
                    COPILOT_E2E_TEST_HOOKS: "1",
                    COPILOT_TEST_MANAGED_SETTINGS_FILE_PATH: policyPath,
                    COPILOT_TEST_MANAGED_SETTINGS_REFRESH_INTERVAL_MS: "1000",
                },
            });
            onTestFinished(() => client.stop());
            await client.start();

            const observedEventTypes: string[] = [];
            const progress: ManagedPluginProgressEvent[] = [];
            const session = await client.createSession({
                enableManagedSettings: true,
                onEvent: (event) => {
                    observedEventTypes.push(event.type);
                    if (event.type === "session.managed_plugin_progress") {
                        progress.push(event);
                    }
                },
            });
            try {
                const managedSettings = await session.rpc.managedSettings.get();
                expect(managedSettings.settings?.enabledPlugins).toBeUndefined();
                await vi.waitFor(
                    () => expect(observedEventTypes).toContain("session.managed_settings_resolved"),
                    { timeout: 10_000 }
                );
                await session.rpc.agent.list();
                await new Promise((resolve) => setTimeout(resolve, 250));
                expect(progress).toEqual([]);

                writeFileSync(policyPath, JSON.stringify(managedPluginPolicy));
                await vi.waitFor(
                    async () =>
                        expect((await session.rpc.managedSettings.get()).settings).toMatchObject({
                            enabledPlugins: { [PLUGIN_SPEC]: true },
                        }),
                    { timeout: 10_000 }
                );
                await vi.waitFor(
                    () =>
                        expect(
                            progress.at(-1)?.data,
                            `Observed event types: ${observedEventTypes.join(", ")}`
                        ).toEqual({ phase: "complete", pluginSpecs: [] }),
                    { timeout: 45_000 }
                );

                const installed = (await client.rpc.plugins.list()).plugins.find(
                    (plugin) =>
                        plugin.name === PLUGIN_NAME && plugin.marketplace === MARKETPLACE_NAME
                );
                expect(installed).toMatchObject({ enabled: false });
                expect(progress.some((event) => event.data.phase === "updating")).toBe(false);

                const persisted: {
                    installedPlugins: {
                        name: string;
                        marketplace: string;
                        cache_path?: string;
                    }[];
                } = JSON.parse(
                    readFileSync(join(home, "config.json"), "utf8").replace(/^\/\/.*$/gmu, "")
                );
                const persistedPlugin = persisted.installedPlugins.find(
                    (plugin) =>
                        plugin.name === PLUGIN_NAME && plugin.marketplace === MARKETPLACE_NAME
                );
                expect(persistedPlugin?.cache_path).toEqual(expect.any(String));
                if (!persistedPlugin?.cache_path) {
                    throw new Error("Managed plugin record has no cache_path.");
                }
                const installedPluginDir = persistedPlugin.cache_path;
                expect(existsSync(join(installedPluginDir, "plugin.json"))).toBe(true);
                rmSync(installedPluginDir, { recursive: true, force: true });
                const installProgressBefore = progress.filter(
                    (event) => event.data.phase === "installing"
                ).length;
                await vi.waitFor(
                    () => expect(existsSync(join(installedPluginDir, "plugin.json"))).toBe(true),
                    { timeout: 45_000 }
                );
                expect(
                    progress.filter((event) => event.data.phase === "installing").length
                ).toBeGreaterThan(installProgressBefore);

                const progressBeforeUpdate = progress.length;
                writeFileSync(
                    join(pluginDir, "plugin.json"),
                    JSON.stringify({
                        name: PLUGIN_NAME,
                        version: "2.0.0",
                    })
                );
                execFileSync("git", ["add", "."], { cwd: marketplaceDir });
                execFileSync("git", ["commit", "-m", "Publish managed plugin v2"], {
                    cwd: marketplaceDir,
                });
                const resolvedBefore = observedEventTypes.filter(
                    (type) => type === "session.managed_settings_resolved"
                ).length;
                await vi.waitFor(
                    () =>
                        expect(
                            observedEventTypes.filter(
                                (type) => type === "session.managed_settings_resolved"
                            ).length
                        ).toBeGreaterThan(resolvedBefore),
                    { timeout: 10_000 }
                );
                await vi.waitFor(
                    () =>
                        expect(
                            progress
                                .slice(progressBeforeUpdate)
                                .some((event) => event.data.phase === "updating")
                        ).toBe(true),
                    { timeout: 45_000 }
                );
                await session.rpc.agent.list();
                await vi.waitFor(
                    () =>
                        expect(progress.at(-1)?.data).toEqual({
                            phase: "complete",
                            pluginSpecs: [],
                        }),
                    { timeout: 45_000 }
                );
                const updateProgress = progress.slice(progressBeforeUpdate);
                expect(
                    updateProgress.find((event) => event.data.phase === "updating")?.data
                ).toEqual({
                    phase: "updating",
                    pluginSpecs: [PLUGIN_SPEC],
                });
                expect(updateProgress.at(-1)?.data).toEqual({
                    phase: "complete",
                    pluginSpecs: [],
                });
                const updated = (await client.rpc.plugins.list()).plugins.find(
                    (plugin) =>
                        plugin.name === PLUGIN_NAME && plugin.marketplace === MARKETPLACE_NAME
                );
                expect(updated).toMatchObject({ enabled: false, version: "2.0.0" });

                const progressBeforeUnrelatedChange = progress.length;
                writeFileSync(join(marketplaceDir, "README.md"), "Unrelated marketplace change.");
                execFileSync("git", ["add", "."], { cwd: marketplaceDir });
                execFileSync("git", ["commit", "-m", "Publish unrelated marketplace change"], {
                    cwd: marketplaceDir,
                });
                const resolvedBeforeUnrelatedChange = observedEventTypes.filter(
                    (type) => type === "session.managed_settings_resolved"
                ).length;
                await vi.waitFor(
                    () =>
                        expect(
                            observedEventTypes.filter(
                                (type) => type === "session.managed_settings_resolved"
                            ).length
                        ).toBeGreaterThan(resolvedBeforeUnrelatedChange),
                    { timeout: 10_000 }
                );
                await session.rpc.agent.list();
                expect(
                    progress
                        .slice(progressBeforeUnrelatedChange)
                        .some((event) => event.data.phase === "updating")
                ).toBe(false);
            } finally {
                await session.disconnect();
            }
        }
    );

    it.skipIf(isInProcessTransport)(
        "warns and continues when a required plugin cannot be installed",
        { timeout: 60_000 },
        async () => {
            const missingSpec = "missing-managed-plugin@missing-managed-market";
            const policyPath = join(workDir, "missing-managed-plugin-policy.json");
            writeFileSync(
                policyPath,
                JSON.stringify({
                    extraKnownMarketplaces: {
                        "missing-managed-market": {
                            source: {
                                source: "git",
                                url: pathToFileURL(join(workDir, "missing-marketplace")).toString(),
                                ref: "main",
                            },
                        },
                    },
                    enabledPlugins: { [missingSpec]: true },
                    forceRemoteSettingsRefresh: true,
                })
            );

            const home = join(workDir, "missing-managed-plugin-home");
            mkdirSync(home, { recursive: true });
            const client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({
                    path: process.env.COPILOT_CLI_PATH,
                }),
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
                },
            });
            onTestFinished(() => client.stop());
            await client.start();

            const warnings: Extract<SessionEvent, { type: "session.warning" }>[] = [];
            const progress: ManagedPluginProgressEvent[] = [];
            const session = await client.createSession({
                enableManagedSettings: true,
                onEvent: (event) => {
                    if (event.type === "session.warning") {
                        warnings.push(event);
                    } else if (event.type === "session.managed_plugin_progress") {
                        progress.push(event);
                    }
                },
            });
            try {
                await expect(session.rpc.agent.list()).resolves.toBeDefined();
                await vi.waitFor(
                    () =>
                        expect(warnings).toContainEqual(
                            expect.objectContaining({
                                data: expect.objectContaining({
                                    warningType: "managed_plugins",
                                    message: expect.stringContaining(missingSpec),
                                }),
                            })
                        ),
                    { timeout: 30_000 }
                );
                await new Promise((resolve) => setTimeout(resolve, 250));
                expect(warnings).toHaveLength(1);
                expect(progress.map((event) => event.data.phase)).toEqual([
                    "initializing",
                    "installing",
                    "complete",
                ]);
                const progressCount = progress.length;
                await session.rpc.agent.list();
                await new Promise((resolve) => setTimeout(resolve, 250));
                expect(warnings).toHaveLength(1);
                expect(progress).toHaveLength(progressCount);
                expect(
                    warnings.find(
                        (warning) =>
                            warning.data.warningType === "managed_plugins" &&
                            warning.data.message.includes(missingSpec)
                    )?.data.message
                ).toContain("Continuing with the current setup");
            } finally {
                await session.disconnect();
            }
        }
    );

    it.skipIf(isInProcessTransport)(
        "does not satisfy an unavailable marketplace from another marketplace cache",
        { timeout: 120_000 },
        async () => {
            const pluginName = "managed-cache-proof";
            const sourceMarketplace = "managed-cache-source";
            const unavailableMarketplace = "managed-cache-unavailable";
            const sourceSpec = `${pluginName}@${sourceMarketplace}`;
            const unavailableSpec = `${pluginName}@${unavailableMarketplace}`;
            const marketplaceDir = join(workDir, sourceMarketplace);
            const pluginDir = join(marketplaceDir, "plugins", pluginName);
            mkdirSync(join(marketplaceDir, ".github", "plugin"), { recursive: true });
            mkdirSync(pluginDir, { recursive: true });
            writeFileSync(
                join(marketplaceDir, ".github", "plugin", "marketplace.json"),
                JSON.stringify({
                    name: sourceMarketplace,
                    owner: { name: "SDK E2E" },
                    plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
                })
            );
            writeFileSync(
                join(pluginDir, "plugin.json"),
                JSON.stringify({ name: pluginName, version: "2.0.0" })
            );
            execFileSync("git", ["init", "--initial-branch=main"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.name", "SDK E2E"], { cwd: marketplaceDir });
            execFileSync("git", ["config", "user.email", "sdk-e2e@example.invalid"], {
                cwd: marketplaceDir,
            });
            execFileSync("git", ["add", "."], { cwd: marketplaceDir });
            execFileSync("git", ["commit", "-m", "Publish cached managed plugin"], {
                cwd: marketplaceDir,
            });

            const missingMarketplaceDir = join(workDir, unavailableMarketplace);
            rmSync(missingMarketplaceDir, { recursive: true, force: true });
            const policyPath = join(workDir, "managed-cache-policy.json");
            writeFileSync(
                policyPath,
                JSON.stringify({
                    extraKnownMarketplaces: {
                        [sourceMarketplace]: {
                            source: {
                                source: "git",
                                url: pathToFileURL(marketplaceDir).toString(),
                                ref: "main",
                            },
                        },
                    },
                    enabledPlugins: { [sourceSpec]: true },
                })
            );

            const home = join(workDir, "managed-cache-home");
            const cache = join(workDir, "managed-cache-isolated-cache");
            mkdirSync(home, { recursive: true });
            mkdirSync(cache, { recursive: true });
            const client = new CopilotClient({
                workingDirectory: workDir,
                connection: RuntimeConnection.forStdio({
                    path: process.env.COPILOT_CLI_PATH,
                }),
                useLoggedInUser: false,
                gitHubToken: env.GITHUB_TOKEN,
                env: {
                    ...env,
                    COPILOT_HOME: home,
                    COPILOT_CACHE_HOME: cache,
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

            const events: SessionEvent[] = [];
            const session = await client.createSession({
                enableManagedSettings: true,
                onEvent: (event) => events.push(event),
            });
            try {
                await session.rpc.agent.list();
                await vi.waitFor(
                    async () =>
                        expect(
                            (await client.rpc.plugins.list()).plugins.find(
                                (plugin) =>
                                    plugin.name === pluginName &&
                                    plugin.marketplace === sourceMarketplace
                            )
                        ).toMatchObject({ version: "2.0.0" }),
                    { timeout: 45_000 }
                );
                await vi.waitFor(
                    () =>
                        expect(events).toContainEqual(
                            expect.objectContaining({
                                type: "session.info",
                                data: expect.objectContaining({
                                    infoType: "managed_plugins_complete",
                                }),
                            })
                        ),
                    { timeout: 45_000 }
                );

                const outcomeStart = events.length;
                writeFileSync(
                    policyPath,
                    JSON.stringify({
                        extraKnownMarketplaces: {
                            [unavailableMarketplace]: {
                                source: {
                                    source: "git",
                                    url: pathToFileURL(missingMarketplaceDir).toString(),
                                    ref: "main",
                                },
                            },
                        },
                        enabledPlugins: { [unavailableSpec]: true },
                    })
                );
                await vi.waitFor(
                    async () =>
                        expect((await session.rpc.managedSettings.get()).settings).toMatchObject({
                            enabledPlugins: { [unavailableSpec]: true },
                        }),
                    { timeout: 10_000 }
                );
                await vi.waitFor(
                    () =>
                        expect(
                            events
                                .slice(outcomeStart)
                                .some(
                                    (event) =>
                                        (event.type === "session.warning" &&
                                            event.data.warningType === "managed_plugins") ||
                                        (event.type === "session.info" &&
                                            event.data.infoType === "managed_plugins_complete")
                                )
                        ).toBe(true),
                    { timeout: 30_000 }
                );

                const outcome = events.slice(outcomeStart);
                const unavailable = (await client.rpc.plugins.list()).plugins.find(
                    (plugin) =>
                        plugin.name === pluginName && plugin.marketplace === unavailableMarketplace
                );
                expect({
                    warning: outcome.find(
                        (event) =>
                            event.type === "session.warning" &&
                            event.data.warningType === "managed_plugins"
                    )?.data.message,
                    ready: outcome.some(
                        (event) =>
                            event.type === "session.info" &&
                            event.data.infoType === "managed_plugins_complete"
                    ),
                    unavailable,
                }).toEqual({
                    warning: expect.stringContaining(unavailableSpec),
                    ready: false,
                    unavailable: undefined,
                });
            } finally {
                await session.disconnect();
            }
        }
    );
});

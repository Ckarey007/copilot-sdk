/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { approveAll } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const TEST_NAME = "creates missing denied directories on the host before a sandboxed shell runs";

describe("Sandbox filesystem", async () => {
    if (process.platform !== "darwin") {
        // The SDK sandbox suite currently has a backend only on macOS.
        it.skip(TEST_NAME, () => undefined);
        return;
    }

    const { copilotClient: client, workDir } = await createSdkTestContext({
        copilotClientOptions: {
            env: { COPILOT_CLI_ENABLED_FEATURE_FLAGS: "SANDBOX" },
        },
    });

    it(TEST_NAME, { timeout: 120_000 }, async ({ expect }) => {
        const denied = join(workDir, "vault", ".env");
        expect(existsSync(denied)).toBe(false);
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const update = await session.rpc.options.update({
                sandboxConfig: {
                    enabled: true,
                    allowBypass: false,
                    addCurrentWorkingDirectory: true,
                    userPolicy: {
                        filesystem: { deniedPaths: ["./vault/.env"] },
                        network: { allowOutbound: false },
                    },
                },
            });
            expect(update.success).toBe(true);
            const result = await session.rpc.shell.executeUserRequested({
                requestId: "denied-directory",
                command:
                    "echo control > control.txt && " +
                    "if echo blocked > vault/.env/probe; then echo SANDBOX_WROTE; " +
                    "else echo SANDBOX_DENIED; fi",
            });
            expect(result.success, result.output).toBe(true);
            expect(result.exitCode, result.output).toBe(0);
            expect(result.output).toContain("SANDBOX_DENIED");
            expect(result.output).not.toContain("SANDBOX_WROTE");
            expect((await stat(denied)).isDirectory()).toBe(true);
            expect(existsSync(join(denied, "probe"))).toBe(false);
            expect((await readFile(join(workDir, "control.txt"), "utf8")).trim()).toBe("control");
        } finally {
            await session.disconnect();
        }
    });
});

describe("Sandbox developer-tool caches", async () => {
    const testName = "writes the Maven cache while preserving explicit filesystem restrictions";
    if (process.platform !== "darwin") {
        it.skip(testName, () => undefined);
        return;
    }

    // Cache discovery is process-wide, so this fixture owns a fresh runtime process.
    const {
        copilotClient: client,
        homeDir,
        workDir,
        env,
    } = await createSdkTestContext({
        useStdio: true,
        copilotClientOptions: {
            env: { COPILOT_CLI_ENABLED_FEATURE_FLAGS: "SANDBOX" },
        },
    });
    Object.assign(env, { HOME: homeDir });

    it(testName, { timeout: 120_000 }, async ({ expect }) => {
        const repository = join(homeDir, ".m2", "repository");
        await mkdir(repository, { recursive: true });
        await writeFile(join(workDir, "pom.xml"), "<project/>");
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            for (const explicitGrant of [false, true]) {
                const update = await session.rpc.options.update({
                    sandboxConfig: {
                        enabled: true,
                        allowBypass: false,
                        userPolicy: {
                            filesystem: {
                                readwritePaths: explicitGrant ? [repository] : [],
                            },
                            network: { allowOutbound: false },
                        },
                    },
                });
                expect(update.success).toBe(true);
                const filename = explicitGrant ? "explicit.properties" : "default.properties";
                const result = await session.rpc.shell.executeUserRequested({
                    requestId: `maven-cache-${explicitGrant}`,
                    command: `echo CACHE_WRITE_OK > "$HOME/.m2/repository/${filename}"`,
                });
                expect(result.success, result.output).toBe(true);
                expect(result.exitCode, result.output).toBe(0);
                expect((await readFile(join(repository, filename), "utf8")).trim()).toBe(
                    "CACHE_WRITE_OK"
                );
            }
            for (const restriction of ["readonlyPaths", "deniedPaths"] as const) {
                const update = await session.rpc.options.update({
                    sandboxConfig: {
                        enabled: true,
                        allowBypass: false,
                        userPolicy: {
                            filesystem: {
                                readwritePaths: [repository],
                                [restriction]: [repository],
                            },
                            network: { allowOutbound: false },
                        },
                    },
                });
                expect(update.success).toBe(true);
                const result = await session.rpc.shell.executeUserRequested({
                    requestId: `maven-cache-${restriction}`,
                    command:
                        'if echo blocked > "$HOME/.m2/repository/blocked.properties"; ' +
                        "then echo CACHE_WROTE; else echo CACHE_DENIED; fi",
                });
                expect(result.success, result.output).toBe(true);
                expect(result.exitCode, result.output).toBe(0);
                expect(result.output).toContain("CACHE_DENIED");
                expect(result.output).not.toContain("CACHE_WROTE");
                expect(existsSync(join(repository, "blocked.properties"))).toBe(false);
            }
        } finally {
            await session.disconnect();
        }
    });
});

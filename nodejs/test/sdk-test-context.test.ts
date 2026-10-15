/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { describe, it } from "vitest";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const sdkRoot = resolve(import.meta.dirname, "..");
const vitestEntry = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const contextModule = join(sdkRoot, "test/e2e/harness/sdkTestContext.ts");
const proxyModule = join(sdkRoot, "test/e2e/harness/CapiProxy.ts");
const clientModule = join(sdkRoot, "src/index.ts");

const cases = [
    { name: "selected parent with filtered nested context", pattern: "parent case", starts: 1 },
    { name: "selected isolated nested context", pattern: "nested case", starts: 2 },
    { name: "no selected cases", pattern: "not present", starts: 0 },
    {
        name: "partial initialization failure",
        pattern: "parent case",
        starts: 1,
        initializationFails: true,
    },
] as const;

describe("SDK test context ownership", () => {
    it("collects resource-dependent consumers without acquiring filtered resources", async (task) => {
        const root = await mkdtemp(join(tmpdir(), "sdk-context-consumers-"));
        let execution: Promise<unknown> | undefined;
        task.onTestFinished(async () => {
            await execution;
            await rm(root, { recursive: true, force: true });
        });
        const environment = { ...process.env };
        for (const key of ["HOME", "COPILOT_HOME", "COPILOT_CACHE_HOME", "GH_CONFIG_DIR"]) {
            const directory = join(root, key.toLowerCase());
            await mkdir(directory, { mode: 0o700 });
            environment[key] = directory;
        }
        const testTmp = join(root, "tmp");
        await mkdir(testTmp, { mode: 0o700 });
        Object.assign(environment, {
            TMPDIR: testTmp,
            TMP: testTmp,
            TEMP: testTmp,
            GITHUB_ACTIONS: "true",
            NODE_DISABLE_COMPILE_CACHE: "1",
            COPILOT_SDK_DEFAULT_CONNECTION: "stdio",
            COPILOT_SDK_E2E_BACKEND: "capi",
            COPILOT_CLI_PATH: join(root, "runtime-must-not-start"),
        });
        const report = join(root, "report.json");
        const config = join(root, "vitest.config.mjs");
        const consumers = [
            "accounts_login.e2e.test.ts",
            "commands.e2e.test.ts",
            "connection_token.test.ts",
            "mode_handlers.e2e.test.ts",
            "multi-client.e2e.test.ts",
            "per_session_auth.e2e.test.ts",
            "structured_output.e2e.test.ts",
            "ui_elicitation.e2e.test.ts",
            "websocket_http_fallback.e2e.test.ts",
            "websocket_terminals.e2e.test.ts",
        ].map((file) => join(sdkRoot, "test/e2e", file).replaceAll("\\", "/"));
        await writeFile(
            config,
            `import base from ${JSON.stringify(join(sdkRoot, "vitest.config.ts"))};
export default {
    ...base,
    cacheDir: ${JSON.stringify(join(root, "vite-cache"))},
    test: {
        ...base.test,
        include: ${JSON.stringify(consumers)},
        globalSetup: [],
    },
};
`
        );
        // Collect the actual consumers with no selected tests and no proxy bundle.
        // Proxy access, runtime startup, or helper acquisition must stay inside hooks.
        execution = run(
            process.execPath,
            [
                vitestEntry,
                "run",
                "--config",
                config,
                "--root",
                sdkRoot,
                "--testNamePattern",
                "^no selected SDK consumer$",
                "--reporter=default",
                "--reporter=json",
                "--outputFile",
                report,
            ],
            { cwd: sdkRoot, env: environment, signal: task.signal }
        ).then(
            (result) => ({ ...result, code: 0 }),
            (error: Error & { code?: number; stdout?: string; stderr?: string }) => ({
                code: error.code,
                stdout: error.stdout ?? "",
                stderr: error.stderr ?? "",
            })
        );
        const result = (await execution) as { code?: number; stdout: string; stderr: string };
        const testReport = JSON.parse(await readFile(report, "utf8"));
        task.expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
        task.expect(
            testReport.testResults.map((suite: { name: string }) => suite.name).sort()
        ).toEqual([...consumers].sort());
        task.expect(testReport.numFailedTestSuites).toBe(0);
        task.expect(testReport.numTotalTests).toBeGreaterThan(0);
        task.expect(testReport.numPendingTests).toBe(testReport.numTotalTests);
        task.expect(await readdir(testTmp)).toEqual([]);
        task.expect(result.stderr).not.toMatch(/close timed out|Failed to terminate/);
    });

    for (const { name, pattern, starts, ...scenario } of cases) {
        it(name, async (task) => {
            const root = await mkdtemp(join(tmpdir(), "sdk-context-"));
            let execution: Promise<unknown> | undefined;
            task.onTestFinished(async () => {
                await execution;
                await rm(root, { recursive: true, force: true });
            });
            const environment = { ...process.env };
            for (const key of ["HOME", "COPILOT_HOME", "COPILOT_CACHE_HOME", "GH_CONFIG_DIR"]) {
                const directory = join(root, key.toLowerCase());
                await mkdir(directory, { mode: 0o700 });
                environment[key] = directory;
            }
            const testTmp = join(root, "tmp");
            await mkdir(testTmp, { mode: 0o700 });
            Object.assign(environment, { TMPDIR: testTmp, TMP: testTmp, TEMP: testTmp });
            await symlink(join(sdkRoot, "node_modules"), join(root, "node_modules"), "junction");
            const ledger = join(root, "ledger.jsonl");
            const report = join(root, "report.json");
            const fixture = join(root, "ownership.test.ts");
            const config = join(root, "vitest.config.mjs");
            await writeFile(
                config,
                `import base from ${JSON.stringify(join(sdkRoot, "vitest.config.ts"))};
export default {
    ...base,
    cacheDir: ${JSON.stringify(join(root, "vite-cache"))},
    test: {
        ...base.test,
        include: [${JSON.stringify(fixture.replaceAll("\\", "/"))}],
        globalSetup: [],
    },
};
`
            );
            // Exercise the real collection/filter/hooks boundary, with only the replay
            // endpoint substituted. No model request or runtime process is started.
            await writeFile(
                fixture,
                `import { existsSync, appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSdkTestContext } from ${JSON.stringify(contextModule)};
import { CopilotClient } from ${JSON.stringify(clientModule)};

vi.mock(${JSON.stringify(proxyModule)}, async () => {
    const { randomUUID } = await import("node:crypto");
    const { appendFileSync } = await import("node:fs");
    const record = (event) => appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(event) + "\\n");
    return {
        CapiProxy: class {
            id = randomUUID();
            url = "http://127.0.0.1/" + this.id;
            async start() {
                record({ kind: "start", id: this.id });
                return this.url;
            }
            async setCopilotUserByToken(_token, user) {
                expect(user.endpoints.api).toBe(this.url);
                ${"initializationFails" in scenario ? 'throw new Error("controlled context initialization failure");' : ""}
            }
            getProxyEnv() {
                return { HTTP_PROXY: this.url, http_proxy: this.url };
            }
            async updateConfig(config) {
                expect(existsSync(config.workDir)).toBe(true);
                record({ kind: "config", id: this.id, workDir: config.workDir, modelNames: config.modelNames });
            }
            async stop() {
                record({ kind: "stop", id: this.id });
            }
        },
    };
});

const startingClient = vi.spyOn(CopilotClient.prototype, "start").mockImplementation(async () => {
    throw new Error("runtime startup is forbidden in the fixture ownership regression");
});
const record = (event) => appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(event) + "\\n");
function remember(scope, context) {
    record({
        kind: "context",
        scope,
        homeDir: context.homeDir,
        workDir: context.workDir,
        copilotHomeDir: context.env.COPILOT_HOME,
    });
}
function check(context) {
    expect(existsSync(context.homeDir)).toBe(true);
    expect(existsSync(context.workDir)).toBe(true);
    expect(existsSync(context.env.COPILOT_HOME)).toBe(true);
    expect(context.env.COPILOT_API_URL).toBe(context.openAiEndpoint.url);
    expect(context.env.HTTP_PROXY).toBe(context.openAiEndpoint.url);
    const clientEnv = context.copilotClient.resolvedEnv;
    expect(clientEnv.COPILOT_API_URL).toBe(context.openAiEndpoint.url);
    expect(clientEnv.COPILOT_HOME).toBe(context.env.COPILOT_HOME);
    expect(clientEnv.http_proxy).toBe("caller-proxy");
    expect(context.copilotClient.options.workingDirectory).toBe(context.workDir);
    const secondary = context.createClient();
    expect(secondary.resolvedEnv).toBe(clientEnv);
    expect(secondary.options.workingDirectory).toBe(context.workDir);
    expect(startingClient).not.toHaveBeenCalled();
}

describe("parent", async () => {
    const parent = await createSdkTestContext({
        copilotClientOptions: { env: { http_proxy: "caller-proxy" } },
    });
    remember("parent", parent);
    it("parent case", () => check(parent));
    describe("nested", async () => {
        const nested = await createSdkTestContext({
            copilotClientOptions: { env: { http_proxy: "caller-proxy" } },
            modelNames: { "isolated-model": "isolated-model-alias" },
        });
        remember("nested", nested);
        it("nested case", () => {
            check(parent);
            check(nested);
            expect(parent.homeDir).not.toBe(nested.homeDir);
            expect(parent.workDir).not.toBe(nested.workDir);
            expect(parent.env.COPILOT_HOME).not.toBe(nested.env.COPILOT_HOME);
            expect(parent.openAiEndpoint.url).not.toBe(nested.openAiEndpoint.url);
            expect(parent.copilotClient).not.toBe(nested.copilotClient);
        });
    });
});
`
            );
            execution = run(
                process.execPath,
                [
                    vitestEntry,
                    "run",
                    "--config",
                    config,
                    "--root",
                    root,
                    "--testNamePattern",
                    pattern,
                    "--reporter=default",
                    "--reporter=json",
                    "--outputFile",
                    report,
                ],
                {
                    cwd: sdkRoot,
                    env: environment,
                    signal: task.signal,
                }
            ).then(
                (result) => ({ ...result, code: 0 }),
                (error: Error & { code?: number; stdout?: string; stderr?: string }) => ({
                    code: error.code,
                    stdout: error.stdout ?? "",
                    stderr: error.stderr ?? "",
                })
            );
            const result = (await execution) as { code?: number; stdout: string; stderr: string };
            const events = (await readFile(ledger, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            const started = events.filter((event) => event.kind === "start");
            const stopped = events.filter((event) => event.kind === "stop");
            const testReport = JSON.parse(await readFile(report, "utf8"));
            console.log(
                "fixture-ownership:",
                JSON.stringify({ pattern, starts, result, events, testReport })
            );
            task.expect(started, result.stderr).toHaveLength(starts);
            task.expect(stopped.map((event) => event.id).sort()).toEqual(
                started.map((event) => event.id).sort()
            );
            for (const event of events.filter((event) => event.kind === "context")) {
                for (const path of [event.homeDir, event.workDir, event.copilotHomeDir]) {
                    task.expect(existsSync(path), path).toBe(false);
                }
            }
            if ("initializationFails" in scenario) {
                task.expect(result.code).toBe(1);
                // JSON omits nested-suite hook errors; observe the real reporter's error line.
                task.expect(stripVTControlCharacters(result.stderr)).toMatch(
                    /^Error: controlled context initialization failure$/m
                );
                task.expect(testReport.numPassedTests).toBe(0);
            } else {
                task.expect(result.code, result.stderr).toBe(0);
                task.expect(testReport.numPassedTests).toBe(starts === 0 ? 0 : 1);
                task.expect(testReport.numFailedTests).toBe(0);
            }
            task.expect(result.stderr).not.toMatch(/close timed out|Failed to terminate/);
        });
    }
});

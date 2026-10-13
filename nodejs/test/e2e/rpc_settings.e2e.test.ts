/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, onTestFinished } from "vitest";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import { createInternalServerRpc, createServerRpc } from "../../src/generated/rpc.js";
import { createSdkTestContext, getLegacyCliPathForTests } from "./harness/sdkTestContext.js";
import { stopChildProcess } from "./harness/sdkTestHelper.js";

describe("Internal settings RPC through the CLI SDK server", async () => {
    const { env, workDir } = await createSdkTestContext();

    it("preserves settings semantics through the generated SDK methods", async ({ expect }) => {
        const home = join(workDir, "settings-home");
        const repoRoot = join(workDir, "repository");
        await mkdir(home, { recursive: true });
        await mkdir(join(repoRoot, ".github", "copilot"), { recursive: true });
        const legacy = { model: "legacy-model", render_markdown: false };
        await writeFile(join(home, "config.json"), JSON.stringify(legacy));

        // These methods are internal, so use their generated projection over a real CLI transport.
        const cliPath = await getLegacyCliPathForTests();
        const args = ["--headless", "--stdio", "--no-auto-update", "--log-level", "error"];
        const child = spawn(
            cliPath.endsWith(".js") ? process.execPath : cliPath,
            cliPath.endsWith(".js") ? [cliPath, ...args] : args,
            { cwd: workDir, env: { ...env, COPILOT_HOME: home }, stdio: "pipe" }
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        const connection = createMessageConnection(
            new StreamMessageReader(child.stdout),
            new StreamMessageWriter(child.stdin)
        );
        onTestFinished(async () => {
            connection.dispose();
            await stopChildProcess(child);
        });
        await once(child, "spawn");
        connection.listen();
        const rpc = createInternalServerRpc(connection);
        expect(await rpc.connect({}), stderr).toMatchObject({
            protocolVersion: expect.any(Number),
        });

        const paths = await rpc.user.settings.getPaths({ repoRoot });
        expect(paths).toEqual({
            userSettings: join(home, "settings.json"),
            repoSettings: join(repoRoot, ".github", "copilot", "settings.json"),
            repoLocalSettings: join(repoRoot, ".github", "copilot", "settings.local.json"),
        });
        expect((await rpc.user.settings.listGovernanceKeys()).repo).toContain("model");
        expect(await rpc.user.settings.normalize({ settings: { render_markdown: true } })).toEqual({
            settings: { renderMarkdown: true },
        });
        const problems = await rpc.user.settings.diagnoseProblems({
            sources: [
                {
                    kind: "user",
                    label: "User",
                    filePath: paths.userSettings,
                    config: { notASetting: true },
                },
            ],
        });
        expect(problems.problems).toEqual([
            expect.objectContaining({ kind: "unknown-key", rawKey: "notASetting" }),
        ]);

        await rpc.user.settings.writeAll({ settings: { model: "initial-model", beep: true } });
        expect(
            await rpc.user.settings.edit({
                canonicalPath: ["model"],
                operation: "set",
                value: "edited-model",
            })
        ).toEqual({ status: "changed" });
        expect(
            await rpc.user.settings.applyTopKey({
                canonicalPath: ["model"],
                topKey: "model",
                value: null,
            })
        ).toMatchObject({ status: "validation-error" });
        expect(
            await rpc.user.settings.applyTopKey({
                canonicalPath: ["model"],
                topKey: "model",
                value: "applied-model",
            })
        ).toEqual({ status: "ok" });
        expect(JSON.parse(await readFile(paths.userSettings, "utf8"))).toEqual({
            model: "applied-model",
            beep: true,
        });
        await rpc.user.settings.writeAll({ settings: { model: "replacement-model" } });
        expect(JSON.parse(await readFile(paths.userSettings, "utf8"))).toEqual({
            model: "replacement-model",
        });
        const loaded = await createServerRpc(connection).user.settings.get();
        expect(loaded.settings.model.value).toBe("replacement-model");

        const repoPath = join(repoRoot, ".github", "copilot", "settings.json");
        await writeFile(repoPath, '{"custom":{"items":[true,null,12.5]}}');
        const target = { repoRoot, scope: "repo" };
        await rpc.repo.settings.writeKey({ ...target, key: "model", value: "repo-model" });
        expect(await rpc.repo.settings.readRaw(target)).toEqual({
            config: { custom: { items: [true, null, 12.5] }, model: "repo-model" },
            invalid: false,
        });
        await rpc.repo.settings.writeAll({ ...target, settings: {} });
        expect(await rpc.repo.settings.readRaw(target)).toEqual({
            config: { custom: { items: [true, null, 12.5] } },
            invalid: false,
        });
        await writeFile(repoPath, "{ invalid");
        expect(await rpc.repo.settings.readRaw(target)).toEqual({ config: {}, invalid: true });
        await expect(
            rpc.repo.settings.writeKey({
                ...target,
                key: "model",
                value: "must-not-replace-invalid-file",
            })
        ).rejects.toThrow();
        expect(await readFile(repoPath, "utf8")).toBe("{ invalid");
    });
});

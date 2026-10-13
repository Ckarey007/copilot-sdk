/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { approveAll, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

function writeFile(root: string, relative: string[], content: string): string {
    const file = path.join(root, ...relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

function writeSkill(root: string, directory: string, name: string): void {
    writeFile(
        root,
        [directory, name, "SKILL.md"],
        `---\nname: ${name}\ndescription: Discovery directory regression fixture.\n---\n\nUse this skill.\n`
    );
}

describe("Customization directory discovery", async () => {
    const {
        copilotClient: client,
        env,
        workDir: testRoot,
        createClient,
    } = await createSdkTestContext({
        copilotClientOptions: { env: { COPILOT_ALLOW_ALL: "1" } },
    });
    let workDir: string;

    beforeEach(async () => {
        workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(testRoot, "customizations-")));
        execFileSync("git", ["init", "--quiet"], { cwd: workDir, windowsHide: true });
        writeFile(
            env.COPILOT_HOME,
            ["config.json"],
            JSON.stringify({ trustedFolders: [testRoot] })
        );
        await client.start();
    });

    it("discovers all four repository lists and applies independent local replacements", async () => {
        writeSkill(workDir, "vendor-skills", "repository-directory-skill");
        writeFile(
            workDir,
            ["vendor-agents", "directory.agent.md"],
            "---\nname: repository-directory-agent\ndescription: Directory fixture.\n---\n\nRead the repository.\n"
        );
        const instruction = writeFile(
            workDir,
            ["vendor-instructions", "guard.instructions.md"],
            "---\napplyTo: '**/*.ts'\n---\n\nRepository directory instruction sentinel.\n"
        );
        writeFile(
            workDir,
            ["vendor-instructions", "AGENTS.md"],
            "Do not inject this package hierarchy."
        );
        writeFile(
            workDir,
            ["vendor-hooks", "hooks.json"],
            JSON.stringify({ hooks: { sessionStart: [{ command: "echo directory-hook" }] } })
        );
        writeFile(
            workDir,
            [".github", "copilot", "settings.json"],
            JSON.stringify({
                skillDirectories: ["vendor-skills"],
                agentDirectories: ["vendor-agents"],
                instructionDirectories: ["vendor-instructions"],
                hookDirectories: ["vendor-hooks"],
            })
        );
        const projectPaths = [workDir];
        const skills = await client.rpc.skills.discover({ projectPaths, excludeHostSkills: true });
        expect(
            skills.skills.filter((skill) => skill.name === "repository-directory-skill")
        ).toHaveLength(1);
        const agents = await client.rpc.agents.discover({ projectPaths, excludeHostAgents: true });
        expect(
            agents.agents.filter((agent) => agent.name === "repository-directory-agent")
        ).toHaveLength(1);
        const instructions = await client.rpc.instructions.discover({
            projectPaths,
            excludeHostInstructions: true,
        });
        expect(
            instructions.sources.filter((source) => source.sourcePath === instruction)
        ).toHaveLength(1);
        expect(
            instructions.sources.some((source) =>
                source.content.includes("Do not inject this package hierarchy.")
            )
        ).toBe(false);
        const hooks = await client.rpc.hooks.discover({ projectPaths, excludeHostHooks: true });
        expect(hooks.hooks.some((hook) => hook.source.includes("vendor-hooks"))).toBe(true);

        writeFile(
            workDir,
            [".github", "copilot", "settings.local.json"],
            JSON.stringify({ skillDirectories: [], hookDirectories: [] })
        );
        const clearedSkills = await client.rpc.skills.discover({
            projectPaths,
            excludeHostSkills: true,
        });
        expect(
            clearedSkills.skills.some((skill) => skill.name === "repository-directory-skill")
        ).toBe(false);
        const retainedAgents = await client.rpc.agents.discover({
            projectPaths,
            excludeHostAgents: true,
        });
        expect(
            retainedAgents.agents.some((agent) => agent.name === "repository-directory-agent")
        ).toBe(true);
        const clearedHooks = await client.rpc.hooks.discover({
            projectPaths,
            excludeHostHooks: true,
        });
        expect(clearedHooks.hooks.some((hook) => hook.source.includes("vendor-hooks"))).toBe(false);
    });

    it("anchors SDK relative roots once and reanchors only newly supplied lists", async () => {
        const original = path.join(workDir, "original");
        const next = path.join(workDir, "next");
        writeSkill(original, "skills", "original-directory-skill");
        writeSkill(next, "skills", "next-directory-skill");
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            workingDirectory: original,
            enableConfigDiscovery: false,
            skillDirectories: ["skills"],
        });
        try {
            await session.rpc.skills.ensureLoaded();
            expect(
                (await session.rpc.skills.list()).skills.some(
                    (skill) => skill.name === "original-directory-skill"
                )
            ).toBe(true);
            expect((await session.rpc.options.update({ workingDirectory: next })).success).toBe(
                true
            );
            await session.rpc.skills.ensureLoaded();
            const retained = await session.rpc.skills.list();
            expect(retained.skills.some((skill) => skill.name === "original-directory-skill")).toBe(
                true
            );
            expect(retained.skills.some((skill) => skill.name === "next-directory-skill")).toBe(
                false
            );
            expect(
                (await session.rpc.options.update({ skillDirectories: ["skills"] })).success
            ).toBe(true);
            await session.rpc.skills.ensureLoaded();
            const changed = await session.rpc.skills.list();
            expect(changed.skills.some((skill) => skill.name === "original-directory-skill")).toBe(
                false
            );
            expect(changed.skills.some((skill) => skill.name === "next-directory-skill")).toBe(
                true
            );
            expect((await session.rpc.options.update({ skillDirectories: [] })).success).toBe(true);
            await session.rpc.skills.ensureLoaded();
            expect(
                (await session.rpc.skills.list()).skills.some(
                    (skill) => skill.name === "next-directory-skill"
                )
            ).toBe(false);
        } finally {
            await session.disconnect();
        }
    });

    it("anchors newly supplied roots to the persisted workspace on cold resume", async () => {
        const original = path.join(workDir, "nested");
        fs.mkdirSync(original);
        writeSkill(workDir, path.join("vendor", "alternate-skills"), "cold-resume-directory-skill");
        const first = createClient({ connection: RuntimeConnection.forStdio() });
        const next = createClient({ connection: RuntimeConnection.forStdio() });
        try {
            await first.start();
            const session = await first.createSession({
                onPermissionRequest: approveAll,
                workingDirectory: original,
                enableConfigDiscovery: false,
                requestExtensions: false,
            });
            await session.rpc.workspaces.ensure({});
            const { sessionId } = await first.rpc.sessions.fork({ sessionId: session.sessionId });
            await session.disconnect();
            await first.stop();
            await next.start();
            const resumed = await next.resumeSession(sessionId, {
                onPermissionRequest: approveAll,
                enableConfigDiscovery: false,
                requestExtensions: false,
                skillDirectories: [path.join("..", "vendor", "alternate-skills")],
            });
            try {
                expect((await resumed.rpc.metadata.snapshot()).workingDirectory).toBe(original);
                await resumed.rpc.skills.ensureLoaded();
                const skills = await resumed.rpc.skills.list();
                expect(
                    skills.skills.some((skill) => skill.name === "cold-resume-directory-skill")
                ).toBe(true);
            } finally {
                await resumed.disconnect();
            }
        } finally {
            await next.stop();
            await first.stop();
        }
    });

    it("retains explicit file hooks when repository hooks and ambient discovery are disabled", async () => {
        const hooks = path.join(workDir, "explicit-hooks");
        writeFile(hooks, ["resource.txt"], "resource-sentinel");
        writeFile(
            hooks,
            ["probe.cjs"],
            "const fs = require('node:fs'); const path = require('node:path');\n" +
                "fs.appendFileSync(path.join(process.cwd(), 'hook-observations.jsonl'), JSON.stringify({" +
                "directory: process.env.COPILOT_HOOK_DIR, cwd: process.cwd(), " +
                "resource: fs.readFileSync(path.join(process.env.COPILOT_HOOK_DIR, 'resource.txt'), 'utf8')" +
                "}) + '\\n');\n"
        );
        writeFile(
            hooks,
            ["hooks.json"],
            JSON.stringify({
                hooks: {
                    preToolUse: [
                        {
                            type: "command",
                            bash: `"${process.execPath}" "$COPILOT_HOOK_DIR/probe.cjs"`,
                            powershell: `& "${process.execPath}" (Join-Path $env:COPILOT_HOOK_DIR 'probe.cjs')`,
                        },
                    ],
                },
            })
        );
        writeFile(
            workDir,
            [".github", "hooks", "ambient.json"],
            JSON.stringify({
                hooks: { preToolUse: [{ command: "echo ambient-hook" }] },
            })
        );
        let callbackInvocations = 0;
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            workingDirectory: workDir,
            enableConfigDiscovery: false,
            enableFileHooks: false,
            hookDirectories: [hooks],
            hooks: {
                onPreToolUse: async () => {
                    callbackInvocations++;
                    return { permissionDecision: "allow" };
                },
            },
        });
        try {
            await client.rpc.sessions.reloadPluginHooks({
                sessionId: session.sessionId,
                deferRepoHooks: true,
            });
            await session.rpc.tools.initializeAndValidate();
            const result = await session.rpc.tools.execute({
                name: "view",
                arguments: { path: path.join(hooks, "resource.txt") },
                toolCallId: "explicit-hook-directory-probe",
            });
            expect(JSON.stringify(result)).toContain("resource-sentinel");
            expect(callbackInvocations).toBe(1);
            const observations = path.join(workDir, "hook-observations.jsonl");
            const first = fs.readFileSync(observations, "utf8").trim().split("\n");
            expect(first).toHaveLength(1);
            expect(JSON.parse(first[0])).toEqual({
                directory: hooks,
                cwd: workDir,
                resource: "resource-sentinel",
            });
            expect((await session.rpc.options.update({ hookDirectories: [] })).success).toBe(true);
            await client.rpc.sessions.reloadPluginHooks({
                sessionId: session.sessionId,
                deferRepoHooks: true,
            });
            await session.rpc.tools.execute({
                name: "view",
                arguments: { path: path.join(hooks, "resource.txt") },
                toolCallId: "cleared-hook-directory-probe",
            });
            expect(fs.readFileSync(observations, "utf8").trim().split("\n")).toHaveLength(1);
            expect(callbackInvocations).toBe(2);
        } finally {
            await session.disconnect();
        }
    });

    it("retains conventional and configured guard hooks after changing to a repository subdirectory", async () => {
        const observations = path.join(workDir, "cwd-hooks.jsonl");
        const subdir = path.join(workDir, "subdir");
        fs.mkdirSync(subdir);
        for (const parts of [[".github", "hooks"], ["vendor-hooks"]]) {
            const hooks = path.join(workDir, ...parts);
            writeFile(
                hooks,
                ["probe.cjs"],
                "require('node:fs').appendFileSync(" +
                    JSON.stringify(observations) +
                    ", JSON.stringify({directory: process.env.COPILOT_HOOK_DIR, cwd: process.cwd()}) + '\\n');\n"
            );
            writeFile(
                hooks,
                ["hooks.json"],
                JSON.stringify({
                    hooks: {
                        preToolUse: [
                            {
                                type: "command",
                                bash: `"${process.execPath}" "$COPILOT_HOOK_DIR/probe.cjs"`,
                                powershell: `& "${process.execPath}" (Join-Path $env:COPILOT_HOOK_DIR 'probe.cjs')`,
                            },
                        ],
                    },
                })
            );
        }
        writeFile(
            workDir,
            [".github", "copilot", "settings.json"],
            JSON.stringify({ hookDirectories: ["vendor-hooks"] })
        );
        const resource = writeFile(workDir, ["resource.txt"], "cwd-hook-resource");
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            workingDirectory: workDir,
            enableConfigDiscovery: true,
            requestExtensions: false,
        });
        try {
            await session.rpc.tools.initializeAndValidate();
            await session.rpc.tools.execute({
                name: "view",
                arguments: { path: resource },
                toolCallId: "guard-before-cwd-change",
            });
            expect(fs.readFileSync(observations, "utf8").trim().split("\n")).toHaveLength(2);
            expect(
                await session.rpc.metadata.setWorkingDirectory({ workingDirectory: subdir })
            ).toMatchObject({ workingDirectory: subdir });
            await session.rpc.tools.execute({
                name: "view",
                arguments: { path: resource },
                toolCallId: "guard-after-cwd-change",
            });
            const rows = fs
                .readFileSync(observations, "utf8")
                .trim()
                .split("\n")
                .map((row) => JSON.parse(row));
            expect(rows).toHaveLength(4);
            expect(
                rows
                    .slice(2)
                    .map((row) => row.directory)
                    .sort()
            ).toEqual(
                [path.join(workDir, ".github", "hooks"), path.join(workDir, "vendor-hooks")].sort()
            );
            // Hooks without an explicit cwd remain anchored to the consuming project root.
            expect(rows.slice(2).map((row) => row.cwd)).toEqual([workDir, workDir]);
        } finally {
            await session.disconnect();
        }
    });
});

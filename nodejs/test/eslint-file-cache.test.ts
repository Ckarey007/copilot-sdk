import { ESLint } from "eslint";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

const nodeRoot = resolve(import.meta.dirname, "..");
const overrideConfigFile = join(nodeRoot, "eslint.config.js");

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "copilot-eslint-cache-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "src", "example.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export const value: any = 1;\n");
    const cacheLocation = join(root, "cache", "results.json");
    let lintCount = 0;
    const linter = (
        cacheStrategy: "metadata" | "content" = "metadata",
        severity: "error" | "warn" = "error"
    ) =>
        new ESLint({
            cwd: root,
            overrideConfigFile,
            cache: true,
            cacheLocation,
            cacheStrategy,
            overrideConfig: {
                plugins: {
                    probe: {
                        rules: {
                            count: {
                                meta: { schema: [] },
                                create() {
                                    lintCount++;
                                    return {};
                                },
                            },
                        },
                    },
                },
                rules: { "probe/count": severity },
            },
        });
    return { root, file, cacheLocation, linter, lintCount: () => lintCount };
}

describe("ESLint without Keyv", () => {
    it.each(["metadata", "content"] as const)(
        "persists %s cache hits and invalidates changed files and configuration",
        async (strategy) => {
            const context = fixture();
            const first = await context.linter(strategy).lintFiles([context.file]);
            expect(first[0].errorCount).toBe(0);
            expect(first[0].warningCount).toBe(1);
            expect(context.lintCount()).toBe(1);
            expect(existsSync(context.cacheLocation)).toBe(true);

            const second = await context.linter(strategy).lintFiles([context.file]);
            expect(second).toEqual(first);
            expect(context.lintCount()).toBe(1);

            const stat = statSync(context.file);
            writeFileSync(
                context.file,
                `export const value: any = ${strategy === "content" ? "2" : "200"};\n`
            );
            utimesSync(context.file, stat.atime, stat.mtime);
            const changed = await context.linter(strategy).lintFiles([context.file]);
            expect(changed[0].source).toBe(readFileSync(context.file, "utf8"));
            expect(context.lintCount()).toBe(2);

            await context.linter(strategy, "warn").lintFiles([context.file]);
            expect(context.lintCount()).toBe(3);
        }
    );

    it("retains unvisited files and prunes deleted files", async () => {
        const context = fixture();
        const other = join(dirname(context.file), "other.ts");
        writeFileSync(other, "export const other = 1;\n");
        await context.linter().lintFiles([context.file, other]);
        expect(context.lintCount()).toBe(2);

        await context.linter().lintFiles([other]);
        await context.linter().lintFiles([context.file]);
        expect(context.lintCount()).toBe(2);

        rmSync(context.file);
        await context.linter().lintFiles([other]);
        expect(context.lintCount()).toBe(2);
        expect(readFileSync(context.cacheLocation, "utf8")).not.toContain(
            JSON.stringify(context.file)
        );
    });

    it.each(["EACCES", "EPERM"])(
        "preserves an unvisited cached file when pruning encounters %s",
        async (code) => {
            const context = fixture();
            const inaccessibleFile = join(dirname(context.file), "inaccessible.ts");
            writeFileSync(inaccessibleFile, "export const other = 1;\n");
            await context.linter().lintFiles([context.file, inaccessibleFile]);

            const child = spawnSync(
                process.execPath,
                [
                    "--input-type=commonjs",
                    "-e",
                    `
const input = JSON.parse(process.argv[1]);
const fs = require("node:fs");
const originalStat = fs.statSync;
fs.statSync = function (path, ...args) {
    if (path === input.inaccessibleFile) {
        throw Object.assign(new Error(input.code + ": inaccessible cached file"), { code: input.code });
    }
    return originalStat.call(this, path, ...args);
};
const { ESLint } = require("eslint");
(async () => {
    const results = await new ESLint({
        cwd: input.root,
        overrideConfigFile: input.overrideConfigFile,
        cache: true,
        cacheLocation: input.cacheLocation,
    }).lintFiles([input.file]);
    console.log(JSON.stringify(results.map(({ errorCount, warningCount }) => ({ errorCount, warningCount }))));
})();
`,
                    JSON.stringify({
                        root: context.root,
                        file: context.file,
                        cacheLocation: context.cacheLocation,
                        overrideConfigFile,
                        inaccessibleFile,
                        code,
                    }),
                ],
                { cwd: nodeRoot, encoding: "utf8" }
            );

            expect(child.status, child.stderr || child.error?.message).toBe(0);
            expect(JSON.parse(child.stdout)).toEqual([{ errorCount: 0, warningCount: 1 }]);
            expect(child.stderr).toContain("Unable to check unvisited ESLint cache entry");
            expect(child.stderr).toContain(`${code}: inaccessible cached file`);
            expect(readFileSync(context.cacheLocation, "utf8")).toContain(
                JSON.stringify(inaccessibleFile)
            );
        }
    );

    it.each(['[{"legacy":"flatted"}]', "{invalid", "null"])(
        "warns and rebuilds an obsolete or invalid cache: %s",
        async (contents) => {
            const context = fixture();
            mkdirSync(dirname(context.cacheLocation), { recursive: true });
            writeFileSync(context.cacheLocation, contents);
            const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
            onTestFinished(() => warning.mockRestore());

            const results = await context.linter().lintFiles([context.file]);
            expect(results[0].warningCount).toBe(1);
            expect(context.lintCount()).toBe(1);
            expect(warning).toHaveBeenCalledWith(
                `Ignoring obsolete or invalid ESLint cache: ${context.cacheLocation}`,
                { code: "COPILOT_ESLINT_CACHE" }
            );
            await context.linter().lintFiles([context.file]);
            expect(context.lintCount()).toBe(1);
            expect(warning).toHaveBeenCalledTimes(1);
        }
    );

    it("surfaces cache filesystem errors", async () => {
        const context = fixture();
        writeFileSync(dirname(context.cacheLocation), "not a directory");
        await expect(context.linter().lintFiles([context.file])).rejects.toThrow();
    });

    it("preserves rule severities, underscore exceptions, rest siblings, and suppressions", async () => {
        const { root } = fixture();
        const eslint = new ESLint({ cwd: root, overrideConfigFile });
        const [result] = await eslint.lintText(
            [
                "const unused = 1;",
                "export const value: any = 1;",
                "const _ignored = 1;",
                "export function unusedArg(arg: string) {}",
                "export function ignoredArg(_arg: string) {}",
                "export const [_first, second] = [1, 2];",
                "const { omitted, ...rest } = { omitted: 1, kept: 2 };",
                "export { rest };",
                "try {} catch (_error) {}",
                "try {} catch (caught) {}",
                "console.log(value);",
                "// eslint-disable-next-line @typescript-eslint/no-unused-vars",
                "const suppressed = 1;",
                "/* eslint-disable @typescript-eslint/no-explicit-any */",
                "export const suppressedAny: any = 2;",
            ].join("\n"),
            { filePath: join(root, "src", "rules.ts") }
        );
        expect(
            result.messages.map(({ ruleId, severity, line }) => ({ ruleId, severity, line }))
        ).toEqual([
            { ruleId: "@typescript-eslint/no-unused-vars", severity: 2, line: 1 },
            { ruleId: "@typescript-eslint/no-explicit-any", severity: 1, line: 2 },
            { ruleId: "@typescript-eslint/no-unused-vars", severity: 2, line: 4 },
            { ruleId: "@typescript-eslint/no-unused-vars", severity: 2, line: 10 },
        ]);
        expect(result.suppressedMessages).toHaveLength(2);
        for (const path of [
            "dist/example.ts",
            "node_modules/example.ts",
            "example.config.ts",
            "src/generated/example.ts",
        ]) {
            expect(await eslint.isPathIgnored(join(root, path))).toBe(true);
        }
        expect(await eslint.isPathIgnored(join(root, "src", "example.ts"))).toBe(false);
        expect(await eslint.isPathIgnored(join(root, "test", "example.ts"))).toBe(false);
    });

    it.each(["package-lock.json", "samples/package-lock.json"])(
        "excludes the original Keyv package from %s",
        (path) => {
            const lock = JSON.parse(readFileSync(join(nodeRoot, path), "utf8")) as {
                packages: Record<
                    string,
                    {
                        name?: string;
                        dependencies?: Record<string, string>;
                        optionalDependencies?: Record<string, string>;
                        devDependencies?: Record<string, string>;
                        peerDependencies?: Record<string, string>;
                    }
                >;
            };
            const offenders = Object.entries(lock.packages).filter(([name, entry]) => {
                const requirements = {
                    ...entry.dependencies,
                    ...entry.optionalDependencies,
                    ...entry.devDependencies,
                    ...entry.peerDependencies,
                };
                return (
                    /(?:^|\/)node_modules\/keyv$/.test(name) ||
                    entry.name === "keyv" ||
                    "keyv" in requirements ||
                    Object.values(requirements).some((value) => value.startsWith("npm:keyv@"))
                );
            });
            expect(offenders).toEqual([]);
        }
    );
});

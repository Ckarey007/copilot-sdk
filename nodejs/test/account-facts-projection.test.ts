/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("account facts Go projection", () => {
    const source = readFileSync(new URL("../../go/rpc/zrpc.go", import.meta.url), "utf8");

    for (const name of ["AccountGetWebURLRequest", "AccountGetWebURLResult"]) {
        it(`marks ${name} as internal after Go initialism normalization`, () => {
            const comment = source.match(new RegExp(`((?://[^\\n]*\\n)+)type ${name} struct`))?.[1];
            expect(comment).toContain(`// Internal: ${name} `);
        });
    }
});

describe("account facts Python projection", () => {
    const source = readFileSync(
        new URL("../../python/copilot/generated/rpc.py", import.meta.url),
        "utf8"
    );
    const exports = source.match(/^__all__ = \[([\s\S]*?)^\]/m)?.[1];

    for (const [name, keys] of [
        ["AccountGetWebURLRequest", ["identity", "path"]],
        ["AccountGetWebURLResult", ["url"]],
    ] as const) {
        it(`keeps ${name} private without changing its wire keys`, () => {
            const declaration = source.match(
                new RegExp(`^class _${name}:\\n[\\s\\S]*?(?=^class )`, "m")
            )?.[0];
            expect(declaration).toBeDefined();
            expect(source).not.toMatch(new RegExp(`^class ${name}\\b`, "m"));
            expect(exports).toBeDefined();
            expect(exports).not.toContain(`"${name}"`);
            expect(exports).not.toContain(`"_${name}"`);
            for (const key of keys) {
                expect(declaration).toContain(`obj.get("${key}")`);
                expect(declaration).toContain(`result["${key}"]`);
            }
        });
    }
});

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONSchema7 } from "json-schema";
import { describe, it, onTestFinished } from "vitest";
import { generateRpcCode } from "../../scripts/codegen/rust.ts";
import { renderRpcWrappers } from "../../java/scripts/codegen/java.ts";
import type { ApiSchema } from "../../scripts/codegen/utils.ts";

function schema(): ApiSchema {
    const request = { $ref: "#/definitions/ModelsListRequest" };
    const optionalRequest: JSONSchema7 = {
        title: "ModelsListRequest",
        anyOf: [
            { not: {} },
            {
                type: "object",
                properties: {
                    selectionId: { type: "string" },
                    gitHubToken: { type: "string" },
                },
                additionalProperties: false,
            },
        ],
    };
    return {
        definitions: {
            ModelsListRequest: optionalRequest,
        },
        server: {
            models: {
                list: { rpcMethod: "models.list", params: request, result: { type: "null" } },
                listTokenPriceUnits: {
                    rpcMethod: "models.listTokenPriceUnits",
                    params: optionalRequest,
                    result: { type: "null" },
                },
            },
        },
    };
}

describe("optional server request codegen", () => {
    it("keeps Rust default and explicit request entry points", ({ expect }) => {
        const code = generateRpcCode(schema());
        expect(code).toContain("async fn list_token_price_units(&self)");
        expect(code).toContain(
            "async fn list_token_price_units_with_params(&self, params: ModelsListRequest)"
        );
        expect(code).toContain("async fn list(&self)");
        expect(code).toContain("async fn list_with_params(&self, params: ModelsListRequest)");
    });

    it("keeps Java default and explicit request overloads", async ({ expect }) => {
        const files = await renderRpcWrappers(schema());
        const code = files.get(
            "sdk/src/generated/java/com/github/copilot/generated/rpc/ServerModelsApi.java"
        );
        expect(code).toBeDefined();
        expect(code).toContain("listTokenPriceUnits()");
        expect(code).toContain("listTokenPriceUnits(ModelsListTokenPriceUnitsParams params)");
        expect(code).toContain("list(ModelsListParams params)");
    });

    it("keeps TypeScript requests optional without changing the shared-type caller", async ({
        expect,
    }) => {
        const root = await mkdtemp(join(tmpdir(), "copilot-optional-server-"));
        onTestFinished(() => rm(root, { recursive: true, force: true }));
        const codegenRoot = fileURLToPath(new URL("../../scripts/codegen", import.meta.url));
        const apiPath = join(root, "api.schema.json");
        const eventsPath = join(root, "session-events.schema.json");
        await writeFile(apiPath, JSON.stringify(schema()));
        await writeFile(
            eventsPath,
            JSON.stringify({
                definitions: {
                    SessionEvent: {
                        title: "SessionEvent",
                        anyOf: [
                            {
                                type: "object",
                                properties: { type: { type: "string", const: "test" } },
                                required: ["type"],
                            },
                        ],
                    },
                },
            })
        );
        const result = spawnSync(
            process.execPath,
            [
                join(codegenRoot, "node_modules", "tsx", "dist", "cli.mjs"),
                join(codegenRoot, "typescript.ts"),
                eventsPath,
                apiPath,
            ],
            {
                cwd: codegenRoot,
                encoding: "utf8",
                timeout: 30_000,
                env: { ...process.env, COPILOT_CODEGEN_OUTPUT_ROOT: root },
            }
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const code = await readFile(join(root, "nodejs/src/generated/rpc.ts"), "utf8");
        expect(code).toContain(
            "listTokenPriceUnits: async (params?: ModelsListTokenPriceUnitsRequest)"
        );
        expect(code).toContain("export interface ModelsListTokenPriceUnitsRequest {");
        expect(code).toContain("selectionId?: string;");
        expect(code).toContain("gitHubToken?: string;");
        expect(code).toContain("list: async (params: ModelsListRequest)");
        expect(code).toContain('connection.sendRequest("models.listTokenPriceUnits", params)');
    });
});

import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";

import {
    generateRpcClass,
    renderRpcTypes,
    renderRpcWrappers,
} from "../../java/scripts/codegen/java.ts";

function rpcSource(files: Map<string, string>, name: string): string {
    const source = files.get(
        `sdk/src/generated/java/com/github/copilot/generated/rpc/${name}.java`
    );
    expect(source).toBeDefined();
    return source!;
}

describe("java RPC primitive results", () => {
    it.each([
        ["boolean", "Boolean"],
        ["integer", "Long"],
        ["number", "Double"],
        ["string", "String"],
    ] as const)("preserves inline and referenced %s results", async (type, javaType) => {
        const schema = {
            server: {
                sample: {
                    inline: {
                        rpcMethod: "sample.inline",
                        params: null,
                        result: { type },
                    },
                    referenced: {
                        rpcMethod: "sample.referenced",
                        visibility: "internal",
                        params: null,
                        result: { $ref: "#/definitions/ScalarResult" },
                    },
                    empty: { rpcMethod: "sample.empty", params: null, result: null },
                },
            },
            definitions: { ScalarResult: { type } },
        } satisfies Parameters<typeof renderRpcWrappers>[0];
        const code = rpcSource(await renderRpcWrappers(schema), "ServerSampleApi");

        expect(code).toContain(`CompletableFuture<${javaType}> inline()`);
        expect(code).toContain(`"sample.inline", java.util.Map.of(), ${javaType}.class`);
        expect(code).toContain(`CompletableFuture<${javaType}> referenced()`);
        expect(code).toContain(`"sample.referenced", java.util.Map.of(), ${javaType}.class`);
        expect(code).toContain("CompletableFuture<Void> empty()");
        expect(code).toContain('"sample.empty", java.util.Map.of(), Void.class');
    });
});

it("preserves boolean-map RPC results without widening them to JsonNode", async () => {
    const files = await renderRpcWrappers({
        server: {
            sample: {
                flags: {
                    rpcMethod: "sample.flags",
                    params: null,
                    result: { type: "object", additionalProperties: { type: "boolean" } },
                },
                document: {
                    rpcMethod: "sample.document",
                    params: null,
                    result: { type: "object", additionalProperties: true },
                },
            },
        },
    });
    const source = rpcSource(files, "ServerSampleApi");
    expect(source).toContain("import java.util.Map;");
    expect(source).toContain("CompletableFuture<Map<String, Boolean>> flags()");
    expect(source).toContain("constructMapType(Map.class, String.class, Boolean.class)");
    expect(source).toContain("CompletableFuture<JsonNode> document()");
});

describe("Java required opaque JSON parameters", () => {
    it.each([
        ["user", "applyTopKey"],
        ["repo", "writeKey"],
    ])("preserves optional value presence in %s.settings.%s", async (namespace, action) => {
        const rpcMethod = `${namespace}.settings.${action}`;
        const files = await renderRpcWrappers({
            server: {
                [namespace]: {
                    settings: {
                        [action]: {
                            rpcMethod,
                            params: {
                                type: "object",
                                properties: {
                                    value: { "x-opaque-json": true } as JSONSchema7,
                                    delete: { type: "boolean" },
                                },
                            },
                            result: null,
                        },
                    },
                },
            },
        });
        const source = rpcSource(
            files,
            `Server${namespace === "user" ? "User" : "Repo"}SettingsApi`
        );
        expect(source).toContain(`return caller.invoke("${rpcMethod}", params, Void.class);`);
        expect(source).not.toContain('putNull("value")');
    });

    it("preserves a required JSON null without emitting absent optional fields", () => {
        const opaque = { "x-opaque-json": true } as JSONSchema7;
        const { code } = generateRpcClass(
            "SettingsUpdateParams",
            {
                type: "object",
                required: ["value"],
                properties: {
                    value: opaque,
                    optionalValue: opaque,
                },
            },
            new Map(),
            "com.github.copilot.generated.rpc",
            "internal",
            true
        );
        expect(code).toContain(
            '@JsonInclude(JsonInclude.Include.ALWAYS)\n    @JsonProperty("value") Object value'
        );
        expect(code).not.toContain(
            '@JsonInclude(JsonInclude.Include.ALWAYS)\n    @JsonProperty("optionalValue")'
        );
    });
});

describe("java RPC codegen visibility", () => {
    const schema = {
        server: {
            publicOnly: {
                get: {
                    rpcMethod: "publicOnly.get",
                    params: { $ref: "#/definitions/PublicOnlyRequest" },
                    result: { $ref: "#/definitions/PublicOnlyResult" },
                },
            },
            mixed: {
                visible: {
                    rpcMethod: "mixed.visible",
                    params: null,
                    result: { $ref: "#/definitions/SharedResult" },
                },
                hidden: {
                    rpcMethod: "mixed.hidden",
                    visibility: "internal",
                    params: { $ref: "#/definitions/InternalOnlyRequest" },
                    result: { $ref: "#/definitions/InternalOnlyResult" },
                },
            },
            internalOnly: {
                hidden: {
                    rpcMethod: "internalOnly.hidden",
                    visibility: "internal",
                    params: { $ref: "#/definitions/InternalOnlyRequest" },
                    result: { $ref: "#/definitions/InternalOnlyResult" },
                },
            },
        },
        definitions: {
            PublicOnlyRequest: {
                type: "object",
                properties: { value: { type: "string" } },
            },
            PublicOnlyResult: {
                type: "object",
                properties: { shared: { $ref: "#/definitions/SharedResult" } },
            },
            SharedResult: {
                type: "object",
                properties: { ok: { type: "boolean" } },
            },
            InternalOnlyRequest: {
                type: "object",
                properties: { secret: { type: "string" } },
            },
            InternalOnlyResult: {
                type: "object",
                properties: { secret: { type: "string" } },
            },
        },
    } satisfies Parameters<typeof renderRpcTypes>[0];

    it("keeps internal-only RPC types package-private", async () => {
        const files = await renderRpcTypes(schema, {});

        expect(rpcSource(files, "PublicOnlyGetParams")).toContain(
            "public record PublicOnlyGetParams("
        );
        expect(rpcSource(files, "SharedResult")).toContain("public record SharedResult(");
        expect(rpcSource(files, "MixedHiddenParams")).toContain("record MixedHiddenParams(");
        expect(rpcSource(files, "MixedHiddenParams")).not.toContain(
            "public record MixedHiddenParams("
        );
        expect(rpcSource(files, "InternalOnlyResult")).toContain("record InternalOnlyResult(");
        expect(rpcSource(files, "InternalOnlyResult")).not.toContain(
            "public record InternalOnlyResult("
        );
    });

    it("does not expose internal methods or namespaces through public Java members", async () => {
        const files = await renderRpcWrappers(schema);

        expect(rpcSource(files, "ServerRpc")).toContain(
            "public final ServerPublicOnlyApi publicOnly;"
        );
        expect(rpcSource(files, "ServerRpc")).toContain("public final ServerMixedApi mixed;");
        expect(rpcSource(files, "ServerRpc")).toContain(
            "final ServerInternalOnlyApi internalOnly;"
        );
        expect(rpcSource(files, "ServerRpc")).not.toContain(
            "public final ServerInternalOnlyApi internalOnly;"
        );

        expect(rpcSource(files, "ServerMixedApi")).toContain("public final class ServerMixedApi");
        expect(rpcSource(files, "ServerMixedApi")).toContain(
            "public CompletableFuture<MixedVisibleResult> visible()"
        );
        expect(rpcSource(files, "ServerMixedApi")).toContain(
            "CompletableFuture<InternalOnlyResult> hidden(MixedHiddenParams params)"
        );
        expect(rpcSource(files, "ServerMixedApi")).not.toContain(
            "public CompletableFuture<InternalOnlyResult> hidden"
        );

        expect(rpcSource(files, "ServerInternalOnlyApi")).toContain(
            "final class ServerInternalOnlyApi"
        );
        expect(rpcSource(files, "ServerInternalOnlyApi")).not.toContain(
            "public final class ServerInternalOnlyApi"
        );
    });

    it("reuses a shared result definition for internal methods", async () => {
        const sharedResultSchema = {
            server: {
                globalState: {
                    load: {
                        rpcMethod: "globalState.load",
                        visibility: "internal",
                        params: null,
                        result: { $ref: "#/definitions/GlobalStateLoadResult" },
                    },
                    loadForConfigDir: {
                        rpcMethod: "globalState.loadForConfigDir",
                        visibility: "internal",
                        params: null,
                        result: { $ref: "#/definitions/GlobalStateLoadResult" },
                    },
                },
            },
            definitions: {
                GlobalStateLoadResult: {
                    type: "object",
                    properties: { staff: { type: "boolean" } },
                },
            },
        } satisfies Parameters<typeof renderRpcTypes>[0];
        const types = await renderRpcTypes(sharedResultSchema, {});
        const wrappers = await renderRpcWrappers(sharedResultSchema);

        expect(rpcSource(wrappers, "ServerGlobalStateApi")).toContain(
            "CompletableFuture<GlobalStateLoadResult> loadForConfigDir()"
        );
        expect(rpcSource(wrappers, "ServerGlobalStateApi")).toContain(
            "CompletableFuture<GlobalStateLoadResult> load()"
        );
        expect(rpcSource(types, "GlobalStateLoadResult")).not.toContain(
            "public record GlobalStateLoadResult("
        );
        expect(
            types.has(
                "sdk/src/generated/java/com/github/copilot/generated/rpc/GlobalStateLoadForConfigDirResult.java"
            )
        ).toBe(false);
    });
});

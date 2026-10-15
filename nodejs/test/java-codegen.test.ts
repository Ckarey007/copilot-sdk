/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { JSONSchema7 } from "json-schema";

import {
    buildNamespaceTree,
    collectDirectDiscriminatedUnionTypeNames,
    collectNestedDiscriminatedUnionTypeNames,
    generateApiMethod,
    extractEventVariants,
    generateRpcClass,
    isMainModule,
    renderEventVariantClass,
    renderRpcTypes,
    renderRpcWrappers,
    renderSessionEvents,
    schemaTypeToJava,
} from "../../java/scripts/codegen/java.ts";
import { RPC_VARIANT_OWNERS } from "../../java/scripts/codegen/rpc-variant-owners.ts";
import {
    eventFixture,
    metadataFixture,
    optionalRequestFixture,
    rpcFixture,
    unionFixture,
    booleanUnionFixture,
    eventMatrixFixture,
    eventMatrixVariants,
    jsonShapesFixture,
    namingFixture,
    nestedUnionFixture,
    presenceFixture,
    referenceFixture,
    visibilityFixture,
} from "./codegen-fixtures.ts";

describe("Java shared schema baseline", () => {
    it("renders types, server/session calls, and nested namespaces", async () => {
        const types = await renderRpcTypes(rpcFixture(), {});
        const wrappers = await renderRpcWrappers(rpcFixture());
        const item = rpcSource(types, "SampleItem");
        for (const field of [
            '@JsonProperty("id") String id',
            '@JsonProperty("count") Long count',
            '@JsonProperty("active") Boolean active',
            '@JsonProperty("score") Double score',
            '@JsonProperty("tags") List<String> tags',
            '@JsonProperty("labels") Map<String, String> labels',
            '@JsonProperty("displayName") String displayName',
            '@JsonProperty("note") String note',
        ])
            expect(item).toContain(field);
        expect(rpcSource(types, "SampleNestedListResult")).toContain("List<SampleItem> items");
        const server = rpcSource(wrappers, "ServerSampleApi");
        expect(server).toContain('caller.invoke("sample.get", params, SampleGetResult.class)');
        expect(server).toContain("CompletableFuture<Void> ping()");
        expect(rpcSource(wrappers, "ServerSampleNestedApi")).toContain('"sample.nested.list"');
        const session = rpcSource(wrappers, "SessionSampleApi");
        expect(session).toContain('_p.put("sessionId", this.sessionId);');
        expect(session).toContain(
            'caller.invoke("session.sample.get", _p, SessionSampleGetResult.class)'
        );
        expect(session).toContain("get(SessionSampleGetParams params)");
        expect(
            Object.fromEntries([...types, ...wrappers].sort(([a], [b]) => a.localeCompare(b)))
        ).toMatchSnapshot();
    });

    it("renders overloads for absent and optional request parameters", async () => {
        const types = await renderRpcTypes(optionalRequestFixture(), {});
        const wrappers = await renderRpcWrappers(optionalRequestFixture());
        expect(rpcSource(types, "SampleConfigureParams")).toContain(
            '@JsonProperty("enabled") Boolean enabled'
        );
        const code = rpcSource(wrappers, "ServerSampleApi");
        expect(code).toContain("CompletableFuture<Void> configure()");
        expect(code).toContain("CompletableFuture<Void> configure(SampleConfigureParams params)");
        expect(code).toContain(
            'caller.invoke("sample.configure", params == null ? java.util.Map.of() : params, Void.class)'
        );
    });

    it.each(["anyOf", "oneOf"] as const)(
        "preserves open nested %s unions as JSON-compatible objects",
        async (keyword) => {
            const types = await renderRpcTypes(unionFixture(keyword), {});
            const code = rpcSource(types, "SampleChooseResult");
            expect(code).toContain('@JsonProperty("choice") Object choice');
            expect(code).toContain('@JsonProperty("choices") List<Object> choices');
            expect(code).toContain('FAST("fast")');
            expect(code).toContain('THOROUGH("thorough")');
        }
    );

    it("preserves experimental and deprecated method annotations", async () => {
        const wrappers = await renderRpcWrappers(metadataFixture());
        const code = rpcSource(wrappers, "ServerSampleApi");
        expect(code).toContain(
            "@CopilotExperimental\n    public CompletableFuture<SamplePreviewResult> preview()"
        );
        expect(code).toContain("@Deprecated\n    public CompletableFuture<Void> retired()");
        expect(code).toContain('caller.invoke("sample.preview"');
    });

    it("renders event payload records and wire discriminators", async () => {
        const files = await renderSessionEvents(eventFixture());
        const code = eventSource(files, "SampleUpdatedEvent");
        expect(code).toContain('public String getType() { return "sample.updated"; }');
        expect(code).toContain("public record SampleUpdatedEventData(");
        expect(code).toContain('@JsonProperty("sequence") Long sequence');
        expect(code).toContain('@JsonProperty("note") String note');
        const base = eventSource(files, "SessionEvent");
        expect(base).toContain(
            '@JsonSubTypes.Type(value = SampleUpdatedEvent.class, name = "sample.updated")'
        );
        expect(base).toContain("defaultImpl = UnknownSessionEvent.class");
        expect(base).toContain("SampleUpdatedEvent,\n        UnknownSessionEvent");
        expect(eventSource(files, "UnknownSessionEvent")).toContain(
            "public String getType() { return type; }"
        );
        expect(
            Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)))
        ).toMatchSnapshot();
    });

    it("keeps existing signatures when a response gains an optional field", async () => {
        const before = await renderRpcWrappers(rpcFixture());
        const after = await renderRpcWrappers(rpcFixture({ extra: { type: "string" } }));
        expect(after).toEqual(before);
        const beforeTypes = await renderRpcTypes(rpcFixture(), {});
        const afterTypes = await renderRpcTypes(rpcFixture({ extra: { type: "string" } }), {});
        expect(rpcSource(beforeTypes, "SampleItem")).not.toContain("String extra");
        expect(rpcSource(afterTypes, "SampleItem")).toContain(
            '@JsonProperty("extra") String extra'
        );
    });
});

describe("Java schema contract matrix", () => {
    it.each([
        ["scalar", "String"],
        ["object", "PresenceValue"],
        ["array", "List<PresenceValue>"],
        ["map", "Map<String, PresenceValue>"],
    ] as const)(
        "preserves %s record component types for every presence/nullability combination",
        async (shape, type) => {
            const files = await renderRpcTypes(presenceFixture(shape), {});
            const code = rpcSource(files, "SamplePresenceResult");
            const record = code.match(/^public record SamplePresenceResult\([\s\S]*?^\)/m)?.[0];
            for (const name of [
                "requiredValue",
                "optionalValue",
                "requiredNullable",
                "optionalNullable",
            ])
                expect(record).toContain(`@JsonProperty("${name}") ${type} ${name}`);
            expect(code).toContain("@JsonInclude(JsonInclude.Include.NON_NULL)");
        }
    );

    it("shares multi-hop records across requests, results, arrays, and maps", async () => {
        const files = await renderRpcTypes(referenceFixture(), {});
        for (const name of ["SampleGraphParams", "SampleGraphResult"]) {
            const code = rpcSource(files, name);
            expect(code).toContain('@JsonProperty("first") ReferenceNode first');
            expect(code).toContain('@JsonProperty("second") ReferenceNode second');
            expect(code).toContain('@JsonProperty("nodes") List<ReferenceNode> nodes');
            expect(code).toContain('@JsonProperty("lookup") Map<String, ReferenceNode> lookup');
        }
        expect(rpcSource(files, "ReferenceNode")).toContain(
            '@JsonProperty("leaf") ReferenceLeaf leaf'
        );
        expect(rpcSource(files, "ReferenceLeaf")).toContain('@JsonProperty("code") String code');
        expect(
            [...files.keys()]
                .filter((file) => path.basename(file).startsWith("Reference"))
                .map((file) => path.basename(file))
                .sort()
        ).toEqual(["ReferenceLeaf.java", "ReferenceNode.java"]);
    });

    it("preserves empty and open objects as maps and opaque JSON as Object", async () => {
        const files = await renderRpcTypes(jsonShapesFixture(), {});
        const code = rpcSource(files, "SampleJsonResult");
        expect(code).toContain('@JsonProperty("empty") Map<String, Object> empty');
        expect(code).toContain('@JsonProperty("open") Map<String, Object> open');
        expect(code).toContain('@JsonProperty("opaque") Object opaque');
        expect(code).not.toContain("JsonShapesEmpty");
    });

    it.each(["anyOf", "oneOf"] as const)(
        "preserves JSON-compatible nested %s fallbacks when a variant is added",
        async (keyword) => {
            const before = await renderRpcTypes(nestedUnionFixture(keyword), {});
            const after = await renderRpcTypes(nestedUnionFixture(keyword, true), {});
            const code = rpcSource(before, "SampleDecideResult");
            expect(code).toContain('@JsonProperty("selected") Object selected');
            expect(code).toContain('@JsonProperty("decisions") Map<String, Object> decisions');
            expect(code).not.toContain("Verdict");
            expect(after).toEqual(before);
        }
    );

    it("registers both boolean-discriminated result variants and their payloads", async () => {
        const files = await renderRpcTypes(booleanUnionFixture(), {});
        const base = rpcSource(files, "EnqueueCommandResult");
        expect(base).toContain('property = "queued", visible = true');
        expect(base).toContain(
            '@JsonSubTypes.Type(value = EnqueueCommandResultTrue.class, name = "true")'
        );
        expect(base).toContain(
            '@JsonSubTypes.Type(value = EnqueueCommandResultFalse.class, name = "false")'
        );
        expect(rpcSource(files, "EnqueueCommandResultTrue")).toContain(
            '@JsonProperty("value")\n    private String value;'
        );
        expect(rpcSource(files, "EnqueueCommandResultFalse")).toContain(
            '@JsonProperty("reason")\n    private String reason;'
        );
    });

    describe("known defect: boolean discriminators retain boolean wire values", () => {
        let base: string;
        let variants: Record<"True" | "False", string>;

        beforeAll(async () => {
            const files = await renderRpcTypes(booleanUnionFixture(), {});
            base = rpcSource(files, "EnqueueCommandResult");
            variants = {
                True: rpcSource(files, "EnqueueCommandResultTrue"),
                False: rpcSource(files, "EnqueueCommandResultFalse"),
            };
        });

        it.fails("uses a boolean base getter", () => {
            expect(base).toMatch(/public abstract (?:boolean|Boolean) getQueued\(\);/);
        });

        it.fails.each([
            ["True", true],
            ["False", false],
        ] as const)("stores a boolean in the %s variant", (name, value) => {
            expect(variants[name]).toMatch(
                new RegExp(`private final (?:boolean|Boolean) queued = ${value};`)
            );
        });

        it.fails.each(["True", "False"] as const)("uses a boolean %s variant getter", (name) => {
            expect(variants[name]).toMatch(
                /public (?:boolean|Boolean) getQueued\(\) \{ return queued; \}/
            );
        });
    });

    it("escapes Java keywords and retains exact wire names for normalized identifiers", async () => {
        const files = await renderRpcTypes(namingFixture(), {});
        const code = rpcSource(files, "SampleNamesResult");
        for (const field of [
            '@JsonProperty("class") String class_',
            '@JsonProperty("default") Boolean default_',
            '@JsonProperty("type") String type',
            '@JsonProperty("requestId") String requestId',
            '@JsonProperty("content-type") String contentType',
        ])
            expect(code).toContain(field);
        expect(code).not.toMatch(/\bString class[,)]/);
        expect(code).not.toMatch(/\bBoolean default[,)]/);
    });

    it("restricts internal host methods without duplicating shared dependencies", async () => {
        const files = await renderRpcTypes(visibilityFixture(), {});
        const wrappers = await renderRpcWrappers(visibilityFixture());
        const host = rpcSource(wrappers, "ServerHostApi");
        expect(host).toContain("public CompletableFuture<HostVisibleResult> visible()");
        expect(host).toContain("\n    CompletableFuture<PrivateResult> secret()");
        expect(host).not.toContain("public CompletableFuture<PrivateResult>");
        expect(host).toContain('caller.invoke("host.secret"');
        expect(rpcSource(files, "SampleVisibleResult")).toContain(
            '@JsonProperty("shared") SharedValue shared'
        );
        expect(rpcSource(files, "PrivateResult")).toContain(
            '@JsonProperty("shared") SharedValue shared'
        );
        expect(rpcSource(files, "PrivateResult")).toContain(
            '@JsonProperty("detail") SecretLeaf detail'
        );
        expect(rpcSource(files, "PrivateResult")).not.toContain("public record PrivateResult(");
        expect(rpcSource(files, "SharedValue")).toContain("public record SharedValue(");
        expect(
            [...files.keys()]
                .filter((file) => path.basename(file).startsWith("SharedValue"))
                .map((file) => path.basename(file))
        ).toEqual(["SharedValue.java"]);
    });

    it("registers each empty, object, and raw-union event payload without losing its discriminator", async () => {
        const variants = eventMatrixVariants();
        const files = await renderSessionEvents(eventMatrixFixture());
        const code = variants.map((variant) => eventSource(files, variant.className));
        const base = eventSource(files, "SessionEvent");
        expect(
            [...base.matchAll(/@JsonSubTypes.Type\(value = (\w+)\.class, name = "([^"]+)"\)/g)].map(
                (match) => [match[1], match[2]]
            )
        ).toEqual([
            ["MatrixEmptyEvent", "matrix.empty"],
            ["MatrixValueEvent", "matrix.value"],
            ["MatrixUnionEvent", "matrix.union"],
        ]);
        expect(base).toContain("defaultImpl = UnknownSessionEvent.class");
        expect(files.size).toBe(5);
        for (let i = 0; i < variants.length; i++) {
            const { className, typeName } = variants[i];
            expect(code[i]).toContain(`public String getType() { return "${typeName}"; }`);
            expect(code[i]).toContain(`private ${className}Data data;`);
            expect(code[i]).toContain(`public ${className}Data getData() { return data; }`);
            expect(base).toContain(`        ${className},`);
        }
        expect(code[0]).toContain("public record MatrixEmptyEventData()");
        expect(code[1]).toContain('@JsonProperty("sequence") Long sequence');
        expect(code[2]).toContain("public record MatrixUnionEventData(JsonNode raw)");
        expect(code[2]).toContain("@JsonCreator(mode = JsonCreator.Mode.DELEGATING)");
        expect(code[2]).toContain("@JsonValue\n        public JsonNode raw() { return raw; }");
    });

    it("does not retain type ownership or imports between unrelated schemas", async () => {
        const before = await renderRpcTypes(referenceFixture(), {});
        const wrappers = await renderRpcWrappers(referenceFixture());
        const events = await renderSessionEvents(eventFixture());
        await renderRpcTypes(namingFixture(), {});
        await renderRpcWrappers(nestedUnionFixture("oneOf", true));
        await renderSessionEvents(eventMatrixFixture());
        expect(await renderRpcTypes(referenceFixture(), {})).toEqual(before);
        expect(await renderRpcWrappers(referenceFixture())).toEqual(wrappers);
        expect(await renderSessionEvents(eventFixture())).toEqual(events);
    });

    it("does not inherit RPC union promotion when rendering the same event again", async () => {
        const definitions: Record<string, JSONSchema7> = {
            CrossRenderChoice: {
                anyOf: ["first", "second"].map((kind) => ({
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string", const: kind },
                        value: { type: "string" },
                    },
                    required: ["kind", "value"],
                })),
            },
            CrossRenderResult: {
                anyOf: ["success", "error"].map((kind) => ({
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string", const: kind },
                        choices: {
                            type: "array",
                            items: { $ref: "#/definitions/CrossRenderChoice" },
                        },
                    },
                    required: ["kind", "choices"],
                })),
            },
        };
        const events: JSONSchema7 = {
            definitions: {
                ...definitions,
                SessionEvent: {
                    anyOf: [
                        {
                            type: "object",
                            properties: {
                                type: { const: "sample.choice" },
                                data: {
                                    type: "object",
                                    properties: {
                                        choice: { $ref: "#/definitions/CrossRenderChoice" },
                                    },
                                    required: ["choice"],
                                },
                            },
                            required: ["type", "data"],
                        },
                    ],
                },
            },
        };
        const before = await renderSessionEvents(structuredClone(events));
        expect(eventSource(before, "SampleChoiceEvent")).toContain(
            '@JsonProperty("choice") Object choice'
        );

        const rpc = await renderRpcTypes(
            {
                definitions,
                server: {
                    choices: {
                        rpcMethod: "sample.choices",
                        params: null,
                        result: { $ref: "#/definitions/CrossRenderResult" },
                    },
                },
            },
            {}
        );
        expect(rpcSource(rpc, "CrossRenderChoice")).toContain(
            "public abstract class CrossRenderChoice"
        );

        expect(await renderSessionEvents(structuredClone(events))).toEqual(before);
    });

    it.each(["#/definitions/", "session-events.schema.json#/definitions/"])(
        "reuses emitted event types in RPC fields referenced through %s",
        async (prefix) => {
            onTestFinished(async () => {
                await renderRpcTypes({}, {});
            });
            const context: JSONSchema7 = {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
            };
            const events: JSONSchema7 = {
                definitions: {
                    ManagedPermissionsContext: context,
                    SessionEvent: {
                        anyOf: [
                            {
                                type: "object",
                                properties: {
                                    type: { const: "sample.context" },
                                    data: {
                                        type: "object",
                                        properties: {
                                            context: {
                                                $ref: "#/definitions/ManagedPermissionsContext",
                                            },
                                        },
                                        required: ["context"],
                                    },
                                },
                                required: ["type", "data"],
                            },
                        ],
                    },
                },
            };
            const eventFiles = await renderSessionEvents(structuredClone(events));
            expect(eventSource(eventFiles, "ManagedPermissionsContext")).toContain(
                '@JsonProperty("label") String label'
            );
            const payload: JSONSchema7 = {
                type: "object",
                properties: { context: { $ref: `${prefix}ManagedPermissionsContext` } },
                required: ["context"],
            };
            const api = {
                definitions: { ManagedPermissionsContext: context },
                server: {
                    sample: {
                        context: {
                            rpcMethod: "sample.context",
                            params: payload,
                            result: payload,
                        },
                    },
                },
            };
            const files = await renderRpcTypes(api, {}, events);
            const eventImport = "import com.github.copilot.generated.ManagedPermissionsContext;";
            for (const name of ["SampleContextParams", "SampleContextResult"]) {
                const code = rpcSource(files, name);
                expect(code).toContain(eventImport);
                expect(code).toContain(
                    '@JsonProperty("context") ManagedPermissionsContext context'
                );
            }
            expect(
                [...files.keys()].some((file) => file.endsWith("/ManagedPermissionsContext.java"))
            ).toBe(false);

            const withoutSchema = await renderRpcTypes(api, {});
            expect(rpcSource(withoutSchema, "SampleContextResult")).not.toContain(eventImport);

            await renderSessionEvents(eventFixture());
            const withoutEventType = await renderRpcTypes(api, {}, events);
            expect(rpcSource(withoutEventType, "SampleContextResult")).not.toContain(eventImport);
        }
    );
});

function eventSource(files: Map<string, string>, name: string): string {
    const source = files.get(`sdk/src/generated/java/com/github/copilot/generated/${name}.java`);
    assert.ok(source, `missing ${name}.java`);
    return source;
}

it("managed permission contexts share the session-event model in RPC inputs and outputs", () => {
    const generated = "../../java/sdk/src/generated/java/com/github/copilot/generated/";
    for (const name of [
        "ManagedSettingsResolveResult",
        "ManagedSettingsPermissionsEvaluateParams",
    ]) {
        const source = fs.readFileSync(
            new URL(`${generated}rpc/${name}.java`, import.meta.url),
            "utf8"
        );
        expect(source).toMatch(
            /import com\.github\.copilot\.generated\.ManagedPermissionsContext;/
        );
        expect(source).toMatch(/ManagedPermissionsContext (?:context|permissionsContext)/);
    }
    expect(
        fs.existsSync(new URL(`${generated}rpc/ManagedPermissionsContext.java`, import.meta.url))
    ).toBe(false);
    const event = fs.readFileSync(
        new URL(`${generated}SessionManagedSettingsResolvedEvent.java`, import.meta.url),
        "utf8"
    );
    expect(event).toMatch(/ManagedPermissionsContext permissionsContext/);
});

it("managed permission requests and results reuse one named operation and kind", async () => {
    const files = await renderRpcTypes(
        {
            definitions: {
                ManagedPermissionOperation: {
                    anyOf: [
                        {
                            type: "object",
                            properties: {
                                kind: { type: "string", const: "url" },
                                url: { type: "string" },
                            },
                            required: ["kind", "url"],
                        },
                    ],
                },
                ManagedPermissionEvaluation: {
                    type: "object",
                    properties: { operation: { $ref: "#/definitions/ManagedPermissionOperation" } },
                    required: ["operation"],
                },
            },
            server: {
                managedSettings: {
                    permissions: {
                        evaluate: {
                            rpcMethod: "managedSettings.permissions.evaluate",
                            params: {
                                type: "object",
                                properties: {
                                    operations: {
                                        type: "array",
                                        items: { $ref: "#/definitions/ManagedPermissionOperation" },
                                    },
                                },
                                required: ["operations"],
                            },
                            result: {
                                type: "object",
                                properties: {
                                    results: {
                                        type: "array",
                                        items: {
                                            $ref: "#/definitions/ManagedPermissionEvaluation",
                                        },
                                    },
                                },
                                required: ["results"],
                            },
                        },
                    },
                },
            },
        },
        {}
    );
    const operation = rpcSource(files, "ManagedPermissionOperation");
    expect(operation).toMatch(/record ManagedPermissionOperation\(/);
    expect(operation).toMatch(/ManagedPermissionOperationKind kind/);
    expect(operation).toMatch(/enum ManagedPermissionOperationKind/);
    expect(operation).toMatch(/URL\("url"\)/);
    expect(rpcSource(files, "ManagedSettingsPermissionsEvaluateParams")).toMatch(
        /List<ManagedPermissionOperation> operations/
    );
    expect(rpcSource(files, "ManagedPermissionEvaluation")).toMatch(
        /ManagedPermissionOperation operation/
    );
});

it("wrapper Javadoc preserves the operation contract ahead of parameter documentation", () => {
    const tree = buildNamespaceTree({
        reconcile: {
            rpcMethod: "session.extensions.reconcile",
            description:
                "Host-only reconciliation; method-not-found must not fall back to persistent disables.",
            params: {
                type: "object",
                description: "Identifies the target session.",
                properties: { sessionId: { type: "string" } },
                required: ["sessionId"],
            },
            result: {
                type: "object",
                properties: { extensions: { type: "array", items: { type: "string" } } },
            },
        },
    });
    const method = tree.methods.get("reconcile");
    assert.ok(method);
    const source = generateApiMethod("reconcile", method, true, "sessionId").lines.join("\n");
    expect(source).toMatch(
        /Host-only reconciliation; method-not-found must not fall back to persistent disables/
    );
    expect(source).not.toMatch(/Identifies the target session/);
});

it("host environment options preserve the legacy two-argument constructor", () => {
    const source = generateRpcClass("HostGitHubEnvironmentOptions", {
        type: "object",
        properties: {
            name: { type: "string" },
            computeId: { type: "string" },
            requireConnectionBinding: { type: ["boolean", "null"] },
        },
        required: ["name", "computeId"],
    }).code;
    expect(source).toMatch(
        /@JsonProperty\("requireConnectionBinding"\) Boolean requireConnectionBinding/
    );
    expect(source).toMatch(
        /public HostGitHubEnvironmentOptions\(\s*String name,\s*String computeId\s*\) \{\s*this\(name, computeId, null\);/s
    );
});

it("arbitrary handoff maps accept scalar and structured JSON values", () => {
    const result = schemaTypeToJava(
        { type: "object", additionalProperties: true },
        true,
        "HostCreateSessionParams",
        "config",
        new Map()
    );
    expect(result.javaType).toBe("Map<String, Object>");
    expect(result.imports.has("java.util.Map")).toBeTruthy();
});

it("host session summaries retain their experimental schema designation", async () => {
    const summary: JSONSchema7 & { stability: string } = {
        type: "object",
        stability: "experimental",
        properties: { resource: { type: "string" } },
        required: ["resource"],
    };
    const files = await renderRpcTypes(
        {
            definitions: { HostSessionSummary: summary },
            server: {
                listSessions: {
                    rpcMethod: "host.listSessions",
                    stability: "experimental",
                    params: null,
                    result: {
                        type: "object",
                        properties: {
                            sessions: {
                                type: "array",
                                items: { $ref: "#/definitions/HostSessionSummary" },
                            },
                        },
                    },
                },
            },
        },
        {}
    );
    const source = rpcSource(files, "HostSessionSummary");
    expect(source).toMatch(/import com\.github\.copilot\.CopilotExperimental;/);
    expect(source).toMatch(
        /@apiNote This type is experimental and may change in a future version\./
    );
    expect(source).toMatch(/@CopilotExperimental/);
});

it("preserves whole-event deprecation through a referenced event envelope", () => {
    const schema: JSONSchema7 = {
        definitions: {
            SessionEvent: { anyOf: [{ $ref: "#/definitions/LegacyEvent" }] },
            LegacyEvent: {
                type: "object",
                deprecated: true,
                properties: {
                    type: { const: "tool.execution_partial_result" },
                    data: { $ref: "#/definitions/LegacyData" },
                },
            } as JSONSchema7,
            LegacyData: { type: "object", properties: { partialOutput: { type: "string" } } },
        },
    };
    const variants = extractEventVariants(schema);
    expect(variants).toHaveLength(1);
    expect(variants[0].deprecated).toBe(true);
    expect(renderEventVariantClass(variants[0], "com.github.copilot.generated")).toMatch(
        /@Deprecated/
    );
});

it("preserves whole-event experimental stability through a referenced event envelope", () => {
    const schema: JSONSchema7 = {
        definitions: {
            SessionEvent: { anyOf: [{ $ref: "#/definitions/ExperimentalEvent" }] },
            ExperimentalEvent: {
                type: "object",
                stability: "experimental",
                properties: {
                    type: { const: "session.experimental" },
                    data: { $ref: "#/definitions/ExperimentalData" },
                },
            } as JSONSchema7,
            ExperimentalData: { type: "object", properties: { phase: { type: "string" } } },
        },
    };
    const variants = extractEventVariants(schema);
    expect(variants).toHaveLength(1);
    expect(variants[0].stability).toBe("experimental");
    const source = renderEventVariantClass(variants[0], "com.github.copilot.generated");
    expect(source).toMatch(
        /@CopilotExperimental\n(?:@[^\n]*\n)*public final class SessionExperimentalEvent\b/
    );
    expect(source).toMatch(
        /    @CopilotExperimental\n(?:    @[^\n]*\n)*    public record SessionExperimentalEventData\b/
    );
});

for (const referencedData of [false, true]) {
    for (const eventDeprecated of [false, true]) {
        for (const dataDeprecated of [false, true]) {
            it(`preserves independent payload deprecation (referenced=${referencedData}, event=${eventDeprecated}, data=${dataDeprecated})`, () => {
                const dataSchema: JSONSchema7 & { deprecated: boolean } = {
                    type: "object",
                    deprecated: dataDeprecated,
                    properties: { partialOutput: { type: "string" } },
                };
                const eventSchema: JSONSchema7 & { deprecated: boolean } = {
                    type: "object",
                    deprecated: eventDeprecated,
                    properties: {
                        type: { const: "tool.execution_partial_result" },
                        data: referencedData ? { $ref: "#/definitions/LegacyData" } : dataSchema,
                    },
                };
                const schema: JSONSchema7 = {
                    definitions: {
                        SessionEvent: { anyOf: [{ $ref: "#/definitions/LegacyEvent" }] },
                        LegacyEvent: eventSchema,
                        LegacyData: dataSchema,
                    },
                };
                const variants = extractEventVariants(schema);
                expect(variants).toHaveLength(1);
                const source = renderEventVariantClass(variants[0], "com.github.copilot.generated");
                const eventAnnotation =
                    /@Deprecated\n(?:@[^\n]*\n)*public final class ToolExecutionPartialResultEvent\b/;
                const dataAnnotation =
                    /    @Deprecated\n(?:    @[^\n]*\n)*    public record ToolExecutionPartialResultEventData\b/;
                if (eventDeprecated) expect(source).toMatch(eventAnnotation);
                else expect(source).not.toMatch(eventAnnotation);
                if (dataDeprecated) expect(source).toMatch(dataAnnotation);
                else expect(source).not.toMatch(dataAnnotation);
            });
        }
    }
}

it("preserves diagnostics configuration for session create and resume", async () => {
    const files = await renderRpcTypes(
        {
            definitions: {
                DiagnosticsConfiguration: {
                    type: "object",
                    properties: {
                        sources: { $ref: "#/definitions/DiagnosticSourcesConfiguration" },
                    },
                    required: ["sources"],
                },
                DiagnosticSourcesConfiguration: {
                    type: "object",
                    properties: { mcp: { type: "string" } },
                },
            },
        },
        {}
    );
    const configuration = [...files].find(([file]) =>
        file.endsWith("/DiagnosticsConfiguration.java")
    );
    assert.ok(configuration, "startup diagnostics must have a named generated configuration");
    expect(configuration[1]).toMatch(/DiagnosticSourcesConfiguration sources/);
    expect(
        [...files.keys()].some((file) => file.endsWith("/DiagnosticSourcesConfiguration.java"))
    ).toBeTruthy();
});

it("customization reload types are experimental without opening unrelated types", async () => {
    const files = await renderRpcTypes(
        {
            definitions: {
                CustomizationReloadStatus: { type: "string", enum: ["reloaded", "failed"] },
                CustomizationReloadSubsystem: { type: "string", enum: ["skills", "hooks"] },
                CustomizationReloadOutcome: {
                    type: "object",
                    description: "Result of one customization reload component.",
                    properties: { status: { $ref: "#/definitions/CustomizationReloadStatus" } },
                },
                ClosedStatus: { type: "string", enum: ["ready"] },
                ExampleResult: {
                    type: "object",
                    properties: {
                        status: { $ref: "#/definitions/CustomizationReloadStatus" },
                        subsystem: { $ref: "#/definitions/CustomizationReloadSubsystem" },
                        outcome: { $ref: "#/definitions/CustomizationReloadOutcome" },
                        closed: { $ref: "#/definitions/ClosedStatus" },
                    },
                },
            },
            server: {
                example: {
                    rpcMethod: "example",
                    params: null,
                    result: { $ref: "#/definitions/ExampleResult" },
                },
            },
        },
        {}
    );
    for (const name of ["CustomizationReloadStatus", "CustomizationReloadSubsystem"]) {
        const source = rpcSource(files, name);
        expect(source).toMatch(/public static final \w+ UNKNOWN = new \w+\("unknown"\);/);
        expect(source).toMatch(/if \(value != null\) return new \w+\(value\);/);
        expect(source).toMatch(/@com\.fasterxml\.jackson\.annotation\.JsonValue/);
        expect(source).toMatch(/import com\.github\.copilot\.CopilotExperimental;/);
        expect(source).toMatch(
            /@apiNote This type is experimental and may change in a future version\./
        );
        expect(source).toMatch(/@CopilotExperimental/);
    }
    const outcome = rpcSource(files, "CustomizationReloadOutcome");
    expect(outcome).toMatch(/import com\.github\.copilot\.CopilotExperimental;/);
    expect(outcome).toMatch(
        /@apiNote This type is experimental and may change in a future version\./
    );
    expect(outcome).toMatch(/@CopilotExperimental/);
    const closed = rpcSource(files, "ClosedStatus");
    expect(closed).not.toMatch(/return UNKNOWN/);
    expect(closed).not.toMatch(/@CopilotExperimental/);
});

it("recognizes an entrypoint reached through a linked directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-java-codegen-entrypoint-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceDirectory = path.join(root, "source");
    const linkedDirectory = path.join(root, "linked");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "java.ts"), "");
    fs.symlinkSync(
        sourceDirectory,
        linkedDirectory,
        process.platform === "win32" ? "junction" : "dir"
    );

    expect(
        isMainModule(path.join(linkedDirectory, "java.ts"), path.join(sourceDirectory, "java.ts"))
    ).toBe(true);
});

function renderPayload(dataSchema: JSONSchema7): string {
    return renderEventVariantClass(
        {
            typeName: "example.notification",
            className: "ExampleNotificationEvent",
            dataSchema,
        },
        "com.github.copilot.generated"
    );
}

it("experimental event properties retain their marker without marking the stable event", () => {
    const structuredContent: JSONSchema7 & { stability: string } = {
        description: "Client-only structured progress metadata.",
        stability: "experimental",
    };
    const source = renderPayload({
        type: "object",
        properties: {
            toolCallId: { type: "string" },
            progressMessage: { type: "string" },
            structuredContent,
        },
        required: ["toolCallId", "progressMessage"],
    });

    expect(source).toMatch(/import com\.github\.copilot\.CopilotExperimental;/);
    expect(source).toMatch(
        /@CopilotExperimental\s+@JsonProperty\("structuredContent"\) Object structuredContent/
    );
    expect(source.match(/@CopilotExperimental/g)).toEqual(["@CopilotExperimental"]);
    expect(source).toMatch(/@JsonProperty\("progressMessage"\) String progressMessage,/);
});

it("stable event properties do not acquire experimental markers", () => {
    const source = renderPayload({
        type: "object",
        properties: {
            progressMessage: { type: "string", description: "Experimental is ordinary text here." },
            structuredContent: { description: "Client-only structured progress metadata." },
        },
    });

    expect(source).toMatch(/@JsonProperty\("structuredContent"\) Object structuredContent/);
    expect(source).not.toMatch(/CopilotExperimental/);
});

for (const keyword of ["anyOf", "oneOf"] as const) {
    it(`root ${keyword} payload preserves raw JSON and existing data descriptors`, () => {
        const source = renderPayload({
            [keyword]: [
                {
                    type: "object",
                    properties: { kind: { const: "first" }, count: { type: "number" } },
                },
                {
                    type: "object",
                    properties: { kind: { const: "second" }, active: { type: "boolean" } },
                },
                { type: "null" },
            ],
        });

        expect(source).toMatch(/public record ExampleNotificationEventData\(JsonNode raw\)/);
        expect(source).toMatch(
            /@JsonCreator\(mode = JsonCreator\.Mode\.DELEGATING\)\s+public ExampleNotificationEventData\s*\{/
        );
        expect(source).toMatch(/@JsonValue\s+public JsonNode raw\(\) \{ return raw; \}/);
        expect(source).toMatch(
            /public ExampleNotificationEventData\(\) \{\s+this\(JsonNodeFactory\.instance\.objectNode\(\)\);/
        );
        expect(source).toMatch(/public ExampleNotificationEventData getData\(\)/);
        expect(source).toMatch(/public void setData\(ExampleNotificationEventData data\)/);
    });

    it(`root ${keyword} with only one non-null alternative is not a raw union`, () => {
        const source = renderPayload({
            [keyword]: [
                { type: "object", properties: { message: { type: "string" } } },
                { type: "null" },
                { type: ["null"] },
                { const: null },
                { enum: [null] },
            ],
        });
        expect(source).not.toMatch(/JsonNode|DELEGATING|JsonValue/);
    });
}

it("ordinary and empty root objects retain their existing records", () => {
    const source = renderPayload({
        type: "object",
        properties: { message: { type: "string" } },
    });
    expect(source).toMatch(/@JsonProperty\("message"\) String message/);
    expect(source).not.toMatch(/JsonNode|DELEGATING|JsonValue/);

    const empty = renderPayload({ type: "object", properties: {} });
    expect(empty).toMatch(/public record ExampleNotificationEventData\(\)/);
    expect(empty).not.toMatch(/JsonNode|DELEGATING|JsonValue/);
});

it("session event records preserve constructors declared by x-legacy-parameters", () => {
    const source = renderPayload({
        type: "object",
        properties: {
            before: { type: "string" },
            added: { type: ["string", "null"] },
            after: { type: "string" },
        },
        "x-legacy-parameters": ["before", "after"],
    } as JSONSchema7);

    expect(source).toMatch(
        /public ExampleNotificationEventData\(\s*String before,\s*String after\s*\) \{\s*this\(before, null, after\);/
    );
});

it("session event fields promote directly referenced discriminated response unions", () => {
    const definitions: Record<string, JSONSchema7> = {
        TypedResponse: {
            anyOf: [
                {
                    type: "object",
                    properties: {
                        responseKind: { const: "answer" },
                        answer: { type: "string" },
                    },
                    required: ["responseKind", "answer"],
                },
                {
                    type: "object",
                    properties: {
                        responseKind: { const: "decision" },
                        approved: { type: "boolean" },
                    },
                    required: ["responseKind", "approved"],
                },
            ],
        },
    };
    const dataSchema: JSONSchema7 = {
        type: "object",
        properties: {
            response: { $ref: "#/definitions/TypedResponse" },
        },
    };
    const promoted = collectDirectDiscriminatedUnionTypeNames(
        dataSchema,
        definitions,
        new Set(["TypedResponse"])
    );
    const standaloneTypes = new Map<string, JSONSchema7>();

    const result = schemaTypeToJava(
        dataSchema.properties!.response as JSONSchema7,
        false,
        "ExampleEventData",
        "response",
        new Map(),
        {
            definitions,
            standaloneTypes,
            promotedUnionTypes: promoted,
        }
    );

    expect(result.javaType).toBe("TypedResponse");
    expect(standaloneTypes.get("TypedResponse")).toBe(definitions.TypedResponse);
});

it("nested discriminated array items use their named Java type", () => {
    const definitions: Record<string, JSONSchema7> = {
        MessageResult: {
            anyOf: [
                { $ref: "#/definitions/MessageDelivered" },
                { $ref: "#/definitions/MessageRejected" },
            ],
        },
        MessageDelivered: {
            type: "object",
            additionalProperties: false,
            properties: {
                status: { const: "delivered" },
                actions: {
                    type: "array",
                    items: { $ref: "#/definitions/ActionChoice" },
                },
            },
        },
        MessageRejected: {
            type: "object",
            additionalProperties: false,
            properties: {
                status: { const: "rejected" },
                reason: { type: "string" },
            },
        },
        ActionChoice: {
            anyOf: [{ $ref: "#/definitions/PhoneAction" }, { $ref: "#/definitions/EmailAction" }],
        },
        PhoneAction: {
            type: "object",
            title: "PhoneAction",
            additionalProperties: false,
            properties: {
                kind: { const: "phone" },
                number: { type: "string" },
                sources: {
                    type: "object",
                    additionalProperties: { $ref: "#/definitions/ActionSource" },
                },
            },
        },
        EmailAction: {
            type: "object",
            title: "EmailAction",
            additionalProperties: false,
            properties: {
                kind: { const: "email" },
                address: { type: "string" },
                sources: {
                    type: "object",
                    additionalProperties: { $ref: "#/definitions/ActionSource" },
                },
            },
        },
        ActionSource: {
            anyOf: [
                { $ref: "#/definitions/LocalActionSource" },
                { $ref: "#/definitions/RemoteActionSource" },
            ],
        },
        LocalActionSource: {
            type: "object",
            title: "LocalActionSource",
            additionalProperties: false,
            properties: {
                location: { const: "local" },
            },
        },
        RemoteActionSource: {
            type: "object",
            title: "RemoteActionSource",
            additionalProperties: false,
            properties: {
                location: { const: "remote" },
                url: { type: "string" },
            },
        },
    };
    const standaloneTypes = new Map<string, JSONSchema7>();
    const promotedUnionTypes = collectNestedDiscriminatedUnionTypeNames(
        { $ref: "#/definitions/MessageResult" },
        definitions
    );

    const result = schemaTypeToJava(
        {
            type: "array",
            items: { $ref: "#/definitions/ActionChoice" },
        },
        false,
        "MessageEnvelope",
        "actions",
        new Map(),
        {
            definitions,
            standaloneTypes,
            promotedUnionTypes,
        }
    );

    expect(result.javaType).toBe("List<ActionChoice>");
    expect([...standaloneTypes.keys()]).toEqual(["ActionChoice"]);
    expect([...promotedUnionTypes]).toEqual(["ActionChoice", "ActionSource"]);
});

it("RPC records promote nested discriminated union references to sealed interfaces", async () => {
    const definitions: Record<string, JSONSchema7> = {
        InstallationConfirmationRequest: {
            type: "object",
            additionalProperties: false,
            properties: {
                review: { $ref: "#/definitions/InstallationReview" },
            },
        },
        InstallationReview: {
            anyOf: [
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        resource: { type: "string", const: "mcp" },
                        review: { $ref: "#/definitions/McpInstallationReview" },
                    },
                    required: ["resource", "review"],
                },
            ],
        },
        McpInstallationReview: {
            anyOf: [
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        action: { type: "string", const: "install" },
                        selectedChoice: { $ref: "#/definitions/McpPlanTransportChoice" },
                    },
                    required: ["action", "selectedChoice"],
                },
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        action: { type: "string", const: "uninstall" },
                        installationId: { type: "string" },
                    },
                    required: ["action", "installationId"],
                },
            ],
        },
        McpInstallPlan: {
            type: "object",
            additionalProperties: false,
            properties: {
                transportChoices: {
                    type: "array",
                    items: { $ref: "#/definitions/McpPlanTransportChoice" },
                },
            },
        },
        McpPlanTransportChoice: {
            anyOf: [
                { $ref: "#/definitions/McpPlanTransportChoicePackage" },
                { $ref: "#/definitions/McpPlanTransportChoiceRemote" },
            ],
        },
        McpPlanTransportChoicePackage: {
            type: "object",
            title: "McpPlanTransportChoicePackage",
            additionalProperties: false,
            properties: {
                installMethod: { type: "string", const: "package" },
                packageIdentifier: { type: "string" },
            },
            required: ["installMethod", "packageIdentifier"],
        },
        McpPlanTransportChoiceRemote: {
            type: "object",
            title: "McpPlanTransportChoiceRemote",
            additionalProperties: false,
            properties: {
                installMethod: { type: "string", const: "remote" },
                endpoint: { type: "string" },
            },
            required: ["installMethod", "endpoint"],
        },
        McpInstallationManagementResult: {
            anyOf: [
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string", const: "outcome" },
                        outcome: { $ref: "#/definitions/McpInstallationManagementOutcome" },
                    },
                    required: ["kind", "outcome"],
                },
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string", const: "invalid-request" },
                        message: { type: "string" },
                    },
                    required: ["kind", "message"],
                },
            ],
        },
        McpInstallationManagementOutcome: {
            anyOf: [
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string", const: "operation" },
                        operation: { $ref: "#/definitions/McpInstallationOperationStatus" },
                    },
                    required: ["kind", "operation"],
                },
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        kind: { type: "string", const: "refused" },
                        reason: { type: "string" },
                    },
                    required: ["kind", "reason"],
                },
            ],
        },
        McpInstallationOperationStatus: {
            anyOf: [
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        phase: { type: "string", const: "preparing" },
                        operationId: { type: "string" },
                    },
                    required: ["phase", "operationId"],
                },
                {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        phase: { type: "string", const: "completed" },
                        operationId: { type: "string" },
                    },
                    required: ["phase", "operationId"],
                },
            ],
        },
    };

    const files = await renderRpcTypes(
        {
            definitions,
            clientGlobal: {
                confirm: {
                    rpcMethod: "confirm",
                    params: { $ref: "#/definitions/InstallationConfirmationRequest" },
                    result: null,
                },
                plan: {
                    rpcMethod: "plan",
                    params: { $ref: "#/definitions/McpInstallPlan" },
                    result: null,
                },
            },
            server: {
                status: {
                    rpcMethod: "status",
                    params: null,
                    result: { $ref: "#/definitions/McpInstallationManagementResult" },
                },
            },
        },
        {}
    );

    expect(rpcSource(files, "InstallationConfirmationRequest")).toMatch(
        /@JsonProperty\("review"\) McpInstallationReview review/
    );
    expect(rpcSource(files, "McpInstallPlan")).toMatch(
        /@JsonProperty\("transportChoices"\) List<McpPlanTransportChoice> transportChoices/
    );
    expect(rpcSource(files, "McpInstallationManagementResultOutcome")).toMatch(
        /private McpInstallationManagementOutcome outcome/
    );
    expect(rpcSource(files, "McpInstallationManagementOutcomeOperation")).toMatch(
        /@JsonProperty\("operation"\) McpInstallationOperationStatus operation/
    );
    expect(rpcSource(files, "McpInstallationReview")).toMatch(
        /public sealed interface McpInstallationReview permits McpInstallationReviewInstall, McpInstallationReviewUninstall/
    );
    expect(rpcSource(files, "McpInstallationReview")).toMatch(
        /JsonTypeInfo\.Id\.NAME, include = JsonTypeInfo\.As\.EXISTING_PROPERTY, property = "action", visible = true/
    );
    expect(rpcSource(files, "McpInstallationReviewInstall")).toMatch(
        /public record McpInstallationReviewInstall\(/
    );
    expect(rpcSource(files, "McpInstallationReviewInstall")).toMatch(/action = "install"/);
    expect(rpcSource(files, "McpInstallationReviewInstall")).toMatch(
        /import com\.fasterxml\.jackson\.annotation\.JsonTypeInfo;/
    );
    expect(rpcSource(files, "McpInstallationReviewInstall")).toMatch(
        /@JsonTypeInfo\(use = JsonTypeInfo\.Id\.NONE\)/
    );
    expect(rpcSource(files, "McpPlanTransportChoice")).toMatch(/property = "installMethod"/);
    expect(rpcSource(files, "McpInstallationOperationStatus")).toMatch(/property = "phase"/);
});

function sharedUnionFixture(roots: string[]) {
    const definitions: Record<string, JSONSchema7> = {
        SharedError: {
            title: "SharedError",
            type: "object",
            additionalProperties: false,
            properties: { kind: { const: "error" }, message: { type: "string" } },
        },
    };
    const server: Record<string, unknown> = {};
    for (const root of roots) {
        definitions[root] = {
            anyOf: [
                { $ref: "#/definitions/SharedError" },
                {
                    type: "object",
                    additionalProperties: false,
                    properties: { kind: { const: "ok" } },
                },
            ],
        };
        server[root] = { rpcMethod: root, params: null, result: { $ref: `#/definitions/${root}` } };
    }
    return { definitions, server };
}
function rpcSource(files: Map<string, string>, name: string): string {
    const source = files.get(
        `sdk/src/generated/java/com/github/copilot/generated/rpc/${name}.java`
    );
    assert.ok(source, `missing ${name}.java`);
    return source;
}

it("instructions reload reuses getSources result without generating a duplicate Java type", async () => {
    const fixture = {
        definitions: {
            InstructionsGetSourcesResult: {
                type: "object",
                properties: { sources: { type: "array", items: { type: "string" } } },
            },
            OtherResult: {
                type: "object",
                properties: { sources: { type: "array", items: { type: "string" } } },
            },
        },
        session: {
            instructions: {
                getSources: {
                    rpcMethod: "session.instructions.getSources",
                    params: null,
                    result: { $ref: "#/definitions/InstructionsGetSourcesResult" },
                },
                reload: {
                    rpcMethod: "session.instructions.reload",
                    params: null,
                    result: { $ref: "#/definitions/InstructionsGetSourcesResult" },
                },
            },
        },
    };

    const files = await renderRpcTypes(fixture, {});
    expect(rpcSource(files, "SessionInstructionsGetSourcesResult")).toMatch(/List<String> sources/);
    expect(
        [...files.keys()].some((file) => file.endsWith("/SessionInstructionsReloadResult.java"))
    ).toBe(false);

    fixture.session.instructions.reload.result.$ref = "#/definitions/OtherResult";
    await expect(renderRpcTypes(fixture, {})).rejects.toThrow(/Incompatible Java RPC result alias/);
});

it("customizations reload uses its shared schema result name in types and wrapper", async () => {
    const fixture = {
        definitions: {
            CustomizationsReloadResult: {
                type: "object",
                properties: { warnings: { type: "array", items: { type: "string" } } },
            },
            OtherResult: {
                type: "object",
                properties: { warnings: { type: "array", items: { type: "string" } } },
            },
        },
        session: {
            customizations: {
                reload: {
                    rpcMethod: "session.customizations.reload",
                    params: null,
                    result: { $ref: "#/definitions/CustomizationsReloadResult" },
                },
            },
        },
    };

    const types = await renderRpcTypes(fixture, {});
    expect(rpcSource(types, "CustomizationsReloadResult")).toMatch(/List<String> warnings/);
    expect(
        [...types.keys()].some((file) => file.endsWith("/SessionCustomizationsReloadResult.java"))
    ).toBe(false);
    const wrappers = await renderRpcWrappers(fixture);
    expect(rpcSource(wrappers, "SessionCustomizationsApi")).toMatch(
        /CompletableFuture<CustomizationsReloadResult> reload\(/
    );

    fixture.session.customizations.reload.result.$ref = "#/definitions/OtherResult";
    await expect(renderRpcTypes(fixture, {})).rejects.toThrow(/Incompatible Java RPC result name/);
    await expect(renderRpcWrappers(fixture)).rejects.toThrow(/Incompatible Java RPC result name/);
});

it("static OAuth config preserves the legacy four-argument constructor", () => {
    const typeName = "McpOauthRequiredStaticClientConfig";
    const source = generateRpcClass(
        typeName,
        {
            type: "object",
            additionalProperties: false,
            properties: {
                clientId: { type: "string" },
                clientSecret: { type: ["string", "null"] },
                publicClient: { type: ["boolean", "null"] },
                grantType: { type: ["string", "null"] },
                scope: { type: ["string", "null"] },
            },
            required: ["clientId"],
        },
        new Map(),
        "com.github.copilot.generated"
    ).code;
    expect(source).toMatch(
        /public McpOauthRequiredStaticClientConfig\(\s*String clientId,\s*String clientSecret,\s*Boolean publicClient,\s*String grantType\s*\) \{\s*this\(clientId, clientSecret, publicClient, grantType, null\);/s
    );
});

it("nullable referenced RPC results retain their object DTO and typed wrapper", async () => {
    const method = {
        rpcMethod: "session.accounts.getCurrent",
        description: null,
        stability: "experimental",
        params: {
            type: "object",
            properties: { sessionId: { type: "string" } },
            required: ["sessionId"],
        } as JSONSchema7,
        result: { $ref: "#/definitions/SessionAccountResult" },
    };
    const files = await renderRpcTypes(
        {
            session: { accounts: { getCurrent: method } },
            definitions: {
                SessionAccountResult: {
                    title: "SessionAccountResult",
                    anyOf: [{ $ref: "#/definitions/SessionAccount" }, { type: "null" }],
                },
                SessionAccount: {
                    type: "object",
                    title: "SessionAccount",
                    additionalProperties: false,
                    properties: {
                        accountId: { type: "string" },
                        identity: { $ref: "#/definitions/Identity" },
                    },
                    required: ["accountId", "identity"],
                    stability: "experimental",
                } as JSONSchema7,
                Identity: {
                    type: "object",
                    title: "Identity",
                    properties: { login: { type: "string" } },
                    required: ["login"],
                },
            },
        },
        {}
    );
    expect(rpcSource(files, "SessionAccount")).toMatch(/public record SessionAccount\(/);
    expect(rpcSource(files, "SessionAccount")).toMatch(
        /@JsonProperty\("identity"\) Identity identity/
    );
    expect(rpcSource(files, "Identity")).toMatch(/@JsonProperty\("login"\) String login/);
    const wrapper = generateApiMethod("getCurrent", method, true, "this.sessionId").lines.join(
        "\n"
    );
    expect(wrapper).toMatch(/CompletableFuture<SessionAccount> getCurrent\(\)/);
    expect(wrapper).toMatch(
        /caller\.invoke\("session\.accounts\.getCurrent", .*SessionAccount\.class\)/
    );
    expect(wrapper).not.toMatch(/Void/);
});

it("session filesystem capabilities preserve the legacy one-argument constructor", () => {
    const source = generateRpcClass(
        "SessionFsSetProviderCapabilities",
        {
            type: "object",
            properties: {
                sqlite: { type: "boolean" },
                binary: { type: "boolean" },
            },
        },
        new Map(),
        "com.github.copilot.generated"
    ).code;
    expect(source).toMatch(
        /public SessionFsSetProviderCapabilities\(\s*Boolean sqlite\s*\) \{\s*this\(sqlite, null\);/s
    );
});

for (const roots of [
    ["FirstResult", "HistoricalResult"],
    ["FirstResult", "HistoricalResult", "LastResult"],
]) {
    it(`${roots.length} shared roots preserve historical ownership regardless of discovery order`, async () => {
        const owners = { SharedError: "HistoricalResult" };
        const fixture = sharedUnionFixture(roots);
        const files = await renderRpcTypes(fixture, owners);
        expect(rpcSource(files, "SharedError")).toMatch(
            /class SharedError extends HistoricalResult/
        );
        for (const root of roots.filter((name) => name !== "HistoricalResult")) {
            expect(rpcSource(files, `${root}SharedError`)).toMatch(
                new RegExp(`class ${root}SharedError extends ${root}`)
            );
            expect(rpcSource(files, root)).toMatch(
                new RegExp(`value = ${root}SharedError.class, name = "error"`)
            );
        }
        const reversed = sharedUnionFixture([...roots].reverse());
        reversed.definitions = Object.fromEntries(Object.entries(reversed.definitions).reverse());
        expect([...(await renderRpcTypes(reversed, owners))].sort()).toEqual([...files].sort());
        for (const root of roots) reversed.definitions[root].anyOf?.reverse();
        const reordered = await renderRpcTypes(reversed, owners);
        for (const [file, source] of files) {
            const updated = reordered.get(file);
            assert.ok(updated);
            // Membership ordering is not API identity; retain the schema's
            // annotation order without changing ownership or output names.
            expect(
                updated
                    .split("\n")
                    .map((line) => line.replace(/,$/, ""))
                    .sort()
            ).toEqual(
                source
                    .split("\n")
                    .map((line) => line.replace(/,$/, ""))
                    .sort()
            );
        }
    });
}

it("RPC planning rejects unregistered shared ownership and missing historical owners", async () => {
    const fixture = sharedUnionFixture(["FirstResult", "SecondResult"]);
    await expect(renderRpcTypes(fixture, {})).rejects.toThrow(
        /Ambiguous Java RPC owner for "SharedError"/
    );
    await expect(renderRpcTypes(fixture, { SharedError: "MissingResult" })).rejects.toThrow(
        /Missing historical Java RPC owner/
    );
    await expect(renderRpcTypes(fixture, { RemovedVariant: "FirstResult" })).rejects.toThrow(
        /Missing historical Java RPC owner/
    );
    // A failed plan must not poison the next generation.
    expect((await renderRpcTypes(fixture, { SharedError: "FirstResult" })).size > 0).toBeTruthy();
});

it("RPC planning rejects incompatible shared schemas and contextual name collisions", async () => {
    const incompatible = sharedUnionFixture(["FirstResult", "SecondResult"]);
    incompatible.definitions.SecondResult.anyOf = [
        {
            ...incompatible.definitions.SharedError,
            properties: { kind: { const: "error" }, message: { type: "number" } },
        },
        { type: "object", properties: { kind: { const: "ok" } } },
    ];
    await expect(renderRpcTypes(incompatible, { SharedError: "FirstResult" })).rejects.toThrow(
        /Incompatible schemas.*SharedError/
    );

    const collision = sharedUnionFixture(["FirstResult", "SecondResult"]);
    collision.definitions.FirstResult.anyOf?.push({
        title: "SecondResultSharedError",
        type: "object",
        properties: { kind: { const: "extra" } },
    });
    await expect(renderRpcTypes(collision, { SharedError: "FirstResult" })).rejects.toThrow(
        /Conflicting Java RPC contextual name/
    );

    const rootCollision = sharedUnionFixture(["SharedError", "SecondResult"]);
    // Avoid the fixture's self-reference: a concrete title collides with a root.
    rootCollision.definitions.SharedError.anyOf = [
        { title: "SharedError", type: "object", properties: { kind: { const: "error" } } },
        { type: "object", properties: { kind: { const: "ok" } } },
    ];
    delete rootCollision.server.SecondResult;
    await expect(renderRpcTypes(rootCollision, {})).rejects.toThrow(
        /Conflicting Java RPC variant name "SharedError"/
    );
});

it("nested standalone union memberships participate in the ownership plan", async () => {
    const fixture = sharedUnionFixture(["FirstResult", "NestedResult"]);
    delete fixture.server.NestedResult;
    fixture.definitions.SharedError.properties!.detail = {
        type: "array",
        items: { $ref: "#/definitions/NestedResult" },
    };
    const files = await renderRpcTypes(fixture, { SharedError: "FirstResult" });
    expect(rpcSource(files, "NestedResultSharedError")).toMatch(/extends NestedResult/);
    expect(rpcSource(files, "SharedError")).toMatch(/extends FirstResult/);
});

it("identical repeated root references emit each variant only once", async () => {
    const fixture = sharedUnionFixture(["FirstResult"]);
    const original = await renderRpcTypes(fixture, {});
    fixture.server.alias = {
        rpcMethod: "alias",
        params: null,
        result: { $ref: "#/definitions/FirstResult" },
    };
    expect([...(await renderRpcTypes(fixture, {}))].sort()).toEqual([...original].sort());
});

it("historical ABI registry retains the complete pre-intake ownership set", () => {
    expect(Object.keys(RPC_VARIANT_OWNERS).length).toBe(61);
    expect(new Set(Object.values(RPC_VARIANT_OWNERS)).size).toBe(12);
    for (const name of [
        "CatalogNegotiationRefusedError",
        "CatalogInvalidRequestError",
        "CatalogUnavailableError",
    ]) {
        expect(RPC_VARIANT_OWNERS[name]).toBe("CatalogSearchResult");
    }
});

type LegacyScope = "server" | "session";

/** A request published with `contract`, `source` and `scope`, then extended with optional fields. */
function legacyRequestFixture(
    additions: 0 | 1 | 2,
    scope: LegacyScope = "server",
    legacy = ["contract", "source", "scope"]
) {
    const properties: Record<string, JSONSchema7> = {
        ...(scope === "session" ? { sessionId: { type: "string" } } : {}),
        contract: { type: "string", description: "Caller contract." },
        source: { type: "string" },
        scope: { type: "string" },
    };
    if (additions >= 1) properties.policySessionId = { type: "string" };
    if (additions >= 2) properties.traceId = { type: "string" };
    const request: JSONSchema7 & Record<string, unknown> = {
        type: "object",
        properties,
        required: [...(scope === "session" ? ["sessionId"] : []), "contract", "source"],
        additionalProperties: false,
    };
    if (additions > 0) request["x-legacy-parameters"] = legacy;
    const rpcMethod = `${scope === "session" ? "session." : ""}sample.plan`;
    return {
        [scope]: {
            sample: {
                plan: {
                    rpcMethod,
                    params: { $ref: "#/definitions/SamplePlanRequest" },
                    result: {
                        type: "object",
                        properties: { ok: { type: "boolean" } },
                        required: ["ok"],
                    },
                },
            },
        },
        definitions: { SamplePlanRequest: request },
    } as Parameters<typeof renderRpcTypes>[0];
}

function generatedFile(files: Map<string, string>, className: string): string | undefined {
    return [...files].find(([file]) => file.endsWith(`/${className}.java`))?.[1];
}

async function renderLegacy(additions: 0 | 1 | 2, scope: LegacyScope = "server") {
    const fixture = legacyRequestFixture(additions, scope);
    const types = await renderRpcTypes(fixture, {});
    const wrappers = await renderRpcWrappers(fixture);
    const prefix = scope === "session" ? "Session" : "";
    return {
        params: generatedFile(types, `${prefix}SamplePlanParams`)!,
        request: generatedFile(types, "SamplePlanRequest"),
        api: generatedFile(wrappers, `${scope === "session" ? "Session" : "Server"}SampleApi`)!,
    };
}

function publicConstructor(source: string): string | undefined {
    return source.match(/public SamplePlanRequest\([^)]*\)/)?.[0];
}

it("x-legacy-parameters keeps the params record and adds a fluent request with a same-name overload", async () => {
    const original = await renderLegacy(0);
    expect(original.request, "unmarked requests keep their existing generation").toBe(undefined);
    expect(original.api).not.toMatch(/SamplePlanRequest/);

    const once = await renderLegacy(1);
    expect(once.params, "the params record keeps exactly its legacy components").toBe(
        original.params
    );
    assert.ok(once.request);
    expect(once.request).toMatch(/public final class SamplePlanRequest \{/);
    expect(publicConstructor(once.request)).toBe(
        "public SamplePlanRequest(String contract, String source)"
    );
    expect(once.request).toMatch(
        /this\.contract = Objects\.requireNonNull\(contract, "contract"\);/
    );
    expect(once.request).toMatch(/public SamplePlanRequest setScope\(String value\)/);
    expect(once.request).toMatch(/public SamplePlanRequest setPolicySessionId\(String value\)/);
    expect(once.request).toMatch(
        /@JsonProperty\("policySessionId"\)\s+private String policySessionId;/
    );
    expect(once.api).toMatch(
        /public CompletableFuture<SamplePlanResult> plan\(SamplePlanParams params\) \{\s+return caller\.invoke\("sample\.plan", params,/
    );
    expect(once.api).toMatch(
        /public CompletableFuture<SamplePlanResult> plan\(SamplePlanRequest request\) \{\s+return caller\.invoke\("sample\.plan", Objects\.requireNonNull\(request, "request"\),/
    );

    const twice = await renderLegacy(2);
    expect(twice.params, "a second optional addition leaves the record unchanged").toBe(
        original.params
    );
    expect(publicConstructor(twice.request!)).toBe(publicConstructor(once.request));
    expect(twice.request!).toMatch(/public SamplePlanRequest setTraceId\(String value\)/);
    const overloads = (api: string) =>
        api.match(/public CompletableFuture<SamplePlanResult> plan\([^)]*\)/g);
    expect(overloads(twice.api)).toEqual(overloads(once.api));
});

it("x-legacy-parameters session requests keep sessionId injected by the wrapper", async () => {
    const original = await renderLegacy(0, "session");
    const once = await renderLegacy(1, "session");
    expect(once.params).toBe(original.params);
    expect(once.params).toMatch(/@JsonProperty\("sessionId"\) String sessionId/);
    expect(once.request!).not.toMatch(/sessionId/);
    expect(once.api).toMatch(
        /plan\(SamplePlanRequest request\) \{\s+com\.fasterxml\.jackson\.databind\.node\.ObjectNode _p = MAPPER\.valueToTree\(Objects\.requireNonNull\(request, "request"\)\);\s+_p\.put\("sessionId", this\.sessionId\);\s+return caller\.invoke\("session\.sample\.plan", _p,/
    );
});

it("trusted human response ingress stays package-private", async () => {
    const fixture = {
        session: {
            ui: {
                handlePendingUserInput: {
                    rpcMethod: "session.ui.handlePendingUserInput",
                    visibility: "public",
                    params: { type: "object", properties: { sessionId: { type: "string" } } },
                    result: { type: "object", properties: { success: { type: "boolean" } } },
                },
                handleHumanUserInput: {
                    rpcMethod: "session.ui.handleHumanUserInput",
                    visibility: "internal",
                    params: { type: "object", properties: { sessionId: { type: "string" } } },
                    result: { type: "object", properties: { success: { type: "boolean" } } },
                },
                handleHumanExitPlanMode: {
                    rpcMethod: "session.ui.handleHumanExitPlanMode",
                    visibility: "internal",
                    params: { type: "object", properties: { sessionId: { type: "string" } } },
                    result: { type: "object", properties: { success: { type: "boolean" } } },
                },
            },
        },
        definitions: {},
    } satisfies Parameters<typeof renderRpcWrappers>[0];

    const wrappers = await renderRpcWrappers(fixture);
    const api = rpcSource(wrappers, "SessionUiApi");
    expect(api).toMatch(
        /public CompletableFuture<SessionUiHandlePendingUserInputResult> handlePendingUserInput\(/
    );
    expect(api).toMatch(
        /\n    CompletableFuture<SessionUiHandleHumanUserInputResult> handleHumanUserInput\(/
    );
    expect(api).toMatch(
        /\n    CompletableFuture<SessionUiHandleHumanExitPlanModeResult> handleHumanExitPlanMode\(/
    );
    expect(api).not.toMatch(
        /public CompletableFuture<SessionUiHandleHuman(?:UserInput|ExitPlanMode)Result>/
    );
});

it("x-legacy-parameters rejects metadata that would not preserve the original API", async () => {
    await expect(
        renderRpcTypes(legacyRequestFixture(1, "server", ["contract", "scope"]), {})
    ).rejects.toThrow(
        /Invalid x-legacy-parameters for sample\.plan: required property source must be a legacy parameter/
    );
    await expect(
        renderRpcTypes(legacyRequestFixture(1, "server", ["contract", "source", "missing"]), {})
    ).rejects.toThrow(/unknown property missing/);
    await expect(
        renderRpcTypes(legacyRequestFixture(1, "session", ["sessionId", "contract", "source"]), {})
    ).rejects.toThrow(/implicit property sessionId cannot be a legacy parameter/);
    const client = legacyRequestFixture(1) as Record<string, unknown>;
    client.clientSession = client.server;
    delete client.server;
    await expect(
        renderRpcTypes(client as Parameters<typeof renderRpcTypes>[0], {})
    ).rejects.toThrow(/only server and session requests are supported/);
});

/** A response record published with `name`, `status` and `error`, then extended with optional fields. */
function legacyRecordSchema(
    additions: string[],
    legacy: string[] | undefined = ["name", "status", "error"]
): JSONSchema7 {
    const properties: Record<string, JSONSchema7> = {
        name: { type: "string", description: "Server name." },
        status: { type: "string" },
    };
    for (const addition of additions.filter((name) => name === "owned"))
        properties[addition] = { type: "string" };
    properties.error = { type: "string" };
    for (const addition of additions.filter((name) => name !== "owned"))
        properties[addition] = { type: "string" };
    const schema: JSONSchema7 & Record<string, unknown> = {
        type: "object",
        properties,
        required: ["name", "status"],
    };
    if (additions.length > 0 && legacy) schema["x-legacy-parameters"] = legacy;
    return schema;
}

function recordSource(schema: JSONSchema7): string {
    return generateRpcClass("SampleServer", schema, new Map(), "com.github.copilot.generated.rpc")
        .code;
}

function legacyConstructors(source: string): string[] {
    return [...source.matchAll(/public SampleServer\(([^)]*)\) \{\s*this\(([^)]*)\);/g)].map(
        (match) => `${match[1].replace(/\s+/g, " ").trim()} => ${match[2]}`
    );
}

it("x-legacy-parameters response records keep every component and add the previous constructor", () => {
    const original = recordSource(legacyRecordSchema([]));
    expect(legacyConstructors(original), "unmarked records keep their existing generation").toEqual(
        []
    );

    const trailing = recordSource(legacyRecordSchema(["traceId"]));
    expect(trailing).toMatch(
        /record SampleServer\(\s*\/\*\* Server name\. \*\/\s*@JsonProperty\("name"\) String name,\s*@JsonProperty\("status"\) String status,\s*@JsonProperty\("error"\) String error,\s*@JsonProperty\("traceId"\) String traceId\s*\)/
    );
    expect(legacyConstructors(trailing)).toEqual([
        "String name, String status, String error => name, status, error, null",
    ]);

    const middle = recordSource(legacyRecordSchema(["owned"]));
    expect(legacyConstructors(middle)).toEqual([
        "String name, String status, String error => name, status, null, error",
    ]);

    const twice = recordSource(legacyRecordSchema(["owned", "traceId"]));
    expect(legacyConstructors(twice)).toEqual([
        "String name, String status, String error => name, status, null, error, null",
    ]);
});

it("managed settings params keep their previous positional constructor", async () => {
    const fixture = {
        server: {
            managedSettings: {
                resolve: {
                    rpcMethod: "managedSettings.resolve",
                    params: { $ref: "#/definitions/ManagedSettingsResolveRequest" },
                    result: null,
                },
            },
        },
        definitions: {
            ManagedSettingsResolveRequest: {
                anyOf: [
                    { not: {} },
                    {
                        type: "object",
                        properties: {
                            selectionId: { type: "string" },
                            gitHubToken: { type: "string" },
                            clientName: { type: "string" },
                            workingDirectory: { type: "string" },
                        },
                        additionalProperties: false,
                    },
                ],
            },
        },
    } as Parameters<typeof renderRpcTypes>[0];

    const files = await renderRpcTypes(fixture, {});
    const params = rpcSource(files, "ManagedSettingsResolveParams");
    expect(params).toMatch(
        /public ManagedSettingsResolveParams\(\s*String selectionId,\s*String gitHubToken,\s*String clientName\s*\) \{\s*this\(selectionId, gitHubToken, clientName, null\);\s*\}/
    );
});

it("x-legacy-parameters response records reject metadata a positional constructor cannot preserve", () => {
    expect(() =>
        recordSource(legacyRecordSchema(["traceId"], ["status", "name", "error"]))
    ).toThrow(
        /Invalid x-legacy-parameters for SampleServer: legacy parameters must follow schema property order/
    );
    expect(() => recordSource(legacyRecordSchema(["traceId"], ["name", "error"]))).toThrow(
        /required property status must be a legacy parameter/
    );
});

it("x-legacy-parameters response records get the constructor through standalone generation", async () => {
    const files = await renderRpcTypes(
        {
            server: {
                sample: {
                    list: {
                        rpcMethod: "sample.list",
                        params: null,
                        result: {
                            type: "object",
                            properties: {
                                servers: {
                                    type: "array",
                                    items: { $ref: "#/definitions/SampleServer" },
                                },
                            },
                            required: ["servers"],
                        },
                    },
                },
            },
            definitions: { SampleServer: legacyRecordSchema(["owned"]) },
        } as Parameters<typeof renderRpcTypes>[0],
        {}
    );
    expect(legacyConstructors(rpcSource(files, "SampleServer"))).toEqual([
        "String name, String status, String error => name, status, null, error",
    ]);
});

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

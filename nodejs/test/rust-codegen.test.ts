import type { ApiSchema } from "../../scripts/codegen/utils.ts";
import {
    normalizeSchemaBrandCasing,
    postProcessSchema,
    propagateInternalVisibility,
    stripBooleanLiterals,
} from "../../scripts/codegen/utils.ts";
import type { JSONSchema7 } from "json-schema";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    generateApiTypesCode,
    generateRpcCode,
    generateSessionEventsCode,
} from "../../scripts/codegen/rust.ts";
import { legacyRequestSchema } from "./legacy-parameters-fixture.ts";
import {
    eventFixture,
    metadataFixture,
    optionalRequestFixture,
    rpcFixture,
    unionFixture,
    booleanUnionFixture,
    eventMatrixFixture,
    jsonShapesFixture,
    namingFixture,
    nestedUnionFixture,
    presenceFixture,
    referenceFixture,
    visibilityFixture,
} from "./codegen-fixtures.ts";

describe("Rust shared schema baseline", () => {
    it("renders types, server/session calls, and nested namespaces", () => {
        const types = generateApiTypesCode(rpcFixture());
        const wrappers = generateRpcCode(rpcFixture());
        for (const field of [
            "pub id: String,",
            "pub count: i32,",
            "pub active: bool,",
            "pub score: f64,",
            "pub tags: Vec<String>,",
            "pub labels: HashMap<String, String>,",
            "pub display_name: Option<String>,",
            "pub note: Option<String>,",
            "pub items: Vec<SampleItem>,",
        ])
            expect(types).toContain(field);
        expect(types.match(/pub struct SampleItem \{/g)).toHaveLength(1);
        expect(types).toContain('#[serde(rename_all = "camelCase")]');
        expect(types).toContain('pub const SAMPLE_GET: &str = "sample.get";');
        expect(types).toContain('pub const SAMPLE_NESTED_LIST: &str = "sample.nested.list";');
        expect(types).toContain("pub struct SessionSampleGetRequest {\n    pub id: String,\n}");
        expect(wrappers).toContain("pub async fn ping(&self) -> Result<(), Error>");
        expect(wrappers).toContain("pub fn nested(&self) -> ClientRpcSampleNested<'a>");
        expect(wrappers).toContain(
            'wire_params["sessionId"] = serde_json::Value::String(self.session.id().to_string());'
        );
        expect(wrappers).toContain("call(rpc_methods::SESSION_SAMPLE_GET, Some(wire_params))");
        expect({ "api_types.rs": types, "rpc.rs": wrappers }).toMatchSnapshot();
    });

    it("renders separate parameterless and optional-request methods", () => {
        const types = generateApiTypesCode(optionalRequestFixture());
        const wrappers = generateRpcCode(optionalRequestFixture());
        expect(types).toContain("pub enabled: Option<bool>,");
        expect(wrappers).toContain("pub async fn configure(&self) -> Result<(), Error>");
        expect(wrappers).toContain(
            "pub async fn configure_with_params(&self, params: SampleConfigureParams)"
        );
    });

    it.each(["anyOf", "oneOf"] as const)("renders referenced %s unions and enums", (keyword) => {
        const code = generateApiTypesCode(unionFixture(keyword));
        expect(code).toContain("pub enum SampleChoice {");
        expect(code).toContain("Text(SampleChoiceText),");
        expect(code).toContain("Count(SampleChoiceCount),");
        expect(code).toContain("pub choice: SampleChoice,");
        expect(code).toContain("pub choices: Vec<SampleChoice>,");
        expect(code).toContain('#[serde(rename = "fast")]');
        expect(code).toContain('#[serde(rename = "thorough")]');
    });

    it("preserves method documentation and exposure annotations", () => {
        const code = generateRpcCode(metadataFixture());
        expect(code).toContain("Preview an item.");
        expect(
            code.match(/^(?:    \/\/\/[^\n]*\n)+    pub async fn preview[^\n]*/m)?.[0]
        ).toContain("**Experimental.**");
        expect(code).toContain("#[deprecated]\n    pub async fn retired(");
        expect(code).toContain("pub(crate) async fn hidden(");
        expect(code).not.toContain("pub async fn hidden(");
    });

    it("renders event payloads and serde discriminators", () => {
        const code = generateSessionEventsCode(eventFixture());
        expect(code).toContain('#[serde(rename = "sample.updated")]');
        expect(code).toContain('#[serde(tag = "type", content = "data")]');
        expect(code).toContain("SampleUpdated(SampleUpdatedData),");
        expect(code).toContain("pub sequence: i32,");
        expect(code).toContain("pub note: Option<String>,");
        expect(code).toMatchSnapshot();
    });

    it("keeps existing signatures when a response gains an optional field", () => {
        const before = generateRpcCode(rpcFixture());
        expect(generateRpcCode(rpcFixture({ extra: { type: "string" } }))).toBe(before);
        expect(generateApiTypesCode(rpcFixture())).not.toContain("pub extra:");
        expect(generateApiTypesCode(rpcFixture({ extra: { type: "string" } }))).toContain(
            "pub extra: Option<String>,"
        );
    });
});

describe("Rust schema contract matrix", () => {
    it.each([
        ["scalar", "String"],
        ["object", "PresenceValue"],
        ["array", "Vec<PresenceValue>"],
        ["map", "HashMap<String, PresenceValue>"],
    ] as const)("preserves requiredness and null serialization for %s fields", (shape, type) => {
        const code = generateApiTypesCode(presenceFixture(shape));
        for (const name of ["Presence", "SamplePresenceResult"]) {
            const declaration = code.match(
                new RegExp(`^pub struct ${name} \\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            expect(declaration).toContain(`    pub required_value: ${type},\n`);
            expect(declaration).toContain(`    pub required_nullable: Option<${type}>,\n`);
            expect(declaration).not.toContain(
                `#[serde(skip_serializing_if = "Option::is_none")]\n    pub required_nullable`
            );
            for (const field of ["optional_value", "optional_nullable"])
                expect(declaration).toContain(
                    `#[serde(skip_serializing_if = "Option::is_none")]\n    pub ${field}: Option<${type}>,`
                );
        }
    });

    it("reuses multi-hop references across request and result signatures", () => {
        const code = generateApiTypesCode(referenceFixture());
        for (const name of ["ReferenceGraph", "ReferenceNode", "ReferenceLeaf"])
            expect(code.match(new RegExp(`^pub struct ${name} \\{`, "gm"))).toHaveLength(1);
        const graph = code.match(/^pub struct ReferenceGraph \{[\s\S]*?^\}/m)?.[0];
        expect(graph).toContain("pub first: ReferenceNode,");
        expect(graph).toContain("pub second: ReferenceNode,");
        expect(graph).toContain("pub nodes: Vec<ReferenceNode>,");
        expect(graph).toContain("pub lookup: HashMap<String, ReferenceNode>,");
        expect(code).toContain("pub struct ReferenceNode {\n    pub leaf: ReferenceLeaf,\n}");
        expect(generateRpcCode(referenceFixture())).toContain(
            "pub async fn graph(&self, params: ReferenceGraph) -> Result<ReferenceGraph, Error>"
        );
    });

    it("preserves JSON values and open-object maps without synthesizing fields", () => {
        const code = generateApiTypesCode(jsonShapesFixture());
        expect(code.match(/^pub struct JsonShapes \{[\s\S]*?^\}/m)?.[0]).toBe(
            "pub struct JsonShapes {\n    pub empty: serde_json::Value,\n    pub open: HashMap<String, serde_json::Value>,\n    pub opaque: serde_json::Value,\n}"
        );
    });

    it.each(["anyOf", "oneOf"] as const)(
        "extends nested %s enums without changing existing payloads",
        (keyword) => {
            const before = generateApiTypesCode(nestedUnionFixture(keyword));
            const after = generateApiTypesCode(nestedUnionFixture(keyword, true));
            for (const code of [before, after]) {
                const result = code.match(/^pub struct VerdictSet \{[\s\S]*?^\}/m)?.[0];
                expect(result).toContain("pub selected: Option<Verdict>,");
                expect(result).toContain("pub decisions: HashMap<String, Verdict>,");
                const variants = code.match(/^pub enum Verdict \{[\s\S]*?^\}/m)?.[0];
                expect(variants).toContain("Allow(AllowVerdict),");
                expect(variants).toContain("Deny(DenyVerdict),");
                expect(code).toContain('#[serde(rename = "allow")]');
                expect(code).toContain('#[serde(rename = "deny")]');
            }
            expect(before).not.toContain("PendingVerdict");
            expect(after.match(/^pub enum Verdict \{[\s\S]*?^\}/m)?.[0]).toContain(
                "Pending(PendingVerdict),"
            );
            const declaration = /^pub struct AllowVerdict \{[\s\S]*?^\}/m;
            expect(before).toMatch(declaration);
            expect(after.match(declaration)?.[0]).toBe(before.match(declaration)?.[0]);
        }
    );

    it("validates boolean discriminator wire values in both codec directions", () => {
        const code = generateApiTypesCode(booleanUnionFixture());
        expect(code.match(/^pub enum EnqueueCommandResult \{[\s\S]*?^\}/m)?.[0]).toBe(
            "pub enum EnqueueCommandResult {\n    True(AcceptedEnqueueCommandResult),\n    False(UnsupportedEnqueueCommandResult),\n}"
        );
        for (const [name, value] of [
            ["AcceptedEnqueueCommandResult", true],
            ["UnsupportedEnqueueCommandResult", false],
        ] as const) {
            const declaration = code.match(
                new RegExp(`^pub struct ${name} \\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            expect(declaration).toContain("pub queued: bool,");
            expect(declaration).toContain(
                `#[serde(deserialize_with = "${name}::deserialize_queued", serialize_with = "${name}::serialize_queued")]`
            );
            const codec = code.match(new RegExp(`^impl ${name} \\{[\\s\\S]*?^\\}`, "m"))?.[0];
            expect(codec).toContain(`if ${value ? "!" : ""}value {`);
            expect(codec).toContain(`if ${value ? "!" : ""}*value {`);
            expect(codec).toContain(`serde::de::Error::custom("expected ${value}")`);
            expect(codec).toContain(`serde::ser::Error::custom("expected ${value}")`);
            expect(codec).toContain("value.serialize(serializer)");
        }
        expect(generateRpcCode(booleanUnionFixture())).toContain(
            "pub async fn accept(&self) -> Result<EnqueueCommandResult, Error>"
        );
    });

    it("uses raw identifiers and serde renames without changing wire names", () => {
        const code = generateApiTypesCode(namingFixture());
        const declaration = code.match(/^pub struct WireNames \{[\s\S]*?^\}/m)?.[0];
        expect(declaration).toContain("pub class: String,");
        expect(declaration).toContain("pub default: bool,");
        expect(declaration).toContain("pub r#type: String,");
        expect(declaration).toContain("pub request_id: RequestId,");
        expect(declaration).toContain(
            '#[serde(rename = "content-type")]\n    pub content_type: String,'
        );
        expect(code).toContain('#[serde(rename_all = "camelCase")]\npub struct WireNames');
    });

    it("keeps internal methods crate-private while sharing reachable public types", () => {
        const schema = visibilityFixture();
        const code = generateRpcCode(schema);
        for (const namespace of ["Host", "Sample"]) {
            const methods = code.match(
                new RegExp(`^impl<'a> ClientRpc${namespace}<'a> \\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            expect(methods).toContain("pub async fn visible(&self) -> Result<PublicResult, Error>");
            expect(methods).toContain(
                "pub(crate) async fn secret(&self) -> Result<PrivateResult, Error>"
            );
            expect(methods).not.toContain("pub async fn secret(");
        }
        expect(generateApiTypesCode(schema).match(/^pub struct SharedValue \{/gm)).toHaveLength(1);
    });

    it("includes all event tags, payloads, and nested union variants", () => {
        const code = generateSessionEventsCode(eventMatrixFixture());
        for (const enumName of ["SessionEventType", "SessionEventData"]) {
            const declaration = code.match(
                new RegExp(`^pub enum ${enumName} \\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            expect(declaration?.match(/#\[serde\(rename = "matrix\.[^"]+"\)\]/g)).toEqual([
                '#[serde(rename = "matrix.empty")]',
                '#[serde(rename = "matrix.value")]',
                '#[serde(rename = "matrix.union")]',
            ]);
        }
        for (const name of ["Empty", "Value", "Union"])
            expect(code).toContain(`Matrix${name}(Matrix${name}Data),`);
        expect(code.match(/^pub struct MatrixEmptyData \{[\s\S]*?^\}/m)?.[0]).toBe(
            "pub struct MatrixEmptyData {\n}"
        );
        expect(code.match(/^pub struct MatrixValueData \{[\s\S]*?^\}/m)?.[0]).toContain(
            "pub sequence: i32,"
        );
        const union = code.match(/^pub enum MatrixUnionData \{[\s\S]*?^\}/m)?.[0];
        expect(union).toContain("First(MatrixUnionDataFirst),");
        expect(union).toContain("Second(MatrixUnionDataSecond),");
    });

    it("does not retain names or serde declarations between schemas", () => {
        const before = {
            types: generateApiTypesCode(referenceFixture()),
            rpc: generateRpcCode(referenceFixture()),
            events: generateSessionEventsCode(eventFixture()),
        };
        generateApiTypesCode(nestedUnionFixture("oneOf", true));
        generateRpcCode(nestedUnionFixture("oneOf", true));
        generateSessionEventsCode(eventMatrixFixture());
        expect({
            types: generateApiTypesCode(referenceFixture()),
            rpc: generateRpcCode(referenceFixture()),
            events: generateSessionEventsCode(eventFixture()),
        }).toEqual(before);
    });
});

describe("Rust API type codegen", () => {
    it("reuses the named managed operation and kind in request and result fields", () => {
        const code = generateApiTypesCode({
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
                ManagedPermissionsEvaluateRequest: {
                    type: "object",
                    properties: {
                        operations: {
                            type: "array",
                            items: { $ref: "#/definitions/ManagedPermissionOperation" },
                        },
                    },
                    required: ["operations"],
                },
                ManagedPermissionEvaluation: {
                    type: "object",
                    properties: { operation: { $ref: "#/definitions/ManagedPermissionOperation" } },
                    required: ["operation"],
                },
            },
        } as ApiSchema);
        expect(code).toContain("pub operations: Vec<ManagedPermissionOperation>,");
        expect(code).toContain("pub operation: ManagedPermissionOperation,");
        expect(code).toContain("pub kind: ManagedPermissionOperationKind,");
        expect(code).not.toContain("ManagedPermissionsEvaluateRequestOperationsItem");
        expect(code).not.toContain("ManagedPermissionEvaluationOperation");
    });

    it("keeps every noncanonical open identifier distinct from the default sentinel", () => {
        const code = generateApiTypesCode(
            postProcessSchema({
                definitions: {
                    AutoTier: {
                        type: "string",
                        "x-extensible-enum": ["balance", "fast"],
                    },
                    RecommendedAutoTier: {
                        type: "string",
                        "x-extensible-enum": ["balance"],
                    },
                },
            } as JSONSchema7) as ApiSchema
        );
        expect(code).toContain("Custom(String),");
        expect(code).toContain("_ => Self::Custom(value),");
        expect(code).not.toContain('"Unknown" => Self::Unknown,');
    });

    it("does not emit MCP list request types for a parameterless endpoint", () => {
        const code = generateApiTypesCode({
            session: {
                mcp: {
                    list: {
                        rpcMethod: "session.mcp.list",
                        params: null,
                    },
                },
            },
        });
        expect(code).not.toContain("SessionMcpListParams");
        expect(code).not.toContain("McpListRequest");
    });

    it.each([
        {
            sentinel: { type: "null" },
            expectedAlias: "pub type SessionAccountResult = Option<SessionAccount>;",
        },
        // `{ "not": {} }` is the omission sentinel, not a wire null, so the
        // alias must not become Option and accept/serialize a null.
        { sentinel: { not: {} }, expectedAlias: "pub type SessionAccountResult = SessionAccount;" },
    ])(
        "aliases a named reference according to its null-like branch (%j)",
        ({ sentinel, expectedAlias }) => {
            const code = generateApiTypesCode({
                definitions: {
                    SessionAccount: {
                        type: "object",
                        title: "SessionAccount",
                        properties: { accountId: { type: "string" } },
                        required: ["accountId"],
                    },
                    SessionAccountResult: {
                        title: "SessionAccountResult",
                        anyOf: [{ $ref: "#/definitions/SessionAccount" }, sentinel],
                    },
                },
                session: {
                    accounts: {
                        getCurrent: {
                            rpcMethod: "session.accounts.getCurrent",
                            params: null,
                            result: { $ref: "#/definitions/SessionAccountResult" },
                        },
                    },
                },
            } as ApiSchema);

            expect(code).toContain(expectedAlias);
            expect(code).toContain("pub struct SessionAccount {");
            expect(code).not.toContain("pub struct SessionAccountResult {");
        }
    );
    it("preserves future customization reload enum values in both directions", () => {
        const code = generateApiTypesCode({
            definitions: {
                CustomizationReloadStatus: { type: "string", enum: ["reloaded", "skipped"] },
                CustomizationReloadSubsystem: { type: "string", enum: ["skills", "hooks"] },
                ClosedStatus: { type: "string", enum: ["ready"] },
            },
        } as ApiSchema);

        for (const name of ["CustomizationReloadStatus", "CustomizationReloadSubsystem"]) {
            expect(code).toContain(`pub enum ${name} {`);
            expect(code).toContain(`impl From<String> for ${name} {`);
            expect(code).toContain(`impl From<${name}> for String {`);
        }
        expect(code).toContain('#[serde(from = "String", into = "String")]');
        expect(code).toContain("Unknown(String),");
        expect(code).toContain("pub enum ClosedStatus {");
        expect(code).toContain("#[serde(other)]");
    });

    it.each(["anyOf", "oneOf"] as const)(
        "keeps required phase results typed through %s references",
        (keyword) => {
            const code = generateApiTypesCode({
                definitions: {
                    Operation: {
                        [keyword]: ["prepared", "cancelled"].map((phase) => ({
                            type: "object",
                            required: ["phase", "operationId"],
                            properties: {
                                phase: { type: "string", const: phase },
                                operationId: { type: "string" },
                            },
                        })),
                    },
                    Result: {
                        type: "object",
                        required: ["operation"],
                        properties: { operation: { $ref: "#/definitions/Operation" } },
                    },
                },
            } as ApiSchema);

            expect(code).toContain("pub operation: Operation,");
            expect(code).toContain(`#[serde(untagged)]
pub enum Operation {
    Prepared(OperationPrepared),
    Cancelled(OperationCancelled),
}`);
            expect(code).toContain("pub phase: OperationPreparedPhase,");
            expect(code).toContain("pub phase: OperationCancelledPhase,");
            expect(code).not.toContain("#[serde(other)]");
            expect(code).not.toContain("pub operation: serde_json::Value,");
        }
    );

    it.each(["anyOf", "oneOf"] as const)(
        "keeps null in a referenced multi-variant %s discriminated union",
        (keyword) => {
            const code = generateApiTypesCode({
                definitions: {
                    Outcome: {
                        title: "Outcome",
                        [keyword]: [
                            ...["ready", "pending"].map((kind) => ({
                                type: "object",
                                required: ["kind"],
                                properties: { kind: { type: "string", const: kind } },
                            })),
                            { type: "null" },
                        ],
                    },
                    Container: {
                        type: "object",
                        required: ["outcome"],
                        properties: { outcome: { $ref: "#/definitions/Outcome" } },
                    },
                },
            } as ApiSchema);

            expect(code).toContain("pub outcome: Option<Outcome>,");
            expect(code).toContain("pub enum Outcome {");
        }
    );

    it("preserves the published MCP transport choice schema as a typed union", () => {
        // Exact selected definitions from CLI 1.0.89-1 api.schema.json:
        // sha256 a445b552b6ecef536b89f3d08cc73b6fbbe8fe0e503daae8974578529d62bc83.
        const schema = JSON.parse(
            readFileSync(
                new URL("./fixtures/mcp-plan-transport-choice.schema.json", import.meta.url),
                "utf8"
            )
        ) as ApiSchema;
        schema.definitions!.Plan = {
            type: "object",
            required: ["transportChoices"],
            properties: {
                transportChoices: {
                    type: "array",
                    items: { $ref: "#/definitions/McpPlanTransportChoice" },
                },
            },
        };
        const code = generateApiTypesCode(schema);

        expect(code).toContain(`#[serde(untagged)]
pub enum McpPlanTransportChoice {
    Package(McpPlanTransportChoicePackage),
    Remote(McpPlanTransportChoiceRemote),
}`);
        expect(code).toContain("pub transport_choices: Vec<McpPlanTransportChoice>,");
        expect(code).toContain("pub required_values: Vec<McpPlanRequiredValue>,");
        expect(code).toContain("pub secret_placeholders: Vec<McpPlanSecretPlaceholder>,");
        expect(code).toContain(
            'deserialize_with = "McpPlanTransportChoicePackage::deserialize_install_method"'
        );
        expect(code).toContain(
            'deserialize_with = "McpPlanTransportChoiceRemote::deserialize_install_method"'
        );
        expect(code).toContain('if value != "package"');
        expect(code).toContain('if value != "remote"');
        expect(code).not.toContain("Vec<serde_json::Value>");
    });

    it.each(["anyOf", "oneOf"] as const)(
        "supports arbitrary required enum-reference discriminators in %s unions",
        (keyword) => {
            const code = generateApiTypesCode({
                definitions: {
                    Mode: { type: "string", enum: ["first", "second"] },
                    Choice: {
                        title: "Choice",
                        [keyword]: ["first", "second"].map((value) => ({
                            type: "object",
                            required: ["mode", "value"],
                            properties: {
                                mode: { $ref: "#/definitions/Mode", const: value },
                                value: { type: "string" },
                            },
                        })),
                    },
                    Container: {
                        type: "object",
                        required: ["choice"],
                        properties: { choice: { $ref: "#/definitions/Choice" } },
                    },
                },
            } as ApiSchema);

            expect(code).toContain(`#[serde(untagged)]
pub enum Choice {
    First(ChoiceFirst),
    Second(ChoiceSecond),
}`);
            expect(code).toContain(`#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container`);
            expect(code).toContain("pub choice: Choice,");
        }
    );

    it.each(["optional", "duplicate", "missing", "number", "inline", "outside-enum"] as const)(
        "retains the JSON fallback for %s discriminators without a supported union",
        (invalid) => {
            const variants: JSONSchema7[] = ["first", "second"].map((value) => ({
                type: "object",
                required: invalid === "optional" ? ["value"] : ["mode", "value"],
                properties: {
                    mode:
                        invalid === "missing"
                            ? { type: "string" }
                            : invalid === "number"
                              ? { type: "integer", const: value === "first" ? 1 : 2 }
                              : invalid === "inline"
                                ? { type: "string", const: value }
                                : {
                                      $ref: "#/definitions/Mode",
                                      const: invalid === "duplicate" ? "same" : value,
                                  },
                    value: { type: "string" },
                },
            }));
            const code = generateApiTypesCode({
                definitions: {
                    Mode: {
                        type: "string",
                        enum: invalid === "outside-enum" ? ["different"] : ["first", "second"],
                    },
                    Container: {
                        type: "object",
                        required: ["choice"],
                        properties: { choice: { anyOf: variants } },
                    },
                },
            } as ApiSchema);

            expect(code).toContain("pub choice: serde_json::Value,");
            expect(code).not.toContain("pub enum ContainerChoice");
        }
    );

    it.each(["anyOf", "oneOf"] as const)(
        "preserves raw optional metadata when newly recognising referenced %s discriminators",
        (keyword) => {
            const code = generateApiTypesCode({
                definitions: {
                    Status: { type: "string", enum: ["known", "unavailable"] },
                    Snapshot: {
                        title: "Snapshot",
                        [keyword]: ["known", "unavailable"].map((status) => ({
                            type: "object",
                            required: ["status"],
                            properties: {
                                status: { $ref: "#/definitions/Status", const: status },
                            },
                        })),
                    },
                    Container: {
                        type: "object",
                        required: ["requiredSnapshot"],
                        properties: {
                            requiredSnapshot: { $ref: "#/definitions/Snapshot" },
                            optionalSnapshot: { $ref: "#/definitions/Snapshot" },
                        },
                    },
                },
            } as ApiSchema);

            expect(code).toContain("pub required_snapshot: Snapshot,");
            expect(code).toContain("pub optional_snapshot: Option<serde_json::Value>,");
            expect(code).not.toContain("pub optional_snapshot: Option<Snapshot>,");
        }
    );

    it("emits the current runtime's boolean-discriminated command queue result", () => {
        const code = generateApiTypesCode({
            definitions: {
                EnqueueCommandResult: {
                    title: "EnqueueCommandResult",
                    anyOf: [
                        { $ref: "#/definitions/AcceptedEnqueueCommandResult" },
                        { $ref: "#/definitions/UnsupportedEnqueueCommandResult" },
                    ],
                },
                AcceptedEnqueueCommandResult: {
                    type: "object",
                    required: ["queued", "queueId"],
                    properties: {
                        queued: { type: "boolean", const: true },
                        queueId: { type: "string" },
                    },
                },
                UnsupportedEnqueueCommandResult: {
                    type: "object",
                    required: ["queued"],
                    properties: { queued: { type: "boolean", const: false } },
                },
            },
        } as ApiSchema);

        expect(code).toContain("pub enum EnqueueCommandResult {");
        expect(code).toContain("True(AcceptedEnqueueCommandResult)");
        expect(code).toContain("False(UnsupportedEnqueueCommandResult)");
    });

    it("reuses the get-sources result for instructions reload without generating an unused type", () => {
        const schema = {
            definitions: {
                InstructionsGetSourcesResult: {
                    type: "object",
                    properties: { sources: { type: "array", items: { type: "string" } } },
                    required: ["sources"],
                },
                OtherResult: {
                    type: "object",
                    properties: { sources: { type: "array", items: { type: "string" } } },
                    required: ["sources"],
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
        const apiSchema = schema as ApiSchema;

        const types = generateApiTypesCode(apiSchema);
        const rpc = generateRpcCode(apiSchema);
        expect(types).toContain("pub struct InstructionsGetSourcesResult {");
        expect(types).not.toContain("pub struct SessionInstructionsReloadResult {");
        expect(rpc).toContain(
            "pub async fn reload(&self) -> Result<InstructionsGetSourcesResult, Error>"
        );

        schema.session.instructions.reload.result.$ref = "#/definitions/OtherResult";
        expect(generateApiTypesCode(apiSchema)).toContain(
            "pub struct SessionInstructionsReloadResult {"
        );
        expect(generateRpcCode(apiSchema)).toContain(
            "pub async fn reload(&self) -> Result<OtherResult, Error>"
        );
    });

    it.each([true, false])(
        "validates a reference's sibling constant without changing its enum (required: %s)",
        (required) => {
            const code = generateApiTypesCode({
                definitions: {
                    CandidateKind: {
                        type: "string",
                        enum: ["mcp-server", "ai-skill", "unknown"],
                    },
                    Candidate: {
                        type: "object",
                        required: required ? ["kind", "ordinaryKind"] : ["ordinaryKind"],
                        properties: {
                            kind: {
                                $ref: "#/definitions/CandidateKind",
                                const: "ai-skill",
                            },
                            ordinaryKind: { $ref: "#/definitions/CandidateKind" },
                        },
                    },
                },
            } as ApiSchema);

            expect(code).toContain(
                `#[serde(${required ? "" : "default, "}deserialize_with = "Candidate::deserialize_kind")]`
            );
            expect(code).toContain(
                `pub kind: ${required ? "CandidateKind" : "Option<CandidateKind>"},`
            );
            expect(code).toContain("pub ordinary_kind: CandidateKind,");
            expect(code).not.toContain("Candidate::deserialize_ordinary_kind");
            expect(code).toContain(`if value != "ai-skill" {`);
            expect(code).toContain(`&["ai-skill"]`);
            expect(code).toContain(
                "<CandidateKind>::deserialize(serde::de::value::StringDeserializer::<D::Error>::new(value))"
            );
            expect(code.match(/fn deserialize_/g)).toHaveLength(1);
            if (!required) {
                expect(code).toContain("Option::<String>::deserialize(deserializer)?");
                expect(code).toContain("return Ok(None);");
                expect(code).toContain(".map(Some)");
            }
            expect(code).toContain(`#[serde(rename = "mcp-server")]
    McpServer,`);
            expect(code).toContain(`#[serde(rename = "ai-skill")]
    AiSkill,`);
            expect(code).toContain(`#[serde(rename = "unknown")]
    UnknownValue,`);
            expect(code).toContain(`#[default]
    #[serde(other)]
    Unknown,`);
        }
    );

    it("separates adjacent constant helpers before formatting", () => {
        const property: JSONSchema7 = { $ref: "#/definitions/Kind", const: "ai-skill" };
        const code = generateApiTypesCode({
            definitions: {
                Kind: { type: "string", enum: ["ai-skill", "mcp-server"] },
                Candidate: {
                    type: "object",
                    required: ["first", "second"],
                    properties: { first: property, second: { ...property } },
                },
            },
        } as ApiSchema);

        expect(code).toContain("    }\n\n    fn deserialize_second");
    });

    it("distinguishes a protocol-defined unknown value from the forward-compatible fallback", () => {
        const code = generateApiTypesCode({
            definitions: {
                CatalogTrustEligibility: {
                    type: "string",
                    enum: ["default", "expanded", "hidden", "unknown"],
                },
            },
        } as ApiSchema);

        expect(code).toContain(`#[serde(rename = "unknown")]
    UnknownValue,
    /// Unknown variant for forward compatibility.
    #[default]
    #[serde(other)]
    Unknown,`);
    });

    it("publicly re-exports API types moved into the shared session-events schema", () => {
        const code = generateApiTypesCode({
            definitions: {
                PermissionDecision: {
                    type: "object",
                    required: ["source"],
                    properties: {
                        source: {
                            $ref: "session-events.schema.json#/definitions/PermissionDecisionSource",
                        },
                    },
                },
            },
        } as ApiSchema);

        expect(code).toContain("pub use super::session_events::{PermissionDecisionSource};");
        expect(code).toContain("use crate::types::{RequestId, SessionId};");
    });

    it("emits the enqueue result union discriminated by queued", () => {
        const code = generateApiTypesCode({
            definitions: {
                AcceptedEnqueueCommandResult: {
                    type: "object",
                    required: ["queued", "queueId"],
                    properties: {
                        queued: { type: "boolean", const: true },
                        queueId: { type: "string" },
                    },
                },
                UnsupportedEnqueueCommandResult: {
                    type: "object",
                    required: ["queued"],
                    properties: {
                        queued: { type: "boolean", const: false },
                        queueId: { type: ["string", "null"] },
                    },
                },
                EnqueueCommandResult: {
                    anyOf: [
                        { $ref: "#/definitions/AcceptedEnqueueCommandResult" },
                        { $ref: "#/definitions/UnsupportedEnqueueCommandResult" },
                    ],
                    title: "EnqueueCommandResult",
                },
            },
        } as ApiSchema);

        expect(code).toContain("#[serde(untagged)]");
        expect(code).toContain("pub enum EnqueueCommandResult {");
        expect(code).toContain("True(AcceptedEnqueueCommandResult),");
        expect(code).toContain("False(UnsupportedEnqueueCommandResult),");
        expect(code).toContain(
            'deserialize_with = "AcceptedEnqueueCommandResult::deserialize_queued", serialize_with = "AcceptedEnqueueCommandResult::serialize_queued"'
        );
        expect(code).toContain(
            'deserialize_with = "UnsupportedEnqueueCommandResult::deserialize_queued", serialize_with = "UnsupportedEnqueueCommandResult::serialize_queued"'
        );
        expect(code).toContain('serde::de::Error::custom("expected true")');
        expect(code).toContain('serde::ser::Error::custom("expected true")');
        expect(code).toContain('serde::de::Error::custom("expected false")');
        expect(code).toContain('serde::ser::Error::custom("expected false")');
        expect(code).toContain("if !value {");
        expect(code).toContain("if !*value {");
        expect(code).toContain("if value {");
        expect(code).toContain("if *value {");
        expect(code).not.toMatch(/\bvalue != (?:true|false)\b/);
        expect(code).not.toMatch(/\*value != (?:true|false)\b/);
    });

    it.each([
        ["unknown", "unknown_value"],
        ["unknown_value", "unknown"],
        ["not-called", "not_called"],
    ])("rejects colliding wire values %s and %s", (first, second) => {
        expect(() =>
            generateApiTypesCode({
                definitions: {
                    Collision: { type: "string", enum: [first, second] },
                },
            } as ApiSchema)
        ).toThrow("is not unique");
    });

    it("keeps the fallback name reserved for wire values other than exact lowercase unknown", () => {
        expect(() =>
            generateApiTypesCode({
                definitions: {
                    Collision: { type: "string", enum: ["Unknown"] },
                },
            } as ApiSchema)
        ).toThrow('Generated Rust enum variant identifier "Unknown" is not unique');
    });
});

describe("Rust session event codegen", () => {
    function eventSchema(
        data: JSONSchema7,
        definitions: JSONSchema7["definitions"] = {},
        eventType = "session.search"
    ): JSONSchema7 {
        return {
            definitions: {
                ...definitions,
                SessionEvent: {
                    anyOf: [
                        {
                            type: "object",
                            required: ["type", "data"],
                            properties: {
                                type: { const: eventType },
                                data,
                            },
                        },
                    ],
                },
            },
        };
    }

    it("boxes image tool usage without changing the event variant or unrelated fields", () => {
        const code = generateSessionEventsCode(
            eventSchema(
                {
                    type: "object",
                    properties: {
                        toolUsage: { $ref: "#/definitions/ToolExecutionUsage" },
                        otherUsage: { $ref: "#/definitions/ToolExecutionUsage" },
                    },
                },
                {
                    ToolExecutionUsage: {
                        type: "object",
                        properties: { requestId: { type: "string" } },
                        required: ["requestId"],
                    },
                },
                "tool.execution_complete"
            )
        );

        expect(code).toContain(
            '#[serde(skip_serializing_if = "Option::is_none")]\n    pub tool_usage: Option<Box<ToolExecutionUsage>>,'
        );
        expect(code).toContain("pub other_usage: Option<ToolExecutionUsage>,");
        expect(code).toContain("ToolExecutionComplete(ToolExecutionCompleteData),");
        expect(code).not.toContain("allow(clippy::large_enum_variant)");
    });

    it.each([
        ["anyOf", false],
        ["anyOf", true],
        ["oneOf", false],
        ["oneOf", true],
    ] as const)("preserves root %s event unions (referenced: %s)", (keyword, referenced) => {
        const payload: JSONSchema7 = {
            ...(referenced ? { title: "SearchPayload" } : {}),
            [keyword]: [
                {
                    type: "object",
                    required: ["kind", "ready"],
                    properties: {
                        kind: { type: "string", const: "status" },
                        ready: { type: "boolean" },
                    },
                },
                {
                    type: "object",
                    required: ["kind", "durationMs"],
                    properties: {
                        kind: { type: "string", const: "startup" },
                        durationMs: { type: "number" },
                    },
                },
            ],
        };
        const code = generateSessionEventsCode(
            eventSchema(
                referenced ? { $ref: "#/definitions/SearchPayload" } : payload,
                referenced ? { SearchPayload: payload } : {}
            )
        );
        const name = referenced ? "SearchPayload" : "SessionSearchData";

        expect(code).toContain("SessionSearch(SessionSearchData),");
        expect(code).toContain(`#[serde(untagged)]
pub enum ${name} {
    Status(${name}Status),
    Startup(${name}Startup),
}`);
        expect(code).toContain("pub ready: bool,");
        expect(code).toContain("pub duration_ms: f64,");
        expect(code).not.toContain("pub struct SessionSearchData {");
        if (referenced) {
            expect(code).toContain("pub type SessionSearchData = SearchPayload;");
        } else {
            expect(code).not.toContain("pub type SessionSearchData = SessionSearchData;");
        }
    });

    it.each(["anyOf", "oneOf"] as const)(
        "preserves unrepresentable root %s event payloads as raw JSON",
        (keyword) => {
            const code = generateSessionEventsCode(
                eventSchema({ [keyword]: [{ type: "string" }, { type: "number" }] })
            );

            expect(code).toContain("pub type SessionSearchData = serde_json::Value;");
            expect(code).toContain("SessionSearch(SessionSearchData),");
            expect(code).not.toContain("pub struct SessionSearchData");
        }
    );

    it("keeps ordinary and empty object event payloads as structs", () => {
        const ordinary = generateSessionEventsCode(
            eventSchema({
                type: "object",
                required: ["message"],
                properties: { message: { type: "string" } },
            })
        );
        const empty = generateSessionEventsCode(eventSchema({ type: "object", properties: {} }));

        expect(ordinary).toContain("pub struct SessionSearchData {\n    pub message: String,\n}");
        expect(empty).toContain("pub struct SessionSearchData {\n}");
        expect(ordinary).not.toContain("pub type SessionSearchData");
        expect(empty).not.toContain("pub type SessionSearchData");
    });

    it("types the durable human response event union", () => {
        const response: JSONSchema7 = {
            title: "HumanResponseRecordedResponse",
            anyOf: [
                {
                    type: "object",
                    required: ["responseKind", "answer"],
                    properties: {
                        responseKind: { type: "string", const: "user_input" },
                        answer: { type: "string" },
                    },
                },
                {
                    type: "object",
                    required: ["responseKind", "approved"],
                    properties: {
                        responseKind: { type: "string", const: "exit_plan_mode" },
                        approved: { type: "boolean" },
                    },
                },
            ],
        };
        const code = generateSessionEventsCode(
            eventSchema(
                {
                    type: "object",
                    required: ["response"],
                    properties: {
                        response: { $ref: "#/definitions/HumanResponseRecordedResponse" },
                    },
                },
                { HumanResponseRecordedResponse: response }
            )
        );

        expect(code).toContain("pub response: HumanResponseRecordedResponse,");
        expect(code).toContain(`pub enum HumanResponseRecordedResponse {
    UserInput(HumanResponseRecordedResponseUserInput),
    ExitPlanMode(HumanResponseRecordedResponseExitPlanMode),
}`);
        expect(code).not.toContain("pub response: serde_json::Value,");
    });

    it.each(["reasonCode", "judgeStatus", "evaluationStage"])(
        "preserves explicit unknown values in nested approval %s enums",
        (property) => {
            const code = generateSessionEventsCode({
                definitions: {
                    SessionEvent: {
                        anyOf: [
                            {
                                type: "object",
                                required: ["type", "data"],
                                properties: {
                                    type: { const: "permission.completed" },
                                    data: {
                                        type: "object",
                                        properties: {
                                            approval: {
                                                type: "object",
                                                properties: {
                                                    [property]: {
                                                        type: "string",
                                                        enum: ["unknown", "inherited"],
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
            });

            expect(code).toContain(`#[serde(rename = "unknown")]
    UnknownValue,`);
            expect(code).toContain(`#[serde(rename = "inherited")]
    Inherited,`);
            expect(code).toContain(`/// Unknown variant for forward compatibility.
    #[default]
    #[serde(other)]
    Unknown,`);
        }
    );
});

describe("Rust x-legacy-parameters", () => {
    it.each(["server", "session"] as const)(
        "serializes unrelated %s requests and options by value",
        (scope) => {
            const { schema } = legacyRequestSchema(1, scope);
            const rpc = generateRpcCode(schema);
            expect(rpc.match(/serde_json::to_value\(params\)\?/g)).toHaveLength(2);
            expect(rpc).not.toContain("serde_json::to_value(&params)");
        }
    );

    it("preserves optional settings value presence without inserting null", () => {
        const rpc = generateRpcCode({
            server: {
                user: {
                    settings: {
                        applyTopKey: {
                            rpcMethod: "user.settings.applyTopKey",
                            params: {
                                type: "object",
                                properties: {
                                    topKey: { type: "string" },
                                    value: { "x-opaque-json": true } as JSONSchema7,
                                    delete: { type: "boolean" },
                                },
                                required: ["topKey"],
                            },
                            result: { type: "object" },
                        },
                    },
                },
            },
        });
        expect(rpc).toContain("let wire_params = serde_json::to_value(params)?;");
        expect(rpc).not.toContain('_obj.insert("value"');
    });

    const render = (additions: 0 | 1 | 2, scope: "server" | "session" = "server") => {
        const { schema } = legacyRequestSchema(additions, scope);
        const types = generateApiTypesCode(schema);
        const rpc = generateRpcCode(schema);
        const block = (code: string, pattern: RegExp) => code.match(pattern)?.[0];
        return {
            types,
            rpc,
            request: block(types, /pub struct SamplePlanRequest \{[\s\S]*?\n\}/),
            constructor: block(types, /pub fn new\([^)]*\) -> Self/),
            plan: block(rpc, /pub async fn plan\([^)]*\)[^{]*/),
            options: block(rpc, /pub async fn plan_with_options\([^)]*\)[^{]*/),
        };
    };

    it("leaves unmarked requests unchanged", () => {
        const original = render(0);
        expect(original.types).not.toContain("SamplePlanOptions");
        expect(original.rpc).not.toContain("plan_with_options");
    });

    it("freezes the published struct and method and adds private-field options", () => {
        const original = render(0);
        const once = render(1);
        expect(once.request).toBe(original.request);
        expect(once.plan).toBe(original.plan);
        expect(once.types).toContain(
            "pub struct SamplePlanOptions {\n    #[serde(flatten)]\n    legacy: SamplePlanRequest,"
        );
        expect(once.types).toMatch(
            /#\[serde\(skip_serializing_if = "Option::is_none"\)\]\n    policy_session_id: Option<String>,/
        );
        expect(once.constructor).toBe(
            "pub fn new(contract: impl Into<String>, source: impl Into<String>) -> Self"
        );
        expect(once.types).toContain(
            "legacy: SamplePlanRequest { contract: contract.into(), source: source.into(), scope: None },"
        );
        expect(once.types).toContain(
            "pub fn scope(mut self, value: impl Into<String>) -> Self {\n        self.legacy.scope = Some(value.into());"
        );
        expect(once.types).toContain(
            "pub fn policy_session_id(mut self, value: impl Into<String>) -> Self {\n        self.policy_session_id = Some(value.into());"
        );
        expect(once.options).toContain("params: SamplePlanOptions");
        const wireCalls = once.rpc.match(/rpc_methods::SAMPLE_PLAN/g) ?? [];
        expect(wireCalls).toHaveLength(2);
        expect(once.types).not.toContain("non_exhaustive");
    });

    it("keeps both entry points unchanged across a second optional addition", () => {
        const once = render(1);
        const twice = render(2);
        expect(twice.request).toBe(once.request);
        expect(twice.constructor).toBe(once.constructor);
        expect(twice.plan).toBe(once.plan);
        expect(twice.options).toBe(once.options);
        expect(twice.types).toContain(
            "pub fn trace_id(mut self, value: impl Into<String>) -> Self {"
        );
        expect(twice.types).toContain("            trace_id: None,");
    });

    it("keeps the session id injected by session-scoped wrappers", () => {
        const once = render(1, "session");
        expect(once.request).toBe(render(0, "session").request);
        expect(once.request).not.toContain("session_id");
        const body = once.rpc.slice(once.rpc.indexOf("pub async fn plan_with_options"));
        expect(body).toMatch(
            /wire_params\["sessionId"\] = serde_json::Value::String\(self\.session\.id\(\)\.to_string\(\)\);/
        );
    });

    it("derives Default for options without required inputs", () => {
        const { schema, params } = legacyRequestSchema(1);
        params.required = [];
        const types = generateApiTypesCode(schema);
        expect(types).toContain("pub fn new() -> Self");
        expect(types).toContain(
            "impl Default for SamplePlanOptions {\n    fn default() -> Self {\n        Self::new()"
        );
        expect(render(1).types).not.toContain("impl Default for SamplePlanOptions");
    });

    it("rejects optional requests", () => {
        const { schema, params } = legacyRequestSchema(1);
        const method = (schema.server as Record<string, Record<string, { params: unknown }>>).sample
            .plan;
        method.params = { anyOf: [{ not: {} }, params] };
        expect(() => generateApiTypesCode(schema)).toThrow(
            "Invalid x-legacy-parameters for sample.plan: optional requests cannot declare legacy parameters"
        );
    });

    it("keeps an annotated response record as a Default struct with every field", () => {
        const record = (required: string[]) =>
            ({
                definitions: {
                    SampleServer: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            owned: { type: "string" },
                            status: { type: "string" },
                        },
                        required,
                        "x-legacy-parameters": ["name", "status"],
                    },
                },
            }) as ApiSchema;
        const types = generateApiTypesCode(record(["name", "status"]));
        expect(types).toMatch(
            /#\[derive\(Debug, Clone, Default, Serialize, Deserialize\)\]\n#\[serde\(rename_all = "camelCase"\)\]\npub struct SampleServer \{/
        );
        expect(types).toContain("pub owned: Option<String>,");
        expect(types).not.toContain("SampleServerOptions");
    });

    it("rejects an annotated response record that cannot derive Default", () => {
        const schema = {
            definitions: {
                Inner: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
                SampleServer: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        inner: { $ref: "#/definitions/Inner" },
                        owned: { type: "string" },
                    },
                    required: ["name", "inner"],
                    "x-legacy-parameters": ["name", "inner"],
                },
            },
        } as ApiSchema;
        expect(() => generateApiTypesCode(schema, ["Inner"])).toThrow(
            "Invalid x-legacy-parameters for SampleServer: a response record must be a struct that derives Default"
        );
    });

    it("rejects metadata that omits a required input", () => {
        const { schema, params } = legacyRequestSchema(1);
        (params as Record<string, unknown>)["x-legacy-parameters"] = ["contract", "scope"];
        expect(() => generateApiTypesCode(schema)).toThrow(
            "Invalid x-legacy-parameters for sample.plan: required property source must be a legacy parameter"
        );
    });

    it("gives each titled const discriminator its own Rust type", () => {
        const code = generateApiTypesCode({
            definitions: {
                Review: {
                    anyOf: ["install", "uninstall"].map((action) => ({
                        type: "object",
                        required: ["action"],
                        properties: {
                            action: { type: "string", const: action, title: "ReviewAction" },
                        },
                    })),
                },
                Holder: {
                    type: "object",
                    required: ["review"],
                    properties: { review: { $ref: "#/definitions/Review" } },
                },
            },
        } as ApiSchema);

        expect(code).toMatch(
            /pub enum Review\w*InstallAction \{\n(?:.*\n)*?\s+#\[serde\(rename = "install"\)\]/
        );
        expect(code).toMatch(
            /pub enum Review\w*UninstallAction \{\n(?:.*\n)*?\s+#\[serde\(rename = "uninstall"\)\]/
        );
        expect(code).not.toContain("pub enum ReviewAction");
    });

    it("refuses to reuse a string enum name for a different value set", () => {
        expect(() =>
            generateApiTypesCode({
                definitions: {
                    Kind: { type: "string", enum: ["a", "b"] },
                    Owner: {
                        type: "object",
                        required: ["kind", "mode"],
                        properties: {
                            kind: { $ref: "#/definitions/Kind" },
                            mode: { type: "string", enum: ["c"], title: "Kind" },
                        },
                    },
                },
            } as ApiSchema)
        ).toThrow(/Rust string enum Kind is requested for different values/);
    });

    it("keeps every const discriminator of the committed API schema distinct in Rust", () => {
        // Mirror the generator's own schema preparation so emission order matches.
        const schema = propagateInternalVisibility(
            postProcessSchema(
                stripBooleanLiterals(
                    normalizeSchemaBrandCasing(
                        JSON.parse(
                            readFileSync(
                                new URL("../../../../generated/api.schema.json", import.meta.url),
                                "utf8"
                            )
                        ) as ApiSchema
                    )
                ) as JSONSchema7
            )
        ) as unknown as ApiSchema;
        // Generation throws if two const literals would share one enum name.
        const code = generateApiTypesCode(schema);

        const enumValues = new Map<string, string[]>();
        for (const match of code.matchAll(/^pub enum (\w+) \{\n([\s\S]*?)^\}/gm)) {
            enumValues.set(
                match[1],
                [...match[2].matchAll(/rename = "([^"]+)"/g)].map((m) => m[1])
            );
        }
        const unions: Array<{ owner: string; variants: unknown[] }> = [];
        const visit = (node: unknown, owner: string): void => {
            if (typeof node !== "object" || node === null) return;
            const record = node as Record<string, unknown>;
            for (const key of ["anyOf", "oneOf"] as const) {
                if (Array.isArray(record[key]))
                    unions.push({ owner, variants: record[key] as unknown[] });
            }
            for (const [key, value] of Object.entries(record)) visit(value, `${owner}/${key}`);
        };
        visit(schema, "api.schema.json");

        let checked = 0;
        for (const { owner, variants } of unions) {
            const discriminators = variants.map((variant) => {
                const properties = (variant as JSONSchema7).properties ?? {};
                return Object.entries(properties).filter(
                    ([name, prop]) =>
                        typeof prop === "object" &&
                        typeof prop.const === "string" &&
                        (variant as JSONSchema7).required?.includes(name) &&
                        !prop.$ref
                );
            });
            for (const [name] of discriminators[0] ?? []) {
                const values = discriminators.map(
                    (entries) => entries.find(([key]) => key === name)?.[1].const
                );
                if (
                    values.some((value) => typeof value !== "string") ||
                    new Set(values).size !== values.length
                )
                    continue;
                const titles = new Set(
                    discriminators.map(
                        (entries) =>
                            (entries.find(([key]) => key === name)?.[1] as JSONSchema7).title
                    )
                );
                if (titles.size !== 1 || [...titles][0] === undefined) continue;
                // Shared-title literals must each map to an enum accepting exactly that value.
                for (const value of values as string[]) {
                    const matching = [...enumValues].filter(
                        ([, accepted]) => accepted.length === 1 && accepted[0] === value
                    );
                    expect(matching.length, `${owner}.${name} = ${value}`).toBeGreaterThan(0);
                }
                checked += 1;
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    it("reuses a released value enum for a const whose name matches it, as released output does", () => {
        const code = generateApiTypesCode({
            definitions: {
                RefType: { type: "string", enum: ["issue", "pr"] },
                Ref: {
                    type: "object",
                    required: ["referenceType", "type"],
                    properties: {
                        referenceType: { $ref: "#/definitions/RefType" },
                        type: { type: "string", const: "reference" },
                    },
                },
            },
        } as ApiSchema);
        expect(code).toContain("pub reference_type: RefType,");
        expect(code).toContain("pub r#type: RefType,");
        expect(code.match(/pub enum RefType \{/g)).toHaveLength(1);
    });
});

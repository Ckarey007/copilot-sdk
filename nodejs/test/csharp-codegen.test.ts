import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";

import { generateRpcCode, generateSessionEventsCode } from "../../scripts/codegen/csharp.ts";
import type { ApiSchema, RpcMethod } from "../../scripts/codegen/utils.ts";
import { postProcessSchema } from "../../scripts/codegen/utils.ts";
import { legacyRequestSchema } from "./legacy-parameters-fixture.ts";
import {
    callbackFixture,
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

describe("C# shared schema baseline", () => {
    it("renders types, server/session calls, and nested namespaces", () => {
        const code = generateRpcCode(rpcFixture());
        for (const field of [
            "public string Id",
            "public int Count",
            "public bool Active",
            "public double Score",
            "public IList<string> Tags",
            "public IDictionary<string, string> Labels",
            "public string? DisplayName",
            "public string? Note",
            "public IList<SampleItem> Items",
        ])
            expect(code).toContain(field);
        expect(code.match(/public sealed class SampleItem\n/g)).toHaveLength(1);
        expect(code).toContain('[JsonPropertyName("displayName")]');
        expect(code).toContain(
            "GetAsync(string id, CancellationToken cancellationToken = default)"
        );
        expect(code).toContain('InvokeRpcAsync<SampleItem>(_rpc, "sample.get"');
        expect(code).toContain('InvokeRpcAsync<SampleListResult>(_rpc, "sample.nested.list"');
        expect(code).toContain("Task PingAsync(CancellationToken cancellationToken = default)");
        expect(code).toContain("SessionId = _session.SessionId");
        expect(code).toContain('"session.sample.get"');
        expect(code).toContain("[JsonSerializable(typeof(SampleItem))]");
        expect(code).toMatchSnapshot();
    });

    it("renders optional requests without requiring an argument", () => {
        const code = generateRpcCode(optionalRequestFixture());
        expect(code).toContain("ConfigureAsync(CancellationToken cancellationToken = default)");
        expect(code).toContain('InvokeRpcAsync(_rpc, "sample.configure", [], cancellationToken);');
        expect(code).toContain(
            "ConfigureAsync(SampleConfigureRequest request, CancellationToken cancellationToken = default)"
        );
        expect(code).toContain("public bool? Enabled");
    });

    it.each(["anyOf", "oneOf"] as const)("renders referenced %s unions and enums", (keyword) => {
        const code = generateRpcCode(unionFixture(keyword));
        expect(code).toContain('[JsonDerivedType(typeof(SampleChoiceText), "text")]');
        expect(code).toContain('[JsonDerivedType(typeof(SampleChoiceCount), "count")]');
        expect(code).toContain("public SampleChoice Choice");
        expect(code).toContain("public IList<SampleChoice> Choices");
        expect(code).toContain('public static SampleMode Fast { get; } = new("fast");');
        expect(code).toContain('public static SampleMode Thorough { get; } = new("thorough");');
        expect(code).toContain("[JsonSerializable(typeof(SampleChoice))]");
    });

    it("preserves method documentation and exposure annotations", () => {
        const code = generateRpcCode(metadataFixture());
        expect(code).toContain("Preview an item.");
        expect(code).toContain(
            "[Experimental(global::GitHub.Copilot.Diagnostics.Experimental)]\n    public async Task<SamplePreviewResult> PreviewAsync("
        );
        expect(code).toMatch(
            /\[Obsolete\("This member is deprecated[^\n]+\n#endif\n    public async Task RetiredAsync\(/
        );
        expect(code).toContain("internal async Task HiddenAsync(");
        expect(code).not.toContain("public async Task HiddenAsync(");
    });

    it.each(["clientSession", "clientGlobal"] as const)(
        "renders %s callback registration",
        (scope) => {
            const code = generateRpcCode(callbackFixture(scope));
            expect(code).toContain("ValueTask<SampleConfirmResult>");
            expect(code).toContain('rpc.SetLocalRpcMethod("sample.confirm"');
            expect(code).toContain('rpc.SetLocalRpcMethod("sample.changed"');
            if (scope === "clientSession") {
                expect(code).toContain("getHandlers(request.SessionId)");
                expect(code).not.toContain('"sample.hidden"');
            } else {
                expect(code).toContain("ClientGlobalApiHandlers handlers");
                expect(code).toContain("handlers.Sample");
            }
        }
    );

    it("renders event payloads and serializer registrations", () => {
        const code = generateSessionEventsCode(eventFixture());
        expect(code).toContain('[JsonDerivedType(typeof(SampleUpdatedEvent), "sample.updated")]');
        expect(code).toContain("public required int Sequence");
        expect(code).toContain("public string? Note");
        expect(code).toContain("public required SampleUpdatedData Data");
        expect(code).toContain("[JsonSerializable(typeof(SampleUpdatedEvent))]");
        expect(code).toMatchSnapshot();
    });

    it("keeps existing signatures when a response gains an optional field", () => {
        const before = generateRpcCode(rpcFixture());
        const after = generateRpcCode(rpcFixture({ extra: { type: "string" } }));
        const signature =
            "Task<SampleItem> GetAsync(string id, CancellationToken cancellationToken = default)";
        expect(before).toContain(signature);
        expect(after).toContain(signature);
        expect(before).not.toContain("string? Extra");
        expect(after).toContain("public string? Extra { get; set; }");
    });
});

describe("C# schema contract matrix", () => {
    it.each([
        ["scalar", "string", "{ get; set; } = string.Empty;"],
        ["object", "PresenceValue", "{ get => field ??= new(); set; }"],
        ["array", "IList<PresenceValue>", "{ get => field ??= []; set; }"],
        [
            "map",
            "IDictionary<string, PresenceValue>",
            "{ get => field ??= new Dictionary<string, PresenceValue>(); set; }",
        ],
    ] as const)("preserves required and nullable %s property types", (shape, type, initializer) => {
        const code = generateRpcCode(presenceFixture(shape));
        const declaration = code.match(
            /^public sealed class SamplePresenceResult\n\{[\s\S]*?^\}/m
        )?.[0];
        expect(declaration).toContain(`public ${type} RequiredValue ${initializer}`);
        for (const name of ["OptionalValue", "RequiredNullable", "OptionalNullable"])
            expect(declaration).toContain(`public ${type}? ${name} { get; set; }`);
        expect(declaration).toContain('[JsonPropertyName("requiredNullable")]');
    });

    it("shares multi-hop reference classes across request and result models", () => {
        const code = generateRpcCode(referenceFixture());
        for (const name of ["ReferenceNode", "ReferenceLeaf"])
            expect(code.match(new RegExp(`^public sealed class ${name}\\n`, "gm"))).toHaveLength(1);
        expect(code.match(/^public sealed class ReferenceNode\n\{[\s\S]*?^\}/m)?.[0]).toContain(
            "public ReferenceLeaf Leaf"
        );
        for (const name of ["SampleGraphRequest", "SampleGraphResult"]) {
            const declaration = code.match(
                new RegExp(`^(?:public|internal) sealed class ${name}\\n\\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            for (const field of [
                "ReferenceNode First",
                "ReferenceNode Second",
                "IList<ReferenceNode> Nodes",
                "IDictionary<string, ReferenceNode> Lookup",
            ])
                expect(declaration).toContain(`public ${field}`);
        }
        expect(code).toContain("[JsonSerializable(typeof(ReferenceNode))]");
        expect(code).toContain("[JsonSerializable(typeof(ReferenceLeaf))]");
    });

    it("keeps empty object classes distinct from open maps and opaque JsonElement", () => {
        const code = generateRpcCode(jsonShapesFixture());
        expect(code.match(/^public sealed class JsonShapesEmpty\n\{[\s\S]*?^\}/m)?.[0]).toBe(
            "public sealed class JsonShapesEmpty\n{\n}"
        );
        const declaration = code.match(/^public sealed class JsonShapes\n\{[\s\S]*?^\}/m)?.[0];
        expect(declaration).toContain("public JsonShapesEmpty Empty");
        expect(declaration).toContain("public IDictionary<string, JsonElement> Open");
        expect(declaration).toContain("public JsonElement Opaque");
    });

    it.each(["anyOf", "oneOf"] as const)(
        "registers nested %s union variants without changing existing declarations",
        (keyword) => {
            const before = generateRpcCode(nestedUnionFixture(keyword));
            const after = generateRpcCode(nestedUnionFixture(keyword, true));
            for (const code of [before, after]) {
                const result = code.match(
                    /^public sealed class SampleDecideResult\n\{[\s\S]*?^\}/m
                )?.[0];
                expect(result).toContain("public Verdict? Selected");
                expect(result).toContain("public IDictionary<string, Verdict> Decisions");
                for (const variant of ["Allow", "Deny"]) {
                    expect(code).toContain(
                        `[JsonDerivedType(typeof(Verdict${variant}), "${variant.toLowerCase()}")]`
                    );
                    expect(code).toContain(`public partial class Verdict${variant} : Verdict\n`);
                }
                expect(code).toContain("[JsonSerializable(typeof(Verdict))]");
            }
            expect(before).not.toContain("VerdictPending");
            expect(after).toContain('[JsonDerivedType(typeof(VerdictPending), "pending")]');
            expect(after).toContain("public partial class VerdictPending : Verdict\n");
            const declaration = /^public partial class VerdictAllow : Verdict\n\{[\s\S]*?^\}/m;
            expect(before).toMatch(declaration);
            expect(after.match(declaration)?.[0]).toBe(before.match(declaration)?.[0]);
        }
    );

    it("represents boolean-discriminated results with boolean wire values", () => {
        const code = generateRpcCode(booleanUnionFixture());
        const declaration = code.match(
            /^public partial class SampleAcceptResult\n\{[\s\S]*?^\}/m
        )?.[0];
        expect(declaration).toContain('[JsonPropertyName("queued")]\n    public bool Queued');
        expect(declaration).toContain("public string? Reason");
        expect(declaration).toContain("public string? Value");
        expect(declaration).not.toContain("public string Queued");
    });

    it("preserves wire names independently of PascalCase property names", () => {
        const code = generateRpcCode(namingFixture());
        const declaration = code.match(/^public sealed class WireNames\n\{[\s\S]*?^\}/m)?.[0];
        for (const [wire, type, name] of [
            ["class", "string", "Class"],
            ["default", "bool", "Default"],
            ["type", "string", "Type"],
            ["requestId", "string", "RequestId"],
            ["content-type", "string", "ContentType"],
        ])
            expect(declaration).toContain(
                `[JsonPropertyName("${wire}")]\n    public ${type} ${name}`
            );
    });

    it("keeps internal results internal without hiding shared public dependencies", () => {
        const code = generateRpcCode(visibilityFixture());
        expect(code).toContain("internal sealed class SampleSecretResult\n");
        expect(code).toContain("internal async Task<SampleSecretResult> SecretAsync(");
        expect(code).toContain("public async Task<SampleVisibleResult> VisibleAsync(");
        expect(code).toContain("internal async Task<HostSecretResult> SecretAsync(");
        expect(code).toContain("public async Task<HostVisibleResult> VisibleAsync(");
        expect(code).not.toContain("public async Task<HostSecretResult> SecretAsync(");
        expect(code.match(/^public sealed class SharedValue\n/gm)).toHaveLength(1);
        expect(code).not.toContain("internal sealed class SharedValue");
        expect(code).not.toContain("public sealed class SampleSecretResult");
    });

    it("registers every event and its empty, object, or union payload", () => {
        const code = generateSessionEventsCode(eventMatrixFixture());
        expect(
            [
                ...code.matchAll(
                    /\[JsonDerivedType\(typeof\((Matrix\w+Event)\), "matrix\.(\w+)"\)\]/g
                ),
            ].map((match) => [match[1], match[2]])
        ).toEqual([
            ["MatrixEmptyEvent", "empty"],
            ["MatrixUnionEvent", "union"],
            ["MatrixValueEvent", "value"],
        ]);
        for (const name of ["Empty", "Union", "Value"]) {
            const event = code.match(
                new RegExp(
                    `^public sealed partial class Matrix${name}Event : SessionEvent\\n\\{[\\s\\S]*?^\\}`,
                    "m"
                )
            )?.[0];
            expect(event).toContain(`public required Matrix${name}Data Data`);
            expect(code).toContain(`[JsonSerializable(typeof(Matrix${name}Event))]`);
            expect(code).toContain(`[JsonSerializable(typeof(Matrix${name}Data))]`);
        }
        expect(code).toContain('[JsonDerivedType(typeof(MatrixUnionDataFirst), "first")]');
        expect(code).toContain('[JsonDerivedType(typeof(MatrixUnionDataSecond), "second")]');
    });

    it("does not retain declarations or serializer registrations between schemas", () => {
        const before = generateRpcCode(referenceFixture());
        const eventsBefore = generateSessionEventsCode(eventFixture());
        generateRpcCode(nestedUnionFixture("oneOf", true));
        generateSessionEventsCode(eventMatrixFixture());
        expect(generateRpcCode(referenceFixture())).toBe(before);
        expect(generateSessionEventsCode(eventFixture())).toBe(eventsBefore);
    });
});

describe("C# RPC dictionaries", () => {
    it.each([undefined, true, { type: "string" } as const])(
        "retains open object entries with additionalProperties=%j",
        (additionalProperties) => {
            const dictionary: JSONSchema7 = {
                type: "object",
                properties: {},
                ...(additionalProperties === undefined ? {} : { additionalProperties }),
            };
            const schema: ApiSchema = {
                server: {
                    sample: {
                        read: {
                            rpcMethod: "sample.read",
                            params: {
                                title: "SampleRequest",
                                type: "object",
                                properties: { environment: dictionary },
                                required: ["environment"],
                            },
                            result: {
                                title: "SampleResult",
                                type: "object",
                                properties: {
                                    settings: dictionary,
                                    referenced: { $ref: "#/definitions/Dictionary" },
                                    entries: { type: "array", items: dictionary },
                                    closed: {
                                        type: "object",
                                        properties: {},
                                        additionalProperties: false,
                                    },
                                },
                            },
                        },
                    },
                },
                definitions: { Dictionary: dictionary },
            };
            const before = structuredClone(schema);
            const code = generateRpcCode(schema);
            const valueType = typeof additionalProperties === "object" ? "string" : "JsonElement";
            expect(code).toContain(`IDictionary<string, ${valueType}> Environment`);
            expect(code).toContain(`IDictionary<string, ${valueType}>? Settings`);
            expect(code).toContain(`IDictionary<string, ${valueType}>? Referenced`);
            expect(code).toContain(`IList<IDictionary<string, ${valueType}>>? Entries`);
            expect(code).toContain("class SampleResultClosed");
            expect(code).not.toContain("class SampleRequestEnvironment");
            expect(code).not.toContain("class SampleResultSettings");
            expect(schema).toEqual(before);
        }
    );
});

function legacySignatureFixture(scope: "server" | "session", legacy: unknown) {
    const params: JSONSchema7 & { "x-legacy-parameters"?: unknown } = {
        title: "SampleRequest",
        type: "object",
        properties: {
            ...(scope === "session" ? { sessionId: { type: "string" as const } } : {}),
            name: { type: "string" },
            config: { "x-opaque-json": true } as JSONSchema7,
            expectedIdentity: { type: "string" },
        },
        required: scope === "session" ? ["sessionId", "name"] : ["name"],
        additionalProperties: false,
    };
    if (legacy !== undefined) params["x-legacy-parameters"] = legacy;
    const methods: Record<string, RpcMethod> = {
        run: {
            rpcMethod: `${scope === "session" ? "session." : ""}sample.run`,
            params,
            result: null,
        },
    };
    const schema: ApiSchema = { [scope]: { sample: methods } };
    return { schema, params, methods };
}

describe("C# required opaque JSON parameters", () => {
    it.each(["server", "session"] as const)("preserves JSON null in %s requests", (scope) => {
        const { schema, params } = legacySignatureFixture(scope, undefined);
        params.required!.push("config");
        const code = generateRpcCode(schema);

        expect(code).toContain("RunAsync(string name, object? config,");
        expect(code).toContain(
            'Config = CopilotClient.ToJsonElementForWire(config) ?? JsonElement.Parse("null")'
        );
        expect(code).not.toContain("ArgumentNullException.ThrowIfNull(config);");
        expect(code).toContain("ArgumentNullException.ThrowIfNull(name);");
    });
});

describe("C# additive request entry compatibility", () => {
    it("preserves the legacy login signature and exposes new inputs through the request overload", () => {
        const { schema } = legacySignatureFixture("session", ["kind"]);
        const methods = schema.session!.sample as Record<string, RpcMethod>;
        const method = methods.run;
        methods.begin = method;
        delete methods.run;
        schema.definitions = {
            LoginProviderKind: { type: "string", enum: ["github", "entra"] },
            AuthLoginMode: { type: "string", enum: ["default", "selectAccount"] },
        };
        method.rpcMethod = "session.accounts.login.begin";
        method.params = {
            title: "AuthLoginBeginRequest",
            type: "object",
            properties: {
                sessionId: { type: "string" },
                kind: { $ref: "#/definitions/LoginProviderKind" },
                mode: { $ref: "#/definitions/AuthLoginMode" },
                accountId: { type: "string" },
            },
            required: ["sessionId", "kind"],
            "x-legacy-parameters": ["kind"],
        };

        const code = generateRpcCode(schema);

        expect(code).toContain(
            "BeginAsync(LoginProviderKind kind, CancellationToken cancellationToken = default)"
        );
        expect(code).toContain(
            "BeginAsync(AuthLoginBeginRequest request, CancellationToken cancellationToken = default)"
        );
        expect(code).toContain("public AuthLoginMode? Mode { get; set; }");
        expect(code).toContain("public string? AccountId { get; set; }");
        expect(code).toContain(
            "new AuthLoginBeginRequestWithSession { SessionId = _session.SessionId, Kind = request.Kind, Mode = request.Mode, AccountId = request.AccountId }"
        );
        expect(code).not.toContain("CancellationToken cancellationToken = default, AuthLoginMode?");
    });

    it("preserves cancellation-token calls when a server method gains optional parameters", () => {
        const params = { $ref: "#/definitions/ModelsListRequest" };
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
        const code = generateRpcCode({
            definitions: {
                ModelsListRequest: optionalRequest,
            },
            server: {
                models: {
                    list: { rpcMethod: "models.list", params, result: null },
                    listTokenPriceUnits: {
                        rpcMethod: "models.listTokenPriceUnits",
                        params: optionalRequest,
                        result: null,
                    },
                },
            },
        });

        expect(code).toContain(
            "ListTokenPriceUnitsAsync(CancellationToken cancellationToken = default)"
        );
        expect(code).toContain(
            "ListTokenPriceUnitsAsync(ModelsListTokenPriceUnitsRequest request, CancellationToken cancellationToken = default)"
        );
        expect(code).toContain(
            "ListAsync(string? selectionId = null, string? gitHubToken = null, CancellationToken cancellationToken = default)"
        );
        expect(code).toContain("public sealed class ModelsListTokenPriceUnitsRequest\n");
        expect(code).toContain("public string? SelectionId { get; set; }");
        expect(code).toContain("public string? GitHubToken { get; set; }");
        expect(code).toContain(
            '(_rpc, "models.listTokenPriceUnits", [request], cancellationToken)'
        );
    });

    it.each(["server", "session"] as const)(
        "preserves the exact legacy %s signature and adds a same-name request overload",
        (scope) => {
            const { schema } = legacySignatureFixture(scope, ["name", "config"]);
            const code = generateRpcCode(schema);
            expect(code).toContain(
                "RunAsync(string name, object? config = null, CancellationToken cancellationToken = default)"
            );
            expect(code).toContain(
                "RunAsync(SampleRequest request, CancellationToken cancellationToken = default)"
            );
            expect(code).not.toContain("WithRequestAsync");
            expect(code).toContain("public sealed class SampleRequest\n");
            expect(code).toContain("public required string Name { get; set; }");
            expect(code).toContain("ArgumentNullException.ThrowIfNull(request);");
            expect(code).toContain("ArgumentNullException.ThrowIfNull(request.Name);");
            expect(code).toContain("Config = CopilotClient.ToJsonElementForWire(config)");
            expect(code).not.toContain("ExpectedIdentity = expectedIdentity");
            if (scope === "session") {
                expect(code).toContain("internal sealed class SampleRequestWithSession\n");
                expect(code).toContain(
                    "new SampleRequestWithSession { SessionId = _session.SessionId, Name = request.Name, Config = request.Config, ExpectedIdentity = request.ExpectedIdentity }"
                );
                const publicRequest = code.match(
                    /public sealed class SampleRequest\n\{[\s\S]*?\n\}/
                )?.[0];
                expect(publicRequest).toBeDefined();
                expect(publicRequest).not.toContain("SessionId");
                expect(code).toContain("[JsonSerializable(typeof(SampleRequestWithSession))]");
            } else {
                expect(code).toContain('(_rpc, "sample.run", [request], cancellationToken)');
            }
        }
    );

    it.each(["server", "session"] as const)(
        "leaves unmarked %s method output unchanged",
        (scope) => {
            const { schema, methods, params } = legacySignatureFixture(scope, undefined);
            methods.control = {
                ...methods.run,
                rpcMethod: methods.run.rpcMethod.replace(/run$/, "control"),
                params: { ...params, title: "ControlRequest" },
            };
            const before = generateRpcCode(schema);
            params["x-legacy-parameters"] = ["name", "config"];
            const after = generateRpcCode(schema);
            const method = /    public async Task ControlAsync\([\s\S]*?\n    \}/;
            const request = /internal sealed class ControlRequest\n\{[\s\S]*?\n\}/;
            expect(before.match(method)?.[0]).toBeDefined();
            expect(after.match(method)?.[0]).toBe(before.match(method)?.[0]);
            expect(before.match(request)?.[0]).toBeDefined();
            expect(after.match(request)?.[0]).toBe(before.match(request)?.[0]);
            expect(before).not.toContain("WithRequestAsync");
            expect(after).not.toContain("ControlWithRequestAsync");
        }
    );

    it.each([
        ["not an array", "name"],
        ["non-string", ["name", 1]],
        ["duplicate", ["name", "name"]],
        ["unknown", ["name", "missing"]],
        ["session envelope", ["sessionId", "name"]],
        ["missing required", ["config"]],
        ["optional before required", ["config", "name"]],
        ["no new arguments", ["name", "config", "expectedIdentity"]],
    ])("rejects invalid legacy metadata: %s", (_reason, legacy) => {
        const { schema } = legacySignatureFixture("session", legacy);
        expect(() => generateRpcCode(schema)).toThrow("Invalid x-legacy-parameters");
    });

    it("rejects nullable request metadata rather than changing the existing request entry", () => {
        const { schema, methods, params } = legacySignatureFixture("session", ["name", "config"]);
        methods.run.params = { anyOf: [params, { type: "null" }] };
        expect(() => generateRpcCode(schema)).toThrow("nullable requests");
    });

    it("keeps both overloads unchanged across two successive optional additions", () => {
        const signatures = (additions: 1 | 2) => {
            const code = generateRpcCode(legacyRequestSchema(additions).schema);
            return {
                code,
                overloads: code.match(/public async Task<[A-Za-z]+> PlanAsync\([^)]*\)/g),
            };
        };
        const one = signatures(1);
        const two = signatures(2);
        expect(one.overloads).toEqual([
            "public async Task<SamplePlanResult> PlanAsync(string contract, string source, string? scope = null, CancellationToken cancellationToken = default)",
            "public async Task<SamplePlanResult> PlanAsync(SamplePlanRequest request, CancellationToken cancellationToken = default)",
        ]);
        expect(two.overloads).toEqual(one.overloads);
        expect(one.code).not.toContain("TraceId");
        expect(two.code).toContain("public string? TraceId { get; set; }");
        expect(two.code).toContain("public required string Contract { get; set; }");
    });
});

describe("C# session event deprecation", () => {
    it.each([
        { eventDeprecated: true, dataDeprecated: false },
        { eventDeprecated: false, dataDeprecated: true },
        { eventDeprecated: true, dataDeprecated: true },
        { eventDeprecated: false, dataDeprecated: false },
    ])(
        "preserves target-compatible event=$eventDeprecated and payload=$dataDeprecated annotations",
        ({ eventDeprecated, dataDeprecated }) => {
            const code = generateSessionEventsCode({
                definitions: {
                    Payload: {
                        type: "object",
                        properties: { toolCallId: { type: "string" } },
                        ...(dataDeprecated ? { deprecated: true } : {}),
                    },
                    SessionEvent: {
                        anyOf: [
                            {
                                type: "object",
                                ...(eventDeprecated ? { deprecated: true } : {}),
                                properties: {
                                    type: { const: "tool.execution_partial_result" },
                                    data: { $ref: "#/definitions/Payload" },
                                },
                                required: ["type", "data"],
                            },
                        ],
                    },
                },
            });
            const attributes = [
                "[EditorBrowsable(EditorBrowsableState.Never)]",
                "#if NET5_0_OR_GREATER",
                '[Obsolete("This member is deprecated and will be removed in a future version.", DiagnosticId = "GHCP001")]',
                "#else",
                '[Obsolete("This member is deprecated and will be removed in a future version.")]',
                "#endif",
            ].join("\n");

            for (const [name, deprecated] of [
                ["ToolExecutionPartialResultEvent", eventDeprecated],
                ["ToolExecutionPartialResultData", dataDeprecated],
            ] as const) {
                const declaration = `${attributes}\npublic sealed partial class ${name}`;
                if (deprecated) expect(code).toContain(declaration);
                else expect(code).not.toContain(declaration);
            }
            expect(code.match(/\[Obsolete\(/g) ?? []).toHaveLength(
                2 * (Number(eventDeprecated) + Number(dataDeprecated))
            );
        }
    );
});

describe("C# root event payload unions", () => {
    it.each(["anyOf", "oneOf"] as const)("preserves referenced %s payload variants", (keyword) => {
        const code = generateSessionEventsCode({
            definitions: {
                Payload: {
                    [keyword]: ["status", "startup", "server_error", "incremental"].map((kind) => ({
                        type: "object",
                        properties: { kind: { const: kind }, value: { type: "string" } },
                        required: ["kind", "value"],
                    })),
                },
                SessionEvent: {
                    anyOf: [
                        {
                            type: "object",
                            properties: {
                                type: { const: "sample.union" },
                                data: { $ref: "#/definitions/Payload" },
                            },
                            required: ["type", "data"],
                        },
                        {
                            type: "object",
                            properties: {
                                type: { const: "sample.empty" },
                                data: { type: "object", properties: {} },
                            },
                            required: ["type", "data"],
                        },
                    ],
                },
            },
        });
        expect(code).toContain("public required SampleUnionData Data");
        expect(code).toContain('TypeDiscriminatorPropertyName = "kind"');
        for (const suffix of ["Status", "Startup", "ServerError", "Incremental"]) {
            expect(code).toContain(
                `public sealed partial class SampleUnionData${suffix} : SampleUnionData`
            );
            expect(code).toContain(`[JsonSerializable(typeof(SampleUnionData${suffix}))]`);
        }
        expect(code).toContain("public required string Value");
        expect(code).toContain("public sealed partial class SampleEmptyData");
        expect(code).not.toContain("public sealed partial class SampleUnionData { }");
    });
});

describe("C# session event dispatch", () => {
    it.each([
        ["sample.\u00E9", 9],
        ["sample.\u{1F600}", 11],
        ["sample.'\\", 9],
    ])("groups and compares UTF-8 discriminators for %s", (discriminator, byteLength) => {
        const code = generateSessionEventsCode({
            definitions: {
                SessionEvent: {
                    anyOf: [
                        {
                            type: "object",
                            properties: {
                                type: { const: discriminator },
                                data: { type: "object", properties: {} },
                            },
                            required: ["type", "data"],
                        },
                    ],
                },
            },
        });

        expect(code).toContain(`case ${byteLength}:`);
        expect(code).toContain(`type.SequenceEqual(${JSON.stringify(discriminator)}u8)`);
        expect(code).toContain("switch (type.Length)");
        expect(code).not.toContain("switch (type)");
    });

    it("generates concrete dispatch and a schema-derived fallback envelope", () => {
        const code = generateSessionEventsCode({
            definitions: {
                SessionEvent: {
                    anyOf: ["sample.first", "sample.second"].map((type) => ({
                        type: "object",
                        properties: {
                            id: { type: "string", format: "uuid" },
                            futureEnvelopeField: { type: "string" },
                            type: { const: type },
                            data: { type: "object", properties: {} },
                        },
                        required: ["id", "type", "data"],
                    })),
                },
            },
        });

        for (const suffix of ["First", "Second"]) {
            expect(code).toContain(`type.SequenceEqual("sample.${suffix.toLowerCase()}"u8)`);
            expect(code).toContain(`return SessionEventsJsonContext.Default.Sample${suffix}Event;`);
            expect(code).toContain(`[JsonSerializable(typeof(Sample${suffix}Event))]`);
        }
        expect(code).toContain("switch (type.Length)");
        expect(code).toContain("SessionEventJsonConverter.Deserialize(json)");
        expect(code).toContain("ReadEventTypeInfo(ref probe)");
        expect(code).toContain('reader.ValueTextEquals("type"u8)');
        expect(code).toContain("internal sealed class SessionEventEnvelope");
        expect(code).toContain("[JsonSerializable(typeof(SessionEventEnvelope))]");
        expect(code).toContain("Id = Id,");
        expect(code).toContain("FutureEnvelopeField = FutureEnvelopeField,");
        expect(code.match(/public string\? FutureEnvelopeField \{ get; set; \}/g)).toHaveLength(2);
        expect(code).toContain(
            "JsonSerializer.Serialize(this, SessionEventsJsonContext.Default.SessionEvent)"
        );
    });
});

describe("C# RPC codegen", () => {
    it("emits parameterless MCP list methods", () => {
        const code = generateRpcCode({
            session: {
                mcp: {
                    list: {
                        rpcMethod: "session.mcp.list",
                        params: null,
                    },
                },
            },
        });
        expect(code).toContain(
            "public async Task ListAsync(CancellationToken cancellationToken = default)"
        );
        expect(code).not.toContain("ListWithParamsAsync");
        expect(code).not.toContain("StartServers");
        expect(code).toContain('"session.mcp.list"');
    });

    it("uses ordinal identity for open tiers without changing closed string enums", () => {
        const tier = {
            type: "string",
            title: "AutoTier",
            "x-extensible-enum": ["efficiency", "balance", "intelligence", "fast"],
        };
        const code = generateRpcCode({
            definitions: {
                AutoTier: tier,
                ClosedMode: { type: "string", enum: ["on", "off"] },
            },
            server: {
                sample: {
                    rpcMethod: "sample",
                    params: {
                        type: "object",
                        properties: {
                            tier: { $ref: "#/definitions/AutoTier" },
                            mode: { $ref: "#/definitions/ClosedMode" },
                        },
                    },
                    result: null,
                },
            },
        } as ApiSchema);
        expect(code).toContain(
            "Equals(AutoTier other) => string.Equals(Value, other.Value, StringComparison.Ordinal);"
        );
        expect(code).toContain(
            "Equals(ClosedMode other) => string.Equals(Value, other.Value, StringComparison.OrdinalIgnoreCase);"
        );
        const tierBody = code.match(
            /public readonly struct AutoTier[\s\S]*?public override string ToString/
        );
        expect(tierBody?.[0]).toContain("StringComparer.Ordinal.GetHashCode(Value)");
        expect(tierBody?.[0]).not.toContain("OrdinalIgnoreCase");

        const events = generateSessionEventsCode(
            postProcessSchema({
                definitions: {
                    AutoTier: tier,
                    SessionEvent: {
                        anyOf: [
                            {
                                title: "SampleEvent",
                                type: "object",
                                properties: {
                                    type: { const: "sample" },
                                    data: {
                                        type: "object",
                                        properties: {
                                            autoTier: { $ref: "#/definitions/AutoTier" },
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
            } as JSONSchema7)
        );
        expect(events).toContain(
            "Equals(AutoTier other) => string.Equals(Value, other.Value, StringComparison.Ordinal);"
        );
        expect(events).toContain("StringComparer.Ordinal.GetHashCode(Value)");
    });

    it("retains named extensible tier values and the existing request type", () => {
        const code = generateRpcCode({
            definitions: {
                AutoTier: {
                    type: "string",
                    "x-extensible-enum": ["efficiency", "balance", "intelligence", "fast"],
                },
            },
            server: {
                setAutoTier: {
                    rpcMethod: "session.model.setAutoTier",
                    params: {
                        type: "object",
                        properties: { autoTier: { $ref: "#/definitions/AutoTier" } },
                    },
                    result: { type: "null" },
                },
            },
        } as ApiSchema);
        expect(code).toContain("AutoTier? AutoTier");
        expect(code).toContain('public static AutoTier Balance { get; } = new("balance");');
        expect(code).toContain("public AutoTier(string value)");
    });

    it("preserves arbitrary JSON handoff settings instead of emitting an empty DTO", () => {
        const code = generateRpcCode({
            server: {
                host: {
                    createSession: {
                        rpcMethod: "host.createSession",
                        params: {
                            type: "object",
                            properties: {
                                config: {
                                    type: "object",
                                    properties: {},
                                    additionalProperties: true,
                                },
                            },
                            required: ["config"],
                        },
                        result: { type: "null" },
                    },
                },
            },
        } as ApiSchema);
        expect(code).toContain("IDictionary<string, JsonElement> Config");
        expect(code).not.toContain("class HostCreateSessionParamsConfig");
    });

    it("maps nullable host authentication options to nullable booleans", () => {
        const code = generateRpcCode({
            server: {
                host: {
                    start: {
                        rpcMethod: "host.start",
                        params: {
                            type: "object",
                            properties: { requireConnectionToken: { type: ["boolean", "null"] } },
                        },
                        result: { type: "null" },
                    },
                },
            },
        } as ApiSchema);
        expect(code).toContain("bool? RequireConnectionToken");
    });

    it("keeps inline and referenced boolean literals as boolean RPC fields", () => {
        const code = generateRpcCode({
            definitions: {
                Enabled: { type: "boolean", const: true },
            },
            server: {
                sample: {
                    status: {
                        rpcMethod: "sample.status",
                        result: {
                            type: "object",
                            properties: {
                                enabled: { $ref: "#/definitions/Enabled" },
                                disabled: { type: "boolean", const: false },
                            },
                            required: ["enabled", "disabled"],
                        },
                    },
                },
            },
        } as ApiSchema);
        expect(code).toContain("public bool Enabled { get; set; }");
        expect(code).toContain("public bool Disabled { get; set; }");
        expect(code).not.toContain("readonly record struct Enabled");
    });

    it.each(["uninstall", "update"])(
        "separates the session wire envelope from the shared plugins %s request",
        (method) => {
            const title = `Plugins${method === "uninstall" ? "Uninstall" : "Update"}Request`;
            const params: JSONSchema7 = {
                title,
                type: "object",
                properties: {
                    name: { type: "string" },
                    directSourceId: { type: ["string", "null"] },
                    mode: { type: "string", enum: ["local", "global"] },
                },
                required: ["name"],
                additionalProperties: false,
            };
            const code = generateRpcCode({
                definitions: { [title]: params },
                server: {
                    plugins: {
                        [method]: {
                            rpcMethod: `plugins.${method}`,
                            params: { $ref: `#/definitions/${title}` },
                        },
                    },
                },
                session: {
                    plugins: {
                        [method]: {
                            rpcMethod: `session.plugins.${method}`,
                            params: {
                                ...params,
                                properties: {
                                    sessionId: { type: "string" },
                                    ...params.properties,
                                },
                                required: ["sessionId", "name"],
                            },
                        },
                    },
                },
            });

            expect(code).toContain(`internal sealed class ${title}\n`);
            expect(code).toContain(`internal sealed class ${title}WithSession\n`);
            expect(code).toContain(
                `new ${title}WithSession { SessionId = _session.SessionId, Name = name, DirectSourceId = directSourceId, Mode = mode }`
            );
            expect(code).toContain(
                `new ${title} { Name = name, DirectSourceId = directSourceId, Mode = mode }`
            );
            expect(code).toContain(
                `string name, string? directSourceId = null, ${title}Mode? mode = null, CancellationToken cancellationToken = default`
            );
            expect(code).not.toContain(`${title}WithSessionMode`);
            expect(code).toContain(`[JsonSerializable(typeof(${title}))]`);
            expect(code).toContain(`[JsonSerializable(typeof(${title}WithSession))]`);
        }
    );

    it("still rejects incompatible schemas sharing a request title", () => {
        expect(() =>
            generateRpcCode({
                server: {
                    first: {
                        rpcMethod: "first",
                        params: {
                            title: "SharedRequest",
                            type: "object",
                            properties: { name: { type: "string" } },
                        },
                    },
                    second: {
                        rpcMethod: "second",
                        params: {
                            title: "SharedRequest",
                            type: "object",
                            properties: { count: { type: "integer" } },
                        },
                    },
                },
            })
        ).toThrow('Conflicting RPC class name "SharedRequest"');
    });

    it("does not hide non-envelope differences in a shared session request", () => {
        const params: JSONSchema7 = {
            title: "SharedRequest",
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
        };
        expect(() =>
            generateRpcCode({
                definitions: { SharedRequest: params },
                server: {
                    configure: { rpcMethod: "configure", params },
                },
                session: {
                    configure: {
                        rpcMethod: "session.configure",
                        params: {
                            ...params,
                            properties: {
                                sessionId: { type: "string" },
                                name: { type: "integer" },
                            },
                            required: ["sessionId", "name"],
                        },
                    },
                },
            })
        ).toThrow('Conflicting RPC class name "SharedRequest"');
    });

    it("preserves nullable public requests and their separate session wire type", () => {
        const code = generateRpcCode({
            session: {
                configure: {
                    rpcMethod: "session.configure",
                    params: {
                        anyOf: [
                            { type: "null" },
                            {
                                title: "ConfigureRequest",
                                type: "object",
                                properties: {
                                    sessionId: { type: "string" },
                                    mode: { type: "string", enum: ["local", "global"] },
                                },
                                required: ["sessionId"],
                            },
                        ],
                    },
                },
            },
        });
        expect(code).toContain("public sealed class ConfigureRequest\n");
        expect(code).toContain("internal sealed class ConfigureRequestWithSession\n");
        expect(code).toContain("ConfigureAsync(ConfigureRequest? request = null,");
        expect(code).toContain(
            "new ConfigureRequestWithSession { SessionId = _session.SessionId, Mode = request?.Mode }"
        );
        expect(code).not.toContain("ConfigureRequestWithSessionMode");
    });

    it("preserves session-only wire type names used by handwritten SDK code", () => {
        const params: JSONSchema7 = {
            title: "ModelSwitchToRequest",
            type: "object",
            properties: { modelId: { type: "string" } },
            required: ["modelId"],
        };
        const code = generateRpcCode({
            definitions: { ModelSwitchToRequest: params },
            session: {
                model: {
                    switchTo: {
                        rpcMethod: "session.model.switchTo",
                        params: {
                            ...params,
                            properties: { sessionId: { type: "string" }, ...params.properties },
                            required: ["sessionId", "modelId"],
                        },
                    },
                },
            },
        });
        expect(code).toContain("internal sealed class ModelSwitchToRequest\n");
        expect(code).toContain(
            "new ModelSwitchToRequest { SessionId = _session.SessionId, ModelId = modelId }"
        );
        expect(code).not.toContain("ModelSwitchToRequestWithSession");
    });

    it.each([
        ["anyOf", false],
        ["anyOf", true],
        ["oneOf", false],
        ["oneOf", true],
    ] as const)(
        "preserves the %s hierarchy when adding a variant (nullable: %s)",
        (keyword, nullable) => {
            const jsonSchemaVariant: JSONSchema7 = {
                type: "object",
                properties: {
                    type: { type: "string", const: "json_schema" },
                    jsonSchema: { $ref: "#/definitions/JsonSchemaResponseFormat" },
                },
                required: ["type", "jsonSchema"],
            };
            const nullVariants: JSONSchema7[] = nullable ? [{ type: "null" }] : [];
            const responseFormat: JSONSchema7 = {
                title: "ResponseFormat",
                description: "A provider-native output format.",
                [keyword]: [jsonSchemaVariant, ...nullVariants],
            };
            const schema: ApiSchema = {
                session: {
                    send: {
                        rpcMethod: "session.send",
                        params: {
                            type: "object",
                            title: "SendRequest",
                            properties: {
                                responseFormat: { $ref: "#/definitions/ResponseFormat" },
                                requiredFormat: { $ref: "#/definitions/ResponseFormat" },
                            },
                            required: ["requiredFormat"],
                        },
                    },
                },
                definitions: {
                    ResponseFormat: responseFormat,
                    JsonSchemaResponseFormat: {
                        type: "object",
                        properties: {
                            name: { type: "string" },
                            schema: { "x-opaque-json": true } as JSONSchema7,
                            strict: { type: "boolean" },
                        },
                        required: ["name", "schema"],
                    },
                },
            };
            const code = generateRpcCode(schema);
            const futureCode = generateRpcCode({
                ...schema,
                definitions: {
                    ...schema.definitions,
                    ResponseFormat: {
                        ...responseFormat,
                        [keyword]: [
                            jsonSchemaVariant,
                            {
                                type: "object",
                                properties: { type: { type: "string", const: "text" } },
                                required: ["type"],
                            },
                            ...nullVariants,
                        ],
                    },
                },
            });

            for (const generated of [code, futureCode]) {
                expect(generated).toContain("public partial class ResponseFormat\n");
                expect(generated).toContain("A provider-native output format.");
                expect(generated).toContain(
                    '[JsonPolymorphic(\n    TypeDiscriminatorPropertyName = "type",'
                );
                expect(generated).toContain(
                    '[JsonDerivedType(typeof(ResponseFormatJsonSchema), "json_schema")]'
                );
                expect(generated).toContain(
                    "public partial class ResponseFormatJsonSchema : ResponseFormat"
                );
                expect(generated).toContain('public override string Type => "json_schema";');
                expect(generated).toContain("public ResponseFormat? ResponseFormat");
                expect(generated).toContain(
                    `public ResponseFormat${nullable ? "?" : ""} RequiredFormat`
                );
                expect(generated).toContain("public required JsonSchemaResponseFormat JsonSchema");
                expect(generated).toContain("public JsonElement Schema");
                expect(generated).toContain("public bool? Strict");
                expect(generated).toContain("[JsonSerializable(typeof(ResponseFormat))]");
                expect(generated.match(/public partial class ResponseFormat\b/g)).toHaveLength(1);
            }
            for (const name of ["ResponseFormat", "ResponseFormatJsonSchema"]) {
                const declaration = new RegExp(
                    `public partial class ${name}\\b[^\\n]*\\n\\{[\\s\\S]*?\\n\\}`
                );
                expect(code.match(declaration)?.[0]).toBe(futureCode.match(declaration)?.[0]);
            }
            expect(futureCode).toContain('[JsonDerivedType(typeof(ResponseFormatText), "text")]');
            expect(futureCode).toContain(
                "public partial class ResponseFormatText : ResponseFormat"
            );
        }
    );

    it.each(["anyOf", "oneOf"] as const)(
        "preserves referenced enum discriminators and nested %s unions",
        (keyword) => {
            const code = generateRpcCode({
                session: {
                    configure: {
                        rpcMethod: "session.configure",
                        stability: "experimental",
                        params: {
                            type: "object",
                            properties: {
                                systemMessage: { $ref: "#/definitions/SystemMessage" },
                                requiredMessage: { $ref: "#/definitions/SystemMessage" },
                            },
                            required: ["requiredMessage"],
                        },
                    },
                },
                definitions: {
                    SystemMessage: {
                        description: "System message configuration.",
                        [keyword]: [
                            { $ref: "#/definitions/AppendConfig" },
                            { $ref: "#/definitions/ReplaceConfig" },
                            { $ref: "#/definitions/CustomizeConfig" },
                        ],
                    },
                    AppendMode: { type: "string", enum: ["append"] },
                    ReplaceMode: { type: "string", enum: ["replace"] },
                    CustomizeMode: { type: "string", enum: ["customize"] },
                    AppendConfig: {
                        type: "object",
                        properties: {
                            mode: { $ref: "#/definitions/AppendMode" },
                            content: { type: "string" },
                        },
                    },
                    ReplaceConfig: {
                        type: "object",
                        properties: {
                            mode: { $ref: "#/definitions/ReplaceMode" },
                            content: { type: "string" },
                        },
                        required: ["mode", "content"],
                    },
                    CustomizeConfig: {
                        type: "object",
                        properties: {
                            mode: { $ref: "#/definitions/CustomizeMode" },
                            content: { type: "string" },
                            sections: {
                                type: "object",
                                additionalProperties: {
                                    $ref: "#/definitions/SectionOverride",
                                },
                            },
                        },
                        required: ["mode"],
                    },
                    SectionOverride: {
                        [keyword]: [
                            { $ref: "#/definitions/StaticSectionOverride" },
                            { $ref: "#/definitions/MarkerSectionOverride" },
                        ],
                    },
                    StaticSectionAction: {
                        type: "string",
                        enum: ["replace", "remove", "append", "prepend"],
                    },
                    StaticSectionOverride: {
                        type: "object",
                        properties: {
                            action: { $ref: "#/definitions/StaticSectionAction" },
                            content: { type: "string" },
                        },
                        required: ["action"],
                    },
                    MarkerSectionOverride: {
                        [keyword]: ["transform", "preserve"].map((action) => ({
                            type: "object",
                            properties: { action: { type: "string", const: action } },
                            required: ["action"],
                        })),
                    },
                },
            });

            expect(code).toContain("public sealed partial class SystemMessage");
            expect(code).toContain(
                "[Experimental(global::GitHub.Copilot.Diagnostics.Experimental)]\n[JsonConverter(typeof(Converter))]\npublic sealed partial class SystemMessage"
            );
            expect(code).toContain("System message configuration.");
            expect(code).toContain("public SystemMessage? SystemMessage");
            expect(code).toContain("public SystemMessage RequiredMessage");
            expect(code.match(/public sealed partial class SystemMessage\b/g)).toHaveLength(1);
            expect(code).toContain("public AppendConfig? AppendConfig { get; }");
            expect(code).toContain("public ReplaceConfig? ReplaceConfig { get; }");
            expect(code).toContain("public CustomizeConfig? CustomizeConfig { get; }");
            expect(code).toContain("public AppendMode? Mode");
            expect(code).toContain("public ReplaceMode Mode");
            expect(code).toContain("public IDictionary<string, SectionOverride>? Sections");
            expect(code).toContain("public StaticSectionOverride? StaticSectionOverride { get; }");
            expect(code).toContain("public MarkerSectionOverride? MarkerSectionOverride { get; }");
            expect(code).toContain("public StaticSectionAction Action");
            expect(code).toContain(
                '!element.TryGetProperty("mode", out _) || (element.TryGetProperty("mode", out _)'
            );
            for (const mode of ["append", "replace", "customize"]) {
                expect(code).toContain(`element.GetProperty("mode").GetString() == "${mode}"`);
            }
            for (const action of [
                "replace",
                "remove",
                "append",
                "prepend",
                "transform",
                "preserve",
            ]) {
                expect(code).toContain(`element.GetProperty("action").GetString() == "${action}"`);
            }
            expect(code).toContain('element.GetProperty("mode").ValueKind == JsonValueKind.String');
            expect(code).not.toContain("catch (JsonException)");
            for (const type of [
                "SystemMessage",
                "AppendConfig",
                "ReplaceConfig",
                "CustomizeConfig",
                "SectionOverride",
                "StaticSectionOverride",
                "MarkerSectionOverride",
            ]) {
                expect(code).toContain(`[JsonSerializable(typeof(${type}))]`);
            }
            expect(code).toContain(
                "JsonSerializer.Deserialize(element, RpcJsonContext.Default.AppendConfig)"
            );
            expect(code).toContain(
                "JsonSerializer.Serialize(writer, appendConfig, RpcJsonContext.Default.AppendConfig)"
            );
        }
    );
});

describe("C# RPC class visibility", () => {
    const sharedResultSchema = (): ApiSchema => ({
        definitions: {
            FolderTrustCheckResult: {
                type: "object",
                title: "FolderTrustCheckResult",
                properties: { trusted: { type: "boolean" } },
                required: ["trusted"],
            },
        },
        // The server tree is emitted before the session tree, so the internal
        // method reaches the shared result type first.
        server: {
            permissions: {
                isTrusted: {
                    rpcMethod: "permissions.folderTrust.isTrusted",
                    visibility: "internal",
                    result: { $ref: "#/definitions/FolderTrustCheckResult" },
                },
            },
        },
        session: {
            permissions: {
                isTrusted: {
                    rpcMethod: "session.permissions.folderTrust.isTrusted",
                    result: { $ref: "#/definitions/FolderTrustCheckResult" },
                },
            },
        },
    });

    it("keeps a type shared with an internal method public", () => {
        const code = generateRpcCode(sharedResultSchema());

        expect(code).toContain("public sealed class FolderTrustCheckResult\n");
        expect(code).not.toContain("internal sealed class FolderTrustCheckResult\n");
    });

    it("still emits a request wrapper as internal", () => {
        const code = generateRpcCode({
            definitions: {},
            server: {
                git: {
                    workingDirectoryContext: {
                        rpcMethod: "git.workingDirectoryContext",
                        params: {
                            type: "object",
                            properties: { cwd: { type: "string" } },
                            required: ["cwd"],
                        },
                    },
                },
            },
        });

        expect(code).toContain("internal sealed class GitWorkingDirectoryContextRequest\n");
    });

    it("honors an explicitly internal schema over public reachability", () => {
        const schema = sharedResultSchema();
        (schema.definitions!.FolderTrustCheckResult as Record<string, unknown>).visibility =
            "internal";
        const code = generateRpcCode(schema);

        expect(code).toContain("internal sealed class FolderTrustCheckResult\n");
    });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    appendLastPythonRpcConstructorFields,
    applyPythonLegacyParameters,
    emitMethod,
    generatePythonSessionEventsCode,
    generateRpcCode,
    isPythonObjectResultSchema,
    pythonAppendLastFieldsPresentIn,
} from "../../scripts/codegen/python.ts";
import { legacyRequestSchema } from "./legacy-parameters-fixture.ts";
import {
    callbackFixture,
    eventFixture,
    metadataFixture,
    optionalRequestFixture,
    pythonRpcFixture,
    rpcFixture,
    unionFixture,
    booleanUnionFixture,
    eventMatrixFixture,
    jsonShapesFixture,
    namingFixture,
    nestedUnionFixture,
    presenceFixture,
    referenceFixture,
    sharedReferenceFixture,
    visibilityFixture,
} from "./codegen-fixtures.ts";

describe("Python shared schema baseline", () => {
    it("renders types, server/session calls, and nested namespaces through Quicktype", async () => {
        const code = await generateRpcCode(pythonRpcFixture(rpcFixture()));
        for (const field of [
            "id: str",
            "count: int",
            "active: bool",
            "score: float",
            "tags: list[str]",
            "labels: dict[str, str]",
            "display_name: str | None = None",
            "note: str | None = None",
            "items: list[SampleItem]",
        ])
            expect(code).toContain(field);
        expect(code.match(/^class SampleItem:/gm)).toHaveLength(1);
        expect(code).toContain('result["displayName"]');
        expect(code).toContain('self._client.request("sample.get"');
        expect(code).toContain('self._client.request("sample.nested.list"');
        expect(code).toContain("async def ping(self, *, timeout: float | None = None) -> None:");
        expect(code).toContain('params_dict["sessionId"] = self._session_id');
        expect(code).toContain('self._client.request("session.sample.get"');
        expect(code).toMatch(/class SessionSampleGetRequest:\n    id: str\n/);
        expect(code).toMatchSnapshot();
    });

    it("renders optional requests without requiring a params argument", async () => {
        const code = await generateRpcCode(pythonRpcFixture(optionalRequestFixture()));
        expect(code).toContain("params: SampleConfigureRequest | None = None");
        expect(code).toContain("enabled: bool | None = None");
    });

    it.each(["anyOf", "oneOf"] as const)(
        "renders referenced %s unions and enums",
        async (keyword) => {
            const code = await generateRpcCode(pythonRpcFixture(unionFixture(keyword)));
            expect(code).toContain('TEXT = "text"');
            expect(code).toContain('COUNT = "count"');
            expect(code).toContain('FAST = "fast"');
            expect(code).toContain('THOROUGH = "thorough"');
            expect(code).toContain("choice: SampleChoice");
            expect(code).toContain("choices: list[SampleChoice]");
            expect(code).toContain('from_list(SampleChoice.from_dict, obj.get("choices"))');
        }
    );

    it("preserves method documentation and exposure annotations", async () => {
        const code = await generateRpcCode(pythonRpcFixture(metadataFixture()));
        expect(code).toContain("Preview an item.");
        expect(code.match(/^    async def preview[^\n]*\n        "[^\n]*"/m)?.[0]).toContain(
            ".. warning:: This API is experimental"
        );
        expect(code.match(/^    async def retired[^\n]*\n        "[^\n]*"/m)?.[0]).toContain(
            ".. deprecated::"
        );
        expect(code).toContain("async def _hidden(");
        expect(code).not.toContain("async def hidden(");
    });

    it.each(["clientSession", "clientGlobal"] as const)(
        "renders %s callback registration",
        async (scope) => {
            const code = await generateRpcCode(pythonRpcFixture(callbackFixture(scope)));
            expect(code).toContain("params: SampleConfirmRequest) -> SampleConfirmResult:");
            expect(code).toContain('client.set_request_handler("sample.confirm"');
            if (scope === "clientSession") {
                expect(code).toContain("get_handlers(request.session_id)");
                expect(code).not.toContain('"sample.hidden"');
            } else {
                expect(code).toContain('client.set_notification_method_handler("sample.changed"');
            }
        }
    );

    it("renders event payloads and discriminator-driven decoding", () => {
        const code = generatePythonSessionEventsCode(eventFixture());
        expect(code).toContain('SAMPLE_UPDATED = "sample.updated"');
        expect(code).toContain("class SampleUpdatedData:");
        expect(code).toContain("sequence: int");
        expect(code).toContain("note: str | None = None");
        expect(code).toContain("SampleUpdatedData.from_dict");
        expect(code).toMatchSnapshot();
    });

    it("keeps existing signatures when a response gains an optional field", async () => {
        const before = await generateRpcCode(pythonRpcFixture(rpcFixture()));
        const after = await generateRpcCode(
            pythonRpcFixture(rpcFixture({ extra: { type: "string" } }))
        );
        const signature =
            "async def get(self, params: SampleGetRequest, *, timeout: float | None = None) -> SampleItem:";
        expect(before).toContain(signature);
        expect(after).toContain(signature);
        expect(before).not.toContain("extra:");
        expect(after).toContain("extra: str | None = None");
    });
});

describe("Python schema contract matrix", () => {
    it.each([
        ["scalar", "str"],
        ["object", "PresenceValue"],
        ["array", "list[PresenceValue]"],
        ["map", "dict[str, PresenceValue]"],
    ] as const)("preserves presence in %s fields and serialization", async (shape, type) => {
        const code = await generateRpcCode(pythonRpcFixture(presenceFixture(shape)));
        const declaration = code.match(/^class Presence:\n(?:[ \t].*\n|\n)*/m)?.[0];
        expect(declaration).toContain(`    required_value: ${type}\n`);
        for (const name of ["optional_value", "required_nullable", "optional_nullable"])
            expect(declaration).toContain(`    ${name}: ${type} | None = None\n`);
        expect(declaration).toContain(
            "return Presence(required_value, optional_nullable, optional_value, required_nullable)"
        );
        expect(declaration).toContain('        result["requiredNullable"] =');
        expect(declaration).not.toContain("if self.required_nullable is not None:");
        expect(declaration).toContain(
            'if self.optional_value is not None:\n            result["optionalValue"] ='
        );
        expect(declaration).toContain(
            'if self.optional_nullable is not None:\n            result["optionalNullable"] ='
        );
    });

    it("reuses multi-hop references and their codecs across request and result types", async () => {
        const code = await generateRpcCode(pythonRpcFixture(referenceFixture()));
        for (const name of ["ReferenceGraph", "ReferenceNode", "ReferenceLeaf"])
            expect(code.match(new RegExp(`^class ${name}:`, "gm"))).toHaveLength(1);
        const graph = code.match(/^class ReferenceGraph:\n(?:[ \t].*\n|\n)*/m)?.[0];
        for (const field of [
            "first: ReferenceNode",
            "second: ReferenceNode",
            "nodes: list[ReferenceNode]",
            "lookup: dict[str, ReferenceNode]",
        ])
            expect(graph).toContain(field);
        expect(graph).toContain('nodes = from_list(ReferenceNode.from_dict, obj.get("nodes"))');
        expect(graph).toContain('lookup = from_dict(ReferenceNode.from_dict, obj.get("lookup"))');
        expect(code).toContain('leaf = ReferenceLeaf.from_dict(obj.get("leaf"))');
        expect(code).toContain(
            "async def graph(self, params: ReferenceGraph, *, timeout: float | None = None) -> ReferenceGraph:"
        );
        expect(code).toContain(
            'return ReferenceGraph.from_dict(await self._client.request("sample.graph", params_dict'
        );
    });

    it("keeps empty objects, open maps, and opaque JSON distinct", async () => {
        const code = await generateRpcCode(pythonRpcFixture(jsonShapesFixture()));
        const declaration = code.match(/^class JSONShapes:\n(?:[ \t].*\n|\n)*/m)?.[0];
        expect(declaration).toContain("    empty: Empty\n");
        expect(declaration).toContain("    open: dict[str, Any]\n");
        expect(declaration).toContain("    opaque: Any");
        expect(declaration).toContain('empty = Empty.from_dict(obj.get("empty"))');
        expect(declaration).toContain('open = from_dict(lambda x: x, obj.get("open"))');
        expect(declaration).toContain('opaque = obj.get("opaque")');
        expect(declaration).toContain('result["opaque"] = self.opaque');
    });

    it.each([
        ["baseline", rpcFixture],
        ["opaque JSON", jsonShapesFixture],
        ["references", referenceFixture],
        ["wire names", namingFixture],
        ["visibility", visibilityFixture],
        ["boolean discriminators", booleanUnionFixture],
        ...(["scalar", "object", "array", "map"] as const).map(
            (shape) => [`${shape} presence`, () => presenceFixture(shape)] as const
        ),
        ...(["anyOf", "oneOf"] as const).map(
            (keyword) => [`nested ${keyword}`, () => nestedUnionFixture(keyword, true)] as const
        ),
        ...([0, 1, 2] as const).map(
            (count) =>
                [`${count} legacy additions`, () => legacyRequestSchema(count).schema] as const
        ),
    ] as const)(
        "decodes every dataclass in %s using its constructor field order",
        async (_, fixture) => {
            const code = await generateRpcCode(pythonRpcFixture(fixture()));
            const classes = [...code.matchAll(/^@dataclass\nclass (\w+):\n((?:[ \t].*\n|\n)*)/gm)];
            expect(classes.length).toBeGreaterThan(0);
            for (const [, name, declaration] of classes) {
                const fields = [...declaration.matchAll(/^    (\w+): (?!ClassVar\[)([^\n]+)/gm)];
                const positional = fields.filter(([, , field]) => !field.includes("kw_only=True"));
                const keywordOnly = fields.filter(([, , field]) => field.includes("kw_only=True"));
                const expected = [
                    ...positional.map(([, field]) => field),
                    ...keywordOnly.map(([, field]) => `${field}=${field}`),
                ];
                const args = declaration.match(new RegExp(`return ${name}\\(([^)]*)\\)`))?.[1];
                expect(args, `${name}.from_dict constructor arguments`).toBe(expected.join(", "));
            }
        }
    );

    it.each(["anyOf", "oneOf"] as const)(
        "postprocesses nested %s union aliases, maps, nullable fields, and added variants",
        async (keyword) => {
            const before = await generateRpcCode(pythonRpcFixture(nestedUnionFixture(keyword)));
            const after = await generateRpcCode(
                pythonRpcFixture(nestedUnionFixture(keyword, true))
            );
            for (const code of [before, after]) {
                const result = code.match(/^class VerdictSet:\n(?:[ \t].*\n|\n)*/m)?.[0];
                expect(result).toContain("decisions: dict[str, Verdict]");
                expect(result).toContain("selected: Verdict | None = None");
                expect(result).toContain(
                    'decisions = from_dict(_load_Verdict, obj.get("decisions"))'
                );
                expect(result).toContain(
                    'selected = from_union([_load_Verdict, from_none], obj.get("selected"))'
                );
                expect(result).toContain(
                    'result["decisions"] = from_dict(lambda x: (x).to_dict(), self.decisions)'
                );
                expect(result).not.toContain("Verdict.from_dict");
                expect(code).toContain('case "allow": return AllowVerdict.from_dict(obj)');
                expect(code).toContain('case "deny": return DenyVerdict.from_dict(obj)');
            }
            expect(before).toContain("Verdict = AllowVerdict | DenyVerdict\n");
            expect(before).not.toContain("PendingVerdict");
            expect(after).toContain("Verdict = AllowVerdict | DenyVerdict | PendingVerdict\n");
            expect(after).toContain('case "pending": return PendingVerdict.from_dict(obj)');
            const declaration = /^class AllowVerdict:\n(?:[ \t].*\n|\n)*/m;
            expect(before).toMatch(declaration);
            expect(after.match(declaration)?.[0]).toBe(before.match(declaration)?.[0]);
        }
    );

    it("postprocesses boolean union variants and dispatch without stringifying the wire value", async () => {
        const code = await generateRpcCode(pythonRpcFixture(booleanUnionFixture()));
        expect(code).toContain(
            "class AcceptedEnqueueCommandResult:\n    queued: ClassVar[bool] = True\n"
        );
        expect(code).toContain(
            "class UnsupportedEnqueueCommandResult:\n    queued: ClassVar[bool] = False\n"
        );
        const loader = code.match(/^def _load_EnqueueCommandResult[^\n]*\n(?:[ \t].*\n|\n)*/m)?.[0];
        expect(loader).toContain('kind = obj.get("queued")');
        expect(loader).toContain("case True: return AcceptedEnqueueCommandResult.from_dict(obj)");
        expect(loader).toContain(
            "case False: return UnsupportedEnqueueCommandResult.from_dict(obj)"
        );
        expect(loader).not.toContain('case "true"');
        expect(code).toContain(
            'return _load_EnqueueCommandResult(await self._client.request("sample.accept", {}'
        );
    });

    it("preserves wire names in both directions while escaping Python identifiers", async () => {
        const code = await generateRpcCode(pythonRpcFixture(namingFixture()));
        const declaration = code.match(/^class WireNames:\n(?:[ \t].*\n|\n)*/m)?.[0];
        for (const [wire, member, type, converter] of [
            ["class", "wire_names_class", "str", "from_str"],
            ["default", "default", "bool", "from_bool"],
            ["type", "type", "str", "from_str"],
            ["requestId", "request_id", "str", "from_str"],
            ["content-type", "content_type", "str", "from_str"],
        ]) {
            expect(declaration).toContain(`    ${member}: ${type}\n`);
            expect(declaration).toContain(`${member} = ${converter}(obj.get("${wire}"))`);
            expect(declaration).toContain(`result["${wire}"] = ${converter}(self.${member})`);
        }
    });

    it("separates internal API classes without duplicating shared dependencies", async () => {
        const code = await generateRpcCode(pythonRpcFixture(visibilityFixture()));
        const publicApi = code.match(/^class ServerSampleApi:\n(?:[ \t].*\n|\n)*/m)?.[0];
        const internalApi = code.match(/^class _InternalServerSampleApi:\n(?:[ \t].*\n|\n)*/m)?.[0];
        expect(publicApi).toContain("async def visible(");
        expect(publicApi).not.toContain("secret");
        expect(internalApi).toContain("async def _secret(");
        expect(internalApi).not.toContain("async def visible(");
        const publicHost = code.match(/^class ServerHostApi:\n(?:[ \t].*\n|\n)*/m)?.[0];
        const internalHost = code.match(/^class _InternalServerHostApi:\n(?:[ \t].*\n|\n)*/m)?.[0];
        expect(publicHost).toContain("async def visible(");
        expect(publicHost).not.toContain("secret");
        expect(internalHost).toContain("async def _secret(");
        expect(internalHost).not.toContain("async def visible(");
        expect(code.match(/^class SharedValue:/gm)).toHaveLength(1);
    });

    it("dispatches every empty, object, and union event and retains unknown-event fallback", () => {
        const code = generatePythonSessionEventsCode(eventMatrixFixture());
        expect(
            [
                ...code.matchAll(
                    /case SessionEventType\.(\w+): data = (\w+)\.from_dict\(data_obj\)/g
                ),
            ].map((match) => [match[1], match[2]])
        ).toEqual([
            ["MATRIX_EMPTY", "MatrixEmptyData"],
            ["MATRIX_VALUE", "MatrixValueData"],
            ["MATRIX_UNION", "MatrixUnionData"],
        ]);
        expect(code).toContain("case _: data = RawSessionEventData.from_dict(data_obj)");
        expect(code.match(/^class MatrixEmptyData:\n(?:[ \t].*\n|\n)*/m)?.[0]).toContain(
            "return MatrixEmptyData()"
        );
        expect(code.match(/^class MatrixValueData:\n(?:[ \t].*\n|\n)*/m)?.[0]).toContain(
            "sequence: int"
        );
        const discriminator = code.match(
            /^class MatrixUnionDataKind\(Enum\):\n(?:[ \t].*\n|\n)*/m
        )?.[0];
        expect(discriminator).toContain('FIRST = "first"');
        expect(discriminator).toContain('SECOND = "second"');
    });

    it.each([0, 1, 2] as const)(
        "preserves legacy positional parameters through Quicktype with %s added fields",
        async (additions) => {
            const { schema } = legacyRequestSchema(additions);
            const code = await generateRpcCode(pythonRpcFixture(schema));
            const request = code.match(/^class SamplePlanRequest:\n(?:[ \t].*\n|\n)*/m)?.[0];
            expect(request).toContain("    contract: str\n");
            expect(request).toContain("    source: str\n");
            expect(request).toContain("    scope: str | None = None\n");
            const added = ["policy_session_id", "trace_id"].slice(0, additions);
            for (const name of added)
                expect(request).toContain(
                    `${name}: str | None = field(default=None, kw_only=True)`
                );
            const kwargs = added.map((name) => `, ${name}=${name}`).join("");
            expect(request).toContain(`return SamplePlanRequest(contract, source, scope${kwargs})`);
            expect(request).not.toContain("contract=contract");
            expect(code).toContain(
                "async def plan(self, params: SamplePlanRequest, *, timeout: float | None = None) -> SamplePlanResult:"
            );
        }
    );

    it("imports shared event types instead of redeclaring their reference graph", async () => {
        const { api, events } = sharedReferenceFixture();
        const code = await generateRpcCode(pythonRpcFixture(api), events);
        const eventCode = generatePythonSessionEventsCode(events);
        expect(code).toContain("from .session_events import ReferenceGraph");
        expect(code).toContain(
            "params: ReferenceGraph, *, timeout: float | None = None) -> ReferenceGraph:"
        );
        for (const name of ["ReferenceGraph", "ReferenceNode", "ReferenceLeaf"]) {
            expect(code).not.toContain(`class ${name}:`);
            expect(eventCode.match(new RegExp(`^class ${name}:`, "gm"))).toHaveLength(1);
        }
    });

    it("shared event-type RPC results use from_dict decoding", async () => {
        const { api, events } = sharedReferenceFixture();
        const code = await generateRpcCode(pythonRpcFixture(api), events);
        const method = code.match(/^    async def graph[^\n]*\n(?:        .*\n|\n)*/m)?.[0];
        expect(method).toContain(
            'return ReferenceGraph.from_dict(await self._client.request("sample.graph"'
        );
    });

    it("does not retain Quicktype names or postprocessor state between schemas", async () => {
        const before = await generateRpcCode(pythonRpcFixture(referenceFixture()));
        const eventsBefore = generatePythonSessionEventsCode(eventFixture());
        await generateRpcCode(pythonRpcFixture(nestedUnionFixture("oneOf", true)));
        generatePythonSessionEventsCode(eventMatrixFixture());
        expect(await generateRpcCode(pythonRpcFixture(referenceFixture()))).toBe(before);
        expect(generatePythonSessionEventsCode(eventFixture())).toBe(eventsBefore);
    });
});

describe("Python referenced RPC results", () => {
    it("uses record deserialization for nullable object references, but not enums", () => {
        const definitions = {
            definitions: {
                Account: {
                    type: "object" as const,
                    properties: { accountId: { type: "string" as const } },
                    required: ["accountId"],
                },
                AccountResult: {
                    anyOf: [{ $ref: "#/definitions/Account" }, { type: "null" as const }],
                },
                Mode: { type: "string" as const, enum: ["token"] },
            },
        };

        expect(isPythonObjectResultSchema({ $ref: "#/definitions/Account" }, definitions)).toBe(
            true
        );
        expect(
            isPythonObjectResultSchema({ $ref: "#/definitions/AccountResult" }, definitions)
        ).toBe(true);
        expect(isPythonObjectResultSchema({ $ref: "#/definitions/Mode" }, definitions)).toBe(false);
    });
});

describe("Python RPC projection compatibility", () => {
    const code = readFileSync(
        new URL("../../python/copilot/generated/rpc.py", import.meta.url),
        "utf8"
    );

    it("deserializes usage results shared with session events", () => {
        expect(code).toContain(
            'return UsageGetMetricsResult.from_dict(await self._client.request("session.usage.getMetrics"'
        );
    });

    it("returns typed quota warning projections", () => {
        expect(code).toContain(
            "async def take_warnings(self, *, timeout: float | None = None) -> list[QuotaWarningProjection]:"
        );
        expect(code).toContain(
            'return from_list(QuotaWarningProjection.from_dict, await self._client.request("session.quota.takeWarnings"'
        );
    });

    it.each([
        "account.getAllUsers",
        "sessions.getClientMetadata",
        "session.gitHubAuth.getAllAuthAvailable",
        "session.gitHubAuth.lastAuthErrors",
    ])("preserves the published dictionary-array result for %s", (method) => {
        expect(code).toContain(`return list(await self._client.request("${method}"`);
    });

    it("keeps the managed permission discriminator independent of MCP URL kinds", () => {
        expect(code).toContain("class ManagedPermissionOperationKind(Enum):");
        const operation = code
            .split("class ManagedPermissionOperation:")[1]
            ?.split("\n\n@dataclass")[0];
        expect(operation).toContain("kind: ManagedPermissionOperationKind");
        expect(operation).toContain('kind = ManagedPermissionOperationKind(obj.get("kind"))');
        expect(operation).toContain(
            'result["kind"] = to_enum(ManagedPermissionOperationKind, self.kind)'
        );
        expect(operation).not.toContain("MCPServerCardURLKind");
    });

    it("preserves concrete account enumeration variants", () => {
        expect(code).toContain(
            "AuthEnumerateValue = AuthEnumerateValueAccounts | AuthEnumerateValueProviders | AuthEnumerateValueLoginAccounts"
        );
        expect(code).toContain("class AuthEnumerateValueLoginAccounts:");
        expect(code).toContain("items: list[AuthLoginIdentity]");
        expect(code).toContain(
            "kind: ClassVar[AuthEnumerateQueryKind] = AuthEnumerateQueryKind.LOGIN_ACCOUNTS"
        );
        expect(code).toContain(
            'case "loginAccounts": return AuthEnumerateValueLoginAccounts.from_dict(obj)'
        );
        expect(code).not.toContain("class ItemElement:");
    });

    it("keeps the session-limit discriminator independent of image-model availability", () => {
        expect(code).toContain("class SessionLimitPredictionResultKind(Enum):");
        expect(code).toContain('"SessionLimitPredictionResultKind",');
        expect(code).toContain("class ImageToolModelAvailability(Enum):");
        const prediction = code
            .split("class SessionLimitPredictionResult:")[1]
            ?.split("\n\n@dataclass")[0];
        expect(prediction).toContain("kind: SessionLimitPredictionResultKind");
        expect(prediction).toContain('kind = SessionLimitPredictionResultKind(obj.get("kind"))');
        expect(prediction).toContain(
            'result["kind"] = to_enum(SessionLimitPredictionResultKind, self.kind)'
        );
        expect(prediction).not.toContain("ImageToolModelAvailability");
    });

    it("preserves the existing Workflow checkpoint result API", () => {
        const result = "SessionWorkflowPauseAtCheckpointResult";
        expect(code).toContain(`class ${result}:`);
        expect(code).toContain(`-> ${result}:`);
        expect(code).toContain(`return ${result}.from_dict(`);
        expect(code).toContain(`"${result}",`);
    });

    it("keeps named connection-scoped host callback results", () => {
        expect(code).toContain(
            "async def materialize_session(self, params: HostSessionCreateCallback) -> HostSessionCreateResult:"
        );
        expect(code).toContain(
            "async def register_session(self, params: HostRegisterSessionRequest) -> HostPublishSessionResult:"
        );
        expect(code).toContain("class HostEmptyResult:");
        expect(code).toContain(
            "async def shutdown(self, params: HostEmptyResult) -> HostEmptyResult:"
        );
        expect(code).toContain(
            'return HostEmptyResult.from_dict(await self._client.request("host.dispose"'
        );
        expect(code).not.toContain("dict.from_dict");
    });
});

it("deserializes open empty-object results as dictionaries", () => {
    const lines: string[] = [];
    emitMethod(
        lines,
        "dispose",
        {
            rpcMethod: "host.dispose",
            params: {
                type: "object",
                properties: { hostId: { type: "string" } },
                required: ["hostId"],
            },
            result: { type: "object", properties: {} },
        },
        false,
        (name) => (name === "HostDisposeResult" ? "dict" : name)
    );
    const code = lines.join("\n");
    expect(code).toContain('return dict(await self._client.request("host.dispose"');
    expect(code).not.toContain("dict.from_dict");
});

describe("Python root event payload unions", () => {
    it.each(["anyOf", "oneOf"] as const)("preserves referenced %s payload variants", (keyword) => {
        const code = generatePythonSessionEventsCode({
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
        expect(code).toContain("class SampleUnionData:");
        expect(code).toContain("kind: SampleUnionDataKind");
        expect(code).toContain("value: str");
        for (const kind of ["status", "startup", "server_error", "incremental"]) {
            expect(code).toContain(`= "${kind}"`);
        }
        expect(code).toContain('result["value"] = from_str(self.value)');
        expect(code).toContain("data = SampleUnionData.from_dict(data_obj)");
        expect(code).toContain("return SampleEmptyData()");
    });
});

function pythonRequestSnippet(additions: 1 | 2): string {
    const traceField = additions >= 2 ? "    trace_id: str | None = None\n\n" : "";
    const traceLoad =
        additions >= 2
            ? '        trace_id = from_union([from_str, from_none], obj.get("traceId"))\n'
            : "";
    const traceArg = additions >= 2 ? ", trace_id" : "";
    return [
        "@dataclass",
        "class SamplePlanRequest:",
        "    contract: str",
        "",
        "    source: str",
        "",
        "    policy_session_id: str | None = None",
        "",
        "    scope: str | None = None",
        "",
        traceField + "    @staticmethod",
        "    def from_dict(obj: Any) -> 'SamplePlanRequest':",
        "        assert isinstance(obj, dict)",
        '        contract = from_str(obj.get("contract"))',
        '        source = from_str(obj.get("source"))',
        '        policy_session_id = from_union([from_str, from_none], obj.get("policySessionId"))',
        '        scope = from_union([from_str, from_none], obj.get("scope"))',
        traceLoad +
            `        return SamplePlanRequest(contract, source, policy_session_id, scope${traceArg})`,
        "",
    ].join("\n");
}

describe("Python x-legacy-parameters", () => {
    it.each([1, 2] as const)(
        "keeps legacy fields positional and makes %i added field(s) keyword-only",
        (additions) => {
            const { params } = legacyRequestSchema(additions);
            const code = applyPythonLegacyParameters(pythonRequestSnippet(additions), {
                SamplePlanRequest: params,
            });
            expect(code).toContain("    contract: str\n");
            expect(code).toContain("    source: str\n");
            expect(code).toContain("    scope: str | None = None\n");
            expect(code).toContain(
                "    policy_session_id: str | None = field(default=None, kw_only=True)"
            );
            if (additions === 2) {
                expect(code).toContain(
                    "    trace_id: str | None = field(default=None, kw_only=True)"
                );
                expect(code).toContain(
                    "return SamplePlanRequest(contract, source, scope, policy_session_id=policy_session_id, trace_id=trace_id)"
                );
            } else {
                expect(code).toContain(
                    "return SamplePlanRequest(contract, source, scope, policy_session_id=policy_session_id)"
                );
            }
        }
    );

    it("leaves unmarked dataclasses unchanged", () => {
        const snippet = pythonRequestSnippet(1);
        expect(
            applyPythonLegacyParameters(snippet, {
                SamplePlanRequest: legacyRequestSchema(0).params,
            })
        ).toBe(snippet);
    });
});

describe("Python append-last RPC fields", () => {
    const fields = [["Request", "addedField"]] as const;
    const request = (docstring: string) =>
        [
            "@dataclass",
            "class Request:",
            `    """${docstring}"""`,
            "",
            "    added_field: str | None = None",
            "    stable_field: str | None = None",
            "",
            "    @staticmethod",
            "    def from_dict(obj: Any) -> 'Request':",
            '        added_field = from_str(obj.get("addedField"))',
            '        stable_field = from_str(obj.get("stableField"))',
            "        return Request(added_field, stable_field)",
            "",
        ].join("\n");

    it("reorders a dataclass that is the last block in the file", () => {
        const updated = appendLastPythonRpcConstructorFields(request("Request."), fields);

        expect(updated.indexOf("stable_field: str")).toBeLessThan(
            updated.indexOf("added_field: str")
        );
        expect(updated).toContain("return Request(stable_field, added_field)");
    });

    it("does not end the dataclass block at a capital Z before its constructor", () => {
        const updated = appendLastPythonRpcConstructorFields(
            `${request("Zone request.")}\n@dataclass\nclass Next:\n    pass\n`,
            fields
        );

        expect(updated.indexOf("stable_field: str")).toBeLessThan(
            updated.indexOf("added_field: str")
        );
        expect(updated).toContain("return Request(stable_field, added_field)");
        expect(updated).toContain("class Next:");
    });

    it("fails generation instead of skipping a missing dataclass", () => {
        expect(() =>
            appendLastPythonRpcConstructorFields("@dataclass\nclass Other:\n    pass\n", fields)
        ).toThrow("Missing dataclass Request");
    });
});

describe("Python append-last fields for a selected schema", () => {
    const fields = [["Request", "addedField"]] as const;

    it("appends Auto metadata without shifting model-list positional arguments", () => {
        expect(
            pythonAppendLastFieldsPresentIn({
                SessionModelList: {
                    type: "object",
                    properties: {
                        list: { type: "array", items: {} },
                        auto: { type: "object" },
                    },
                },
            })
        ).toEqual([["SessionModelList", "auto"]]);
    });

    it("keeps an entry whose property the schema declares", () => {
        expect(
            pythonAppendLastFieldsPresentIn(
                { Request: { type: "object", properties: { addedField: { type: "string" } } } },
                fields
            )
        ).toEqual(fields);
    });

    it("includes fields marked append-last by the contract schema", () => {
        expect(
            pythonAppendLastFieldsPresentIn({
                Response: {
                    type: "object",
                    properties: {
                        stableField: { type: "string" },
                        addedField: {
                            type: "string",
                            "x-copilot-sdk-append-last": true,
                        },
                    },
                },
            })
        ).toContainEqual(["Response", "addedField"]);
    });

    it.each(["anyOf", "oneOf"] as const)(
        "includes marked fields in inline %s variants once",
        (keyword) => {
            expect(
                pythonAppendLastFieldsPresentIn({
                    Response: {
                        [keyword]: ["first", "second"].map((kind) => ({
                            type: "object",
                            properties: {
                                kind: { const: kind },
                                addedField: {
                                    type: "string",
                                    "x-copilot-sdk-append-last": true,
                                },
                            },
                        })),
                    },
                })
            ).toEqual([["Response", "addedField"]]);
        }
    );

    it("skips an entry for a legacy request or a schema without the definition", () => {
        expect(
            pythonAppendLastFieldsPresentIn(
                { Request: { type: "object", properties: { stableField: { type: "string" } } } },
                fields
            )
        ).toEqual([]);
        expect(pythonAppendLastFieldsPresentIn({}, fields)).toEqual([]);
    });
});

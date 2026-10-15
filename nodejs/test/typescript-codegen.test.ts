import type { JSONSchema7 } from "json-schema";
import { compile } from "json-schema-to-typescript";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
    assertNoPublicInternalReferences,
    filterPublicSessionEventVariants,
    generateRpcCode,
    generateSessionEventsCode,
    normalizeSchemaForTypeScript,
    tsNullableResultTypeName,
} from "../../scripts/codegen/typescript.ts";
import type { AssistantMessageReasoningBlocks } from "../src/generated/session-events.ts";
import { isCodegenEntrypoint, type DefinitionCollections } from "../../scripts/codegen/utils.ts";
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
    sharedReferenceFixture,
    visibilityFixture,
} from "./codegen-fixtures.ts";

describe("TypeScript shared schema baseline", () => {
    it("renders types, server/session calls, and nested namespaces", async () => {
        const code = await generateRpcCode(rpcFixture());
        for (const field of [
            "id: string;",
            "count: number;",
            "active: boolean;",
            "score: number;",
            "tags: string[];",
            "[k: string]: string | undefined;",
            "displayName?: string;",
            "note?: string | null;",
            "items: SampleItem[];",
        ])
            expect(code).toContain(field);
        expect(code.match(/export interface SampleItem \{/g)).toHaveLength(1);
        expect(code).toContain('connection.sendRequest("sample.get", params)');
        expect(code).toContain('connection.sendRequest("sample.nested.list", {})');
        expect(code).toContain("ping: async (): Promise<void>");
        expect(code).toContain(
            'connection.sendRequest("session.sample.get", { ...params, sessionId })'
        );
        expect(code).toContain("export interface SessionSampleGetRequest {\n  id: string;\n}");
        expect(code).toMatchSnapshot();
    });

    it("renders optional requests without requiring a params argument", async () => {
        const code = await generateRpcCode(optionalRequestFixture());
        expect(code).toContain("configure: async (params?: SampleConfigureRequest): Promise<void>");
        expect(code).toContain("enabled?: boolean;");
    });

    it.each(["anyOf", "oneOf"] as const)(
        "renders referenced %s unions and enums",
        async (keyword) => {
            const code = await generateRpcCode(unionFixture(keyword));
            expect(code).toContain('kind: "text";');
            expect(code).toContain('kind: "count";');
            expect(code).toContain('export type SampleMode = "fast" | "thorough";');
            expect(code).toContain("choice: SampleChoice;");
            expect(code).toContain("choices: SampleChoice[];");
        }
    );

    it("preserves method documentation and exposure annotations", async () => {
        const code = await generateRpcCode(metadataFixture());
        expect(code).toContain("Preview an item.");
        expect(code).toMatch(/\* @experimental\n\s+\*\/\n\s+preview: async/);
        expect(code).toMatch(/\* @deprecated\n\s+\*\/\n\s+retired: async/);
        expect(code).toMatch(/\* @internal\n \*\/\nexport function createInternalServerRpc/);
    });

    it.each(["clientSession", "clientGlobal"] as const)(
        "renders %s callback registration",
        async (scope) => {
            const code = await generateRpcCode(callbackFixture(scope));
            expect(code).toContain("SampleConfirmRequest");
            expect(code).toContain("Promise<SampleConfirmResult>");
            expect(code).toContain('connection.onRequest("sample.confirm"');
            if (scope === "clientSession") {
                expect(code).toContain("getHandlers(params.sessionId)");
                expect(code).not.toContain('"sample.hidden"');
            } else {
                expect(code).toContain('connection.onNotification("sample.changed"');
            }
        }
    );

    it("renders event payload and envelope types", async () => {
        const code = await generateSessionEventsCode(eventFixture());
        expect(code).toContain('type: "sample.updated";');
        expect(code).toContain("sequence: number;");
        expect(code).toContain("note?: string | null;");
        expect(code).toContain("parentId?: string | null;");
        expect(code).toMatchSnapshot();
    });

    it("keeps existing signatures when a response gains an optional field", async () => {
        const before = await generateRpcCode(rpcFixture());
        const after = await generateRpcCode(rpcFixture({ extra: { type: "string" } }));
        const signature = "get: async (params: SampleGetRequest): Promise<SampleItem>";
        expect(before).toContain(signature);
        expect(after).toContain(signature);
        expect(before).not.toContain("extra?:");
        expect(after).toContain("extra?: string;");
    });
});

describe("TypeScript schema contract matrix", () => {
    it.each([
        ["scalar", "string"],
        ["object", "PresenceValue"],
        ["array", "PresenceValue[]"],
        ["map", "{\n    [k: string]: PresenceValue;\n  }"],
    ] as const)("preserves requiredness and nullability for %s values", async (shape, type) => {
        const code = await generateRpcCode(presenceFixture(shape));
        for (const name of ["Presence", "SamplePresenceResult"]) {
            const declaration = code.match(
                new RegExp(`export interface ${name} \\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            expect(declaration).toContain(`requiredValue: ${type};`);
            expect(declaration).toContain(`optionalValue?: ${type};`);
            expect(declaration).toContain(`requiredNullable: ${type} | null;`);
            expect(declaration).toContain(`optionalNullable?: ${type} | null;`);
        }
    });

    it("reuses multi-hop references in requests, results, arrays, and maps", async () => {
        const code = await generateRpcCode(referenceFixture());
        expect(code.match(/^export interface ReferenceNode \{/gm)).toHaveLength(1);
        expect(code.match(/^export interface ReferenceLeaf \{/gm)).toHaveLength(1);
        expect(code).toContain("export interface ReferenceNode {\n  leaf: ReferenceLeaf;\n}");
        for (const name of ["SampleGraphRequest", "SampleGraphResult"]) {
            const declaration = code.match(
                new RegExp(`export interface ${name} \\{[\\s\\S]*?^\\}`, "m")
            )?.[0];
            expect(declaration).toContain("first: ReferenceNode;");
            expect(declaration).toContain("second: ReferenceNode;");
            expect(declaration).toContain("nodes: ReferenceNode[];");
            expect(declaration).toContain("lookup: {\n    [k: string]: ReferenceNode;\n  };");
            expect(declaration).not.toContain("any");
        }
    });

    it("distinguishes empty objects, open objects, and opaque JSON", async () => {
        const code = await generateRpcCode(jsonShapesFixture());
        const declaration = code.match(/^export interface JsonShapes \{[\s\S]*?^\}/m)?.[0];
        expect(declaration).toContain("empty: {};");
        expect(declaration).toContain("open: {\n    [k: string]: unknown | undefined;\n  };");
        expect(declaration).toContain("opaque: JsonValue;");
        expect(code).toContain(
            "export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };"
        );
    });

    it.each(["anyOf", "oneOf"] as const)(
        "keeps nested %s union references stable when a variant is added",
        async (keyword) => {
            const before = await generateRpcCode(nestedUnionFixture(keyword));
            const after = await generateRpcCode(nestedUnionFixture(keyword, true));
            for (const code of [before, after]) {
                const result = code.match(
                    /^export interface SampleDecideResult \{[\s\S]*?^\}/m
                )?.[0];
                expect(result).toContain("selected: Verdict | null;");
                expect(result).toContain("decisions: {\n    [k: string]: Verdict;\n  };");
                expect(code.match(/^export interface AllowVerdict \{[\s\S]*?^\}/m)?.[0]).toBe(
                    'export interface AllowVerdict {\n  kind: "allow";\n  message: string;\n}'
                );
            }
            expect(before).toContain("export type Verdict = AllowVerdict | DenyVerdict;");
            expect(after).toContain(
                "export type Verdict = AllowVerdict | DenyVerdict | PendingVerdict;"
            );
            expect(before).not.toContain("PendingVerdict");
        }
    );

    it("preserves boolean discriminator literals rather than widening to boolean", async () => {
        const code = await generateRpcCode(booleanUnionFixture());
        expect(code).toContain(
            "export interface AcceptedEnqueueCommandResult {\n  queued: true;\n  value: string;\n}"
        );
        expect(code).toContain(
            "export interface UnsupportedEnqueueCommandResult {\n  queued: false;\n  reason: string;\n}"
        );
        expect(code).not.toContain("queued: boolean;");
    });

    it("preserves keyword, acronym, and non-identifier wire property names", async () => {
        const code = await generateRpcCode(namingFixture());
        const declaration = code.match(/^export interface WireNames \{[\s\S]*?^\}/m)?.[0];
        expect(declaration).toBe(
            'export interface WireNames {\n  class: string;\n  default: boolean;\n  type: string;\n  requestId: string;\n  "content-type": string;\n}'
        );
    });

    it("separates internal calls while retaining shared referenced types", async () => {
        const code = await generateRpcCode(visibilityFixture());
        const publicApi = code.match(/^export function createServerRpc[\s\S]*?^\}/m)?.[0];
        const internalApi = code.match(/^export function createInternalServerRpc[\s\S]*?^\}/m)?.[0];
        expect(publicApi).toContain('connection.sendRequest("sample.visible", {})');
        expect(publicApi).not.toContain("secret");
        expect(internalApi).toContain('connection.sendRequest("sample.secret", {})');
        expect(internalApi).not.toContain("visible:");
        expect(publicApi).toContain('connection.sendRequest("host.visible", {})');
        expect(internalApi).toContain('connection.sendRequest("host.secret", {})');
        expect(code.match(/^export interface SharedValue \{/gm)).toHaveLength(1);
    });

    it("includes every event envelope and its empty, object, or union payload", async () => {
        const code = await generateSessionEventsCode(eventMatrixFixture());
        const envelope = code.match(/^export type SessionEvent =[\s\S]*?\};/m)?.[0];
        expect(envelope?.match(/type: "[^"]+"/g)).toEqual([
            'type: "matrix.empty"',
            'type: "matrix.value"',
            'type: "matrix.union"',
        ]);
        expect(code).toContain("export interface MatrixEmptyEvent {}");
        expect(code).toMatch(/export interface MatrixValueEvent \{[^}]*sequence: number;/);
        expect(code).toMatch(
            /export type MatrixUnionEvent =[\s\S]*?kind: "first";[\s\S]*?kind: "second";/
        );
        for (const name of ["Empty", "Value", "Union"])
            expect(envelope).toContain(`data: Matrix${name}Event;`);
    });

    it("imports shared event types instead of redeclaring their reference graph", async () => {
        const { api, events } = sharedReferenceFixture();
        const code = await generateRpcCode(api, events);
        const eventCode = await generateSessionEventsCode(events);
        expect(code).toContain('import type { ReferenceGraph } from "./session-events.js";');
        expect(code).toContain("graph: async (params: ReferenceGraph): Promise<ReferenceGraph>");
        for (const name of ["ReferenceGraph", "ReferenceNode", "ReferenceLeaf"]) {
            expect(code).not.toContain(`export interface ${name}`);
            expect(eventCode.match(new RegExp(`^export interface ${name} \\{`, "gm"))).toHaveLength(
                1
            );
        }
    });

    it("does not retain type or method state between unrelated schemas", async () => {
        const before = await generateRpcCode(referenceFixture());
        const eventsBefore = await generateSessionEventsCode(eventFixture());
        await generateRpcCode(nestedUnionFixture("oneOf", true));
        await generateSessionEventsCode(eventMatrixFixture());
        expect(await generateRpcCode(referenceFixture())).toBe(before);
        expect(await generateSessionEventsCode(eventFixture())).toBe(eventsBefore);
    });
});

describe("typescript schema codegen", () => {
    it("preserves an explicit nullable reference result's named union", () => {
        expect(
            tsNullableResultTypeName(
                {
                    rpcMethod: "session.accounts.getCurrent",
                    params: null,
                    result: { $ref: "#/definitions/SessionAccountResult" },
                },
                {
                    title: "SessionAccountResult",
                    anyOf: [{ $ref: "#/definitions/SessionAccount" }, { type: "null" }],
                }
            )
        ).toBe("SessionAccountResult");
    });

    it("retains the existing undefined result type for omission sentinels", () => {
        expect(
            tsNullableResultTypeName({
                rpcMethod: "session.accounts.getCurrent",
                params: null,
                result: {
                    anyOf: [{ $ref: "#/definitions/SessionAccount" }, { not: {} }],
                },
            })
        ).toBe("SessionAccount | undefined");
    });

    it("keeps reasoning-block SDK types permissive like the other language projections", () => {
        expectTypeOf<{
            provider: string;
            blocks: [];
            orderedBlocks: [];
        }>().toExtend<AssistantMessageReasoningBlocks>();
    });

    it("recognizes Windows entrypoint paths case-insensitively", () => {
        expect(
            isCodegenEntrypoint(
                "C:\\b\\execroot\\src\\sdk\\scripts\\codegen\\typescript.ts",
                "c:\\B\\execroot\\src\\sdk\\scripts\\codegen\\typescript.ts",
                "win32"
            )
        ).toBe(true);
    });

    it("emits JSDoc comments for described enum values", async () => {
        const schema: JSONSchema7 = {
            title: "SyntheticOptions",
            type: "object",
            additionalProperties: false,
            properties: {
                namedMode: {
                    title: "SyntheticMode",
                    type: "string",
                    enum: ["alpha", "beta"],
                    description: "Synthetic mode.",
                    "x-enumDescriptions": {
                        alpha: "Use alpha mode.",
                    },
                },
                inlineMode: {
                    type: "string",
                    enum: ["direct", "indirect"],
                    description: "Inline mode.",
                    "x-enumDescriptions": {
                        direct: "Use a direct value.",
                    },
                },
            },
            required: ["namedMode", "inlineMode"],
        };

        const code = await compile(normalizeSchemaForTypeScript(schema), "SyntheticOptions", {
            bannerComment: "",
            style: { semi: true, singleQuote: false },
            additionalProperties: false,
        });

        expect(code).toContain(
            'export type SyntheticMode = /** Use alpha mode. */ "alpha" | "beta";'
        );
        expect(code).toContain('inlineMode: /** Use a direct value. */ "direct" | "indirect";');
    });

    it("accepts future reload values without widening other enum definitions", async () => {
        const enumDefinition = (value: string): JSONSchema7 => ({
            type: "string",
            enum: [value],
            "x-enumDescriptions": { [value]: `Known ${value} value.` },
        });
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "ReloadOptions",
                type: "object",
                properties: {
                    status: { $ref: "#/definitions/CustomizationReloadStatus" },
                    subsystem: { $ref: "#/definitions/CustomizationReloadSubsystem" },
                    other: { $ref: "#/definitions/OtherStatus" },
                },
                definitions: {
                    CustomizationReloadStatus: enumDefinition("reloaded"),
                    CustomizationReloadSubsystem: enumDefinition("skills"),
                    OtherStatus: enumDefinition("known"),
                },
            }),
            "ReloadOptions",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toMatch(
            /export type CustomizationReloadStatus\s*=\s*\/\*\* Known reloaded value\. \*\/ "reloaded" \| \(string & \{\}\);/
        );
        expect(code).toMatch(
            /export type CustomizationReloadSubsystem\s*=\s*\/\*\* Known skills value\. \*\/ "skills" \| \(string & \{\}\);/
        );
        expect(code).toContain('export type OtherStatus = /** Known known value. */ "known";');
    });

    it("maps bare opaque properties to their marker aliases", async () => {
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "OpaqueProperty",
                type: "object",
                properties: {
                    json: { "x-opaque-json": true },
                    inProcess: { "x-opaque-in-process": true },
                },
                required: ["json", "inProcess"],
            }),
            "OpaqueProperty",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toContain("json: JsonValue;");
        expect(code).toContain("inProcess: OpaqueInProcessValue;");
    });

    it("maps a bare opaque JSON additional property to JsonValue", async () => {
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "OpaqueMap",
                type: "object",
                additionalProperties: { "x-opaque-json": true },
            }),
            "OpaqueMap",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toContain("[k: string]: JsonValue;");
    });

    it("keeps a titled discriminator literal inline", async () => {
        const variant = (action: string) => ({
            type: "object" as const,
            properties: {
                action: { type: "string" as const, const: action, title: "ReviewAction" },
            },
            required: ["action"],
        });
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "Review",
                anyOf: [variant("install"), variant("uninstall")],
            }),
            "Review",
            {
                bannerComment: "",
                style: { semi: true, singleQuote: false },
                additionalProperties: false,
            }
        );

        expect(code).toContain('action: "install";');
        expect(code).toContain('action: "uninstall";');
        expect(code).not.toContain("ReviewAction");
    });

    it("maps a bare opaque JSON array item to JsonValue", async () => {
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "OpaqueArray",
                type: "object",
                properties: { values: { type: "array", items: { "x-opaque-json": true } } },
                required: ["values"],
            }),
            "OpaqueArray",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toContain("values: JsonValue[];");
    });

    it("maps a bare opaque JSON definition to a named alias", async () => {
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "OpaqueDefinitionRoot",
                type: "object",
                properties: { value: { $ref: "#/definitions/OpaqueDefinition" } },
                definitions: { OpaqueDefinition: { "x-opaque-json": true } },
            }),
            "OpaqueDefinitionRoot",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toContain("export type OpaqueDefinition = JsonValue;");
    });

    it("keeps an opaque JSON node with anyOf as a union", async () => {
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "ConstrainedUnion",
                "x-opaque-json": true,
                anyOf: [{ type: "string" }, { type: "number" }],
            }),
            "ConstrainedUnion",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toContain("export type ConstrainedUnion = string | number;");
        expect(code).not.toContain("JsonValue");
    });

    it("keeps an opaque JSON node with object constraints as an object", async () => {
        const code = await compile(
            normalizeSchemaForTypeScript({
                title: "ConstrainedObject",
                type: "object",
                "x-opaque-json": true,
                properties: { name: { type: "string" } },
                required: ["name"],
            }),
            "ConstrainedObject",
            { bannerComment: "", style: { semi: true, singleQuote: false } }
        );

        expect(code).toContain("export interface ConstrainedObject {");
        expect(code).toContain("name: string;");
        expect(code).not.toContain("JsonValue");
    });

    it("removes both opaque markers from every normalized schema node", () => {
        const normalized = normalizeSchemaForTypeScript({
            type: "object",
            "x-opaque-json": true,
            properties: {
                json: { "x-opaque-json": true },
                inProcess: { "x-opaque-in-process": true },
            },
            additionalProperties: { "x-opaque-in-process": true },
        }) as Record<string, unknown>;

        const assertMarkersRemoved = (value: unknown): void => {
            if (Array.isArray(value)) {
                value.forEach(assertMarkersRemoved);
            } else if (value && typeof value === "object") {
                for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                    expect(key).not.toBe("x-opaque-json");
                    expect(key).not.toBe("x-opaque-in-process");
                    assertMarkersRemoved(child);
                }
            }
        };

        assertMarkersRemoved(normalized);
    });
});

describe("filterPublicSessionEventVariants", () => {
    const makeCollections = (defs: Record<string, JSONSchema7>): DefinitionCollections => ({
        definitions: defs,
        $defs: {},
    });

    it("keeps public union arms", () => {
        const defs = {
            PublicEvent: { type: "object" as const, properties: { type: { const: "pub" } } },
        };
        const variants: JSONSchema7[] = [{ $ref: "#/definitions/PublicEvent" }];
        const { publicVariants, excludedDefinitionNames } = filterPublicSessionEventVariants(
            variants,
            makeCollections(defs)
        );
        expect(publicVariants).toHaveLength(1);
        expect(excludedDefinitionNames.size).toBe(0);
    });

    it("excludes arms whose arm object is marked visibility:internal", () => {
        const defs = {
            InternalEvent: {
                type: "object" as const,
                visibility: "internal",
                properties: { type: { const: "internal.evt" } },
            } as JSONSchema7 & { visibility: string },
        };
        const variants: JSONSchema7[] = [
            { $ref: "#/definitions/InternalEvent", visibility: "internal" } as JSONSchema7 & {
                visibility: string;
            },
        ];
        const { publicVariants, excludedDefinitionNames } = filterPublicSessionEventVariants(
            variants,
            makeCollections(defs)
        );
        expect(publicVariants).toHaveLength(0);
        expect(excludedDefinitionNames.has("InternalEvent")).toBe(true);
    });

    it("excludes arms whose resolved definition is marked visibility:internal", () => {
        const defs = {
            InternalEvent: {
                type: "object" as const,
                visibility: "internal",
                properties: { type: { const: "internal.evt" } },
            } as JSONSchema7 & { visibility: string },
        };
        // arm object itself is NOT marked, but the resolved definition is
        const variants: JSONSchema7[] = [{ $ref: "#/definitions/InternalEvent" }];
        const { publicVariants, excludedDefinitionNames } = filterPublicSessionEventVariants(
            variants,
            makeCollections(defs)
        );
        expect(publicVariants).toHaveLength(0);
        expect(excludedDefinitionNames.has("InternalEvent")).toBe(true);
    });

    it("excludes arms whose internal data sub-property is the only internal marker (legacy pattern)", () => {
        // Event types that carry a `data: InternalData` field — the `data` property is what is
        // internal, not the event wrapper type itself.
        const defs = {
            InternalData: {
                type: "object" as const,
                visibility: "internal",
            } as JSONSchema7 & { visibility: string },
            WrapperEvent: {
                type: "object" as const,
                properties: {
                    type: { const: "wrapper.evt" },
                    data: { $ref: "#/definitions/InternalData" },
                },
            },
        };
        const variants: JSONSchema7[] = [{ $ref: "#/definitions/WrapperEvent" }];
        const { publicVariants, excludedDefinitionNames } = filterPublicSessionEventVariants(
            variants,
            makeCollections(defs)
        );
        expect(publicVariants).toHaveLength(0);
        expect(excludedDefinitionNames.has("WrapperEvent")).toBe(true);
        expect(excludedDefinitionNames.has("InternalData")).toBe(true);
    });
});

describe("assertNoPublicInternalReferences", () => {
    it("passes when all declarations are public and do not reference internal types", () => {
        const ts = `
export interface Foo {
  bar: string;
}
export type Bar = "a" | "b";
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).not.toThrow();
    });

    it("passes when the only reference is from an @internal-tagged declaration", () => {
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
/** @internal */
export interface AlsoInternal {
  h: Hidden;
}
export interface Public {
  y: string;
}
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).not.toThrow();
    });

    it("passes when the reference is inside an @internal-tagged member of a public type", () => {
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
export interface Public {
  /**
   * Some field.
   * @internal
   */
  secret?: Hidden;
  visible: string;
}
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).not.toThrow();
    });

    it("throws when a public declaration references an internal type directly", () => {
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
export type Event = PublicEvent | Hidden;
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).toThrow(
            /Event \(public\) references internal type Hidden/
        );
    });

    it("throws when a public interface member references an internal type", () => {
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
export interface Public {
  value: Hidden;
}
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).toThrow(
            /Public \(public\) references internal type Hidden/
        );
    });

    it("does not count JSDoc comment text as a code reference", () => {
        // The auto-generated JSDoc says 'via the definition "Hidden"' but that is not a
        // real TypeScript type reference — it must not trigger the validator.
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
export interface Preceding {
  y: string;
}
/**
 * This interface was referenced by something.
 * via the definition "Hidden".
 */
export interface Following {
  z: string;
}
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).not.toThrow();
    });

    it("does not count inline object-shaped @internal members as public references", () => {
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
export interface Public {
  /**
   * Some field.
   * @internal
   */
  secret?: {
    [k: string]: Hidden | undefined;
  };
  visible: string;
}
`;
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).not.toThrow();
    });

    it("does not count function body references as public type references", () => {
        const ts = `
/** @internal */
export interface Hidden {
  x: number;
}
/** @internal */
export function doInternal(connection: unknown): void {
  connection.onRequest("x", async (params: Hidden) => { return params; });
}
export function doPublic(connection: unknown): void {
  connection.onRequest("x", async (params: Hidden) => { return params; });
}
`;
        // function body references are stripped — only signature matters
        expect(() => assertNoPublicInternalReferences(ts, new Set(["Hidden"]))).not.toThrow();
    });
});

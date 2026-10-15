/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { generateGoRpcCode, generateGoSessionEventsCode } from "../../scripts/codegen/go.ts";
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

describe("Go shared schema baseline", () => {
    it("renders types, server/session calls, and nested namespaces", () => {
        const { typeCode } = generateGoRpcCode(rpcFixture());
        for (const field of [
            'ID string `json:"id"`',
            'Count int32 `json:"count"`',
            'Active bool `json:"active"`',
            'Score float64 `json:"score"`',
            'Tags []string `json:"tags"`',
            'Labels map[string]string `json:"labels"`',
            'DisplayName *string `json:"displayName,omitempty"`',
            'Note *string `json:"note,omitempty"`',
            'Items []SampleItem `json:"items"`',
        ])
            expect(typeCode).toContain(field);
        expect(typeCode.match(/type SampleItem struct/g)).toHaveLength(1);
        expect(typeCode).toContain('a.client.Request(ctx, "sample.get", params)');
        expect(typeCode).toContain('a.client.Request(ctx, "sample.nested.list", nil)');
        expect(typeCode).toContain("Ping(ctx context.Context)");
        expect(typeCode).toContain('req := map[string]any{"sessionId": a.sessionID}');
        expect(typeCode).toContain('a.client.Request(ctx, "session.sample.get", req)');
        expect(typeCode).toContain(
            'type SessionSampleGetRequest struct {\n\tID string `json:"id"`\n}'
        );
    });

    it("renders optional request fields as pointers", () => {
        const { typeCode } = generateGoRpcCode(optionalRequestFixture());
        expect(typeCode).toContain(
            "Configure(ctx context.Context, params ...*SampleConfigureRequest)"
        );
        expect(typeCode).toContain('Enabled *bool `json:"enabled,omitempty"`');
        expect(typeCode).toContain('a.client.Request(ctx, "sample.configure", requestParams)');
    });

    it.each(["anyOf", "oneOf"] as const)(
        "renders referenced %s unions and their codecs",
        (keyword) => {
            const { typeCode, encodingCode } = generateGoRpcCode(unionFixture(keyword));
            expect(typeCode).toContain("type SampleChoice interface");
            expect(typeCode).toContain('Choice SampleChoice `json:"choice"`');
            expect(typeCode).toContain('Choices []SampleChoice `json:"choices"`');
            expect(typeCode).toContain('SampleModeFast SampleMode = "fast"');
            expect(typeCode).toContain('SampleModeThorough SampleMode = "thorough"');
            expect(encodingCode).toContain("case SampleChoiceKindText:");
            expect(encodingCode).toContain("case SampleChoiceKindCount:");
            expect(encodingCode).toContain("unmarshalSampleChoice(rawItem)");
            expect(encodingCode).toContain(
                "&RawSampleChoiceData{Discriminator: raw.Kind, Raw: data}"
            );
            if (keyword === "anyOf") {
                expect({ "rpc.go": typeCode, "rpc_encoding.go": encodingCode }).toMatchSnapshot();
            }
        }
    );

    it("preserves method documentation and exposure annotations", () => {
        const { typeCode } = generateGoRpcCode(metadataFixture());
        expect(typeCode).toContain("// Preview an item.");
        expect(typeCode).toMatch(
            /\/\/ Experimental: Preview[^\n]*\n(?:\/\/[^\n]*\n)*func \(a \*ServerSampleAPI\) Preview\(/
        );
        expect(typeCode).toMatch(
            /\/\/ Deprecated: Retired[^\n]*\nfunc \(a \*ServerSampleAPI\) Retired\(/
        );
        expect(typeCode).toContain("func (a *InternalServerSampleAPI) Hidden(");
        expect(typeCode).not.toContain("func (a *ServerSampleAPI) Hidden(");
    });

    it.each(["clientSession", "clientGlobal"] as const)(
        "renders %s callback registration",
        (scope) => {
            const { typeCode } = generateGoRpcCode(callbackFixture(scope));
            expect(typeCode).toContain("SampleConfirmRequest");
            expect(typeCode).toContain("*SampleConfirmResult");
            expect(typeCode).toContain('client.SetRequestHandler("sample.confirm"');
            if (scope === "clientSession") {
                expect(typeCode).toContain("getHandlers(request.SessionID)");
                expect(typeCode).not.toContain('"sample.hidden"');
            } else {
                expect(typeCode).toContain('client.SetRequestHandler("sample.changed"');
                expect(typeCode).toContain("Changed(request *SampleChangedNotification) error");
            }
        }
    );

    it("renders event types and discriminator-driven JSON dispatch", () => {
        const { typeCode, encodingCode } = generateGoSessionEventsCode(eventFixture(), "rpc");
        expect(typeCode).toContain(
            'SessionEventTypeSampleUpdated SessionEventType = "sample.updated"'
        );
        expect(typeCode).toContain('Note *string `json:"note,omitempty"`');
        expect(typeCode).toContain('Sequence int32 `json:"sequence"`');
        expect(encodingCode).toContain("case SessionEventTypeSampleUpdated:");
        expect(encodingCode).toContain("e.Data = &d");
        expect({
            "session_events.go": typeCode,
            "session_events_encoding.go": encodingCode,
        }).toMatchSnapshot();
    });

    it("keeps existing signatures when a response gains an optional field", () => {
        const before = generateGoRpcCode(rpcFixture()).typeCode;
        const after = generateGoRpcCode(rpcFixture({ extra: { type: "string" } })).typeCode;
        const signature = "Get(ctx context.Context, params *SampleGetRequest) (*SampleItem, error)";
        expect(before).toContain(signature);
        expect(after).toContain(signature);
        expect(before).not.toContain("Extra ");
        expect(after).toContain('Extra *string `json:"extra,omitempty"`');
    });
});

describe("Go schema contract matrix", () => {
    it.each([
        ["scalar", "string", "*string", "omitempty"],
        ["object", "PresenceValue", "*PresenceValue", "omitempty"],
        ["array", "[]PresenceValue", "[]PresenceValue", "omitzero"],
        ["map", "map[string]PresenceValue", "map[string]PresenceValue", "omitzero"],
    ] as const)(
        "preserves presence and nullable storage for %s values",
        (shape, required, nullable, omit) => {
            const { typeCode } = generateGoRpcCode(presenceFixture(shape));
            for (const name of ["Presence", "SamplePresenceResult"]) {
                const declaration = typeCode.match(
                    new RegExp(`^type ${name} struct \\{[\\s\\S]*?^\\}`, "m")
                )?.[0];
                expect(declaration).toContain(`RequiredValue ${required} \`json:"requiredValue"\``);
                expect(declaration).toContain(
                    `RequiredNullable ${nullable} \`json:"requiredNullable"\``
                );
                expect(declaration).toContain(
                    `OptionalValue ${nullable} \`json:"optionalValue,${omit}"\``
                );
                expect(declaration).toContain(
                    `OptionalNullable ${nullable} \`json:"optionalNullable,${omit}"\``
                );
            }
        }
    );

    it("reuses multi-hop reference types across requests, results, arrays, and maps", () => {
        const { typeCode } = generateGoRpcCode(referenceFixture());
        for (const name of ["ReferenceGraph", "ReferenceNode", "ReferenceLeaf"])
            expect(typeCode.match(new RegExp(`^type ${name} struct \\{`, "gm"))).toHaveLength(1);
        const graph = typeCode.match(/^type ReferenceGraph struct \{[\s\S]*?^\}/m)?.[0];
        expect(graph).toContain('First ReferenceNode `json:"first"`');
        expect(graph).toContain('Second ReferenceNode `json:"second"`');
        expect(graph).toContain('Nodes []ReferenceNode `json:"nodes"`');
        expect(graph).toContain('Lookup map[string]ReferenceNode `json:"lookup"`');
        expect(typeCode).toContain(
            'type ReferenceNode struct {\n\tLeaf ReferenceLeaf `json:"leaf"`\n}'
        );
        expect(typeCode).toContain(
            "Graph(ctx context.Context, params *ReferenceGraph) (*ReferenceGraph, error)"
        );
    });

    it("maps empty, open, and opaque JSON shapes without inventing fields", () => {
        const { typeCode } = generateGoRpcCode(jsonShapesFixture());
        expect(typeCode.match(/^type JSONShapes struct \{[\s\S]*?^\}/m)?.[0]).toBe(
            'type JSONShapes struct {\n\tEmpty any `json:"empty"`\n\tOpaque any `json:"opaque"`\n\tOpen map[string]any `json:"open"`\n}'
        );
    });

    it.each(["anyOf", "oneOf"] as const)(
        "decodes nested %s unions and extends dispatch when a variant is added",
        (keyword) => {
            const before = generateGoRpcCode(nestedUnionFixture(keyword));
            const after = generateGoRpcCode(nestedUnionFixture(keyword, true));
            for (const { typeCode, encodingCode } of [before, after]) {
                const result = typeCode.match(
                    /^type SampleDecideResult struct \{[\s\S]*?^\}/m
                )?.[0];
                expect(result).toContain('Decisions map[string]Verdict `json:"decisions"`');
                expect(result).toContain('Selected Verdict `json:"selected"`');
                const decode = encodingCode.match(
                    /^func \(r \*SampleDecideResult\) UnmarshalJSON[\s\S]*?^\}/m
                )?.[0];
                expect(decode).toContain("for key, rawValue := range raw.Decisions");
                expect(decode).toContain("value, err := unmarshalVerdict(rawValue)");
                expect(decode).toContain("value, err := unmarshalVerdict(raw.Selected)");
                expect(decode).toContain("r.Decisions[key] = value");
                expect(decode).toContain("r.Selected = value");
            }
            const cases = (code: string) =>
                [...code.matchAll(/case VerdictKind(\w+):/g)].map((match) => match[1]);
            expect(cases(before.encodingCode)).toEqual(["Allow", "Deny"]);
            expect(cases(after.encodingCode)).toEqual(["Allow", "Deny", "Pending"]);
            const declaration = /^type AllowVerdict struct \{[\s\S]*?^\}/m;
            expect(before.typeCode).toMatch(declaration);
            expect(after.typeCode.match(declaration)?.[0]).toBe(
                before.typeCode.match(declaration)?.[0]
            );
        }
    );

    it("distinguishes false from an absent boolean discriminator in codecs", () => {
        const { typeCode, encodingCode } = generateGoRpcCode(booleanUnionFixture());
        const decode = encodingCode.match(/^func unmarshalEnqueueCommandResult[\s\S]*?^\}/m)?.[0];
        expect(decode).toContain('Queued *bool `json:"queued"`');
        expect(decode).toContain("if raw.Queued == nil");
        expect(decode).toContain("switch *raw.Queued");
        expect(decode).toContain("case false:");
        expect(decode).toContain("case true:");
        expect(typeCode).toContain(
            "func (AcceptedEnqueueCommandResult) Queued() bool {\n\treturn true\n}"
        );
        expect(typeCode).toContain(
            "func (UnsupportedEnqueueCommandResult) Queued() bool {\n\treturn false\n}"
        );
        const encode = encodingCode.match(
            /^func \(r UnsupportedEnqueueCommandResult\) MarshalJSON[\s\S]*?^\}/m
        )?.[0];
        expect(encode).toContain('Queued bool `json:"queued"`');
        expect(encode).not.toContain("omitempty");
    });

    it("keeps wire names while normalizing identifiers and acronyms", () => {
        const { typeCode } = generateGoRpcCode(namingFixture());
        expect(typeCode.match(/^type WireNames struct \{[\s\S]*?^\}/m)?.[0]).toBe(
            'type WireNames struct {\n\tClass string `json:"class"`\n\tContentType string `json:"content-type"`\n\tDefault bool `json:"default"`\n\tRequestID string `json:"requestId"`\n\tType string `json:"type"`\n}'
        );
    });

    it("separates internal receivers without duplicating shared types", () => {
        const { typeCode } = generateGoRpcCode(visibilityFixture());
        expect(typeCode).toContain("func (a *ServerSampleAPI) Visible(");
        expect(typeCode).toContain("func (a *InternalServerSampleAPI) Secret(");
        expect(typeCode).not.toContain("func (a *ServerSampleAPI) Secret(");
        expect(typeCode).not.toContain("func (a *InternalServerSampleAPI) Visible(");
        expect(typeCode).toContain("func (a *ServerHostAPI) Visible(");
        expect(typeCode).toContain("func (a *InternalServerHostAPI) Secret(");
        expect(typeCode).not.toContain("func (a *ServerHostAPI) Secret(");
        expect(typeCode.match(/^type SharedValue struct \{/gm)).toHaveLength(1);
    });

    it("dispatches every empty, object, and union event to its own payload", () => {
        const { typeCode, encodingCode } = generateGoSessionEventsCode(eventMatrixFixture(), "rpc");
        expect(
            [...encodingCode.matchAll(/case SessionEventType(\w+):/g)].map((match) => match[1])
        ).toEqual(["MatrixEmpty", "MatrixUnion", "MatrixValue"]);
        for (const name of ["Empty", "Union", "Value"]) {
            expect(
                typeCode.match(new RegExp(`^type Matrix${name}Data struct \\{`, "gm"))
            ).toHaveLength(1);
            expect(encodingCode).toContain(
                `case SessionEventTypeMatrix${name}:\n\t\tvar d Matrix${name}Data`
            );
        }
        expect(encodingCode).toContain("func (r *MatrixUnionData) UnmarshalJSON(");
        expect(typeCode.match(/^type MatrixValueData struct \{[\s\S]*?^\}/m)?.[0]).toContain(
            'Sequence int32 `json:"sequence"`'
        );
    });

    it("does not retain types or codecs between unrelated schemas", () => {
        const before = generateGoRpcCode(referenceFixture());
        const eventsBefore = generateGoSessionEventsCode(eventFixture(), "rpc");
        generateGoRpcCode(nestedUnionFixture("oneOf", true));
        generateGoSessionEventsCode(eventMatrixFixture(), "rpc");
        expect(generateGoRpcCode(referenceFixture())).toEqual(before);
        expect(generateGoSessionEventsCode(eventFixture(), "rpc")).toEqual(eventsBefore);
    });
});

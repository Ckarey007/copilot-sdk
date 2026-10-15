/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { JSONSchema7 } from "json-schema";
import type { ApiSchema } from "../../scripts/codegen/utils.ts";

/** Return fresh schemas: several production renderers mutate their input. */
export function rpcFixture(extraProperties: Record<string, JSONSchema7> = {}): ApiSchema {
    return {
        definitions: {
            SampleItem: {
                type: "object",
                title: "SampleItem",
                description: "An item returned by the sample service.",
                additionalProperties: false,
                properties: {
                    id: { type: "string" },
                    count: { type: "integer", minimum: 0, maximum: 100 },
                    active: { type: "boolean" },
                    score: { type: "number" },
                    tags: { type: "array", items: { type: "string" } },
                    labels: { type: "object", additionalProperties: { type: "string" } },
                    displayName: { type: "string" },
                    note: { type: ["string", "null"] },
                    ...extraProperties,
                },
                required: ["id", "count", "active", "score", "tags", "labels"],
            },
        },
        server: {
            sample: {
                get: {
                    rpcMethod: "sample.get",
                    description: "Look up an item.",
                    params: {
                        title: "SampleGetRequest",
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"],
                    },
                    result: { $ref: "#/definitions/SampleItem" },
                },
                ping: { rpcMethod: "sample.ping", params: null, result: { type: "null" } },
                nested: {
                    list: {
                        rpcMethod: "sample.nested.list",
                        params: null,
                        result: {
                            title: "SampleListResult",
                            type: "object",
                            properties: {
                                items: {
                                    type: "array",
                                    items: { $ref: "#/definitions/SampleItem" },
                                },
                            },
                            required: ["items"],
                        },
                    },
                },
            },
        },
        session: {
            sample: {
                get: {
                    rpcMethod: "session.sample.get",
                    params: {
                        title: "SessionSampleGetRequest",
                        type: "object",
                        properties: {
                            sessionId: { type: "string" },
                            id: { type: "string" },
                        },
                        required: ["sessionId", "id"],
                    },
                    result: { $ref: "#/definitions/SampleItem" },
                },
            },
        },
    };
}

export function unionFixture(keyword: "anyOf" | "oneOf"): ApiSchema {
    return {
        definitions: {
            SampleChoice: {
                title: "SampleChoice",
                [keyword]: [
                    {
                        type: "object",
                        properties: {
                            kind: { type: "string", const: "text" },
                            text: { type: "string" },
                        },
                        required: ["kind", "text"],
                    },
                    {
                        type: "object",
                        properties: {
                            kind: { type: "string", const: "count" },
                            count: { type: "integer" },
                        },
                        required: ["kind", "count"],
                    },
                ],
            },
            SampleChoices: {
                type: "object",
                properties: {
                    choice: { $ref: "#/definitions/SampleChoice" },
                    choices: { type: "array", items: { $ref: "#/definitions/SampleChoice" } },
                    mode: { type: "string", enum: ["fast", "thorough"], title: "SampleMode" },
                },
                required: ["choice", "choices", "mode"],
            },
        },
        server: {
            sample: {
                choose: {
                    rpcMethod: "sample.choose",
                    params: null,
                    result: { $ref: "#/definitions/SampleChoices" },
                },
            },
        },
    };
}

export function metadataFixture(): ApiSchema {
    return {
        server: {
            sample: {
                preview: {
                    rpcMethod: "sample.preview",
                    description: "Preview an item.",
                    stability: "experimental",
                    params: null,
                    result: {
                        title: "SamplePreviewResult",
                        type: "object",
                        properties: { name: { type: "string" } },
                        required: ["name"],
                    },
                },
                retired: {
                    rpcMethod: "sample.retired",
                    deprecated: true,
                    params: null,
                    result: { type: "null" },
                },
                hidden: {
                    rpcMethod: "sample.hidden",
                    visibility: "internal",
                    params: null,
                    result: { type: "null" },
                },
            },
        },
    };
}

export function optionalRequestFixture(): ApiSchema {
    return {
        server: {
            sample: {
                configure: {
                    rpcMethod: "sample.configure",
                    params: {
                        anyOf: [
                            { not: {} },
                            {
                                title: "SampleConfigureRequest",
                                type: "object",
                                properties: { enabled: { type: "boolean" } },
                            },
                        ],
                    },
                    result: { type: "null" },
                },
            },
        },
    };
}

export function callbackFixture(scope: "clientSession" | "clientGlobal"): ApiSchema {
    const methods = {
        confirm: {
            rpcMethod: "sample.confirm",
            params: {
                title: "SampleConfirmRequest",
                type: "object",
                properties: {
                    message: { type: "string" },
                    ...(scope === "clientSession" ? { sessionId: { type: "string" } } : {}),
                },
                required: scope === "clientSession" ? ["message", "sessionId"] : ["message"],
            },
            result: {
                title: "SampleConfirmResult",
                type: "object",
                properties: { accepted: { type: "boolean" } },
                required: ["accepted"],
            },
        },
        changed: {
            rpcMethod: "sample.changed",
            notification: true,
            params: {
                title: "SampleChangedNotification",
                type: "object",
                properties: {
                    revision: { type: "integer" },
                    ...(scope === "clientSession" ? { sessionId: { type: "string" } } : {}),
                },
                required: scope === "clientSession" ? ["revision", "sessionId"] : ["revision"],
            },
            result: { type: "null" },
        },
        ...(scope === "clientSession"
            ? {
                  hidden: {
                      rpcMethod: "sample.hidden",
                      visibility: "internal",
                      params: { title: "SampleHiddenRequest", type: "object", properties: {} },
                      result: { type: "null" },
                  },
              }
            : {}),
    };
    return { [scope]: { sample: methods } };
}

export function eventPayloadFixture(): JSONSchema7 {
    return {
        type: "object",
        properties: {
            message: { type: "string" },
            sequence: { type: "integer", minimum: 0, maximum: 100 },
            active: { type: "boolean" },
            tags: { type: "array", items: { type: "string" } },
            note: { type: ["string", "null"] },
        },
        required: ["message", "sequence", "active", "tags"],
    };
}

export function eventFixture(): JSONSchema7 {
    return {
        definitions: {
            SessionEvent: {
                anyOf: [
                    {
                        type: "object",
                        properties: {
                            id: { type: "string", format: "uuid" },
                            timestamp: { type: "string", format: "date-time" },
                            parentId: { type: ["string", "null"] },
                            type: { type: "string", const: "sample.updated" },
                            data: eventPayloadFixture(),
                        },
                        required: ["id", "timestamp", "type", "data"],
                    },
                ],
            },
        },
    };
}

/** Python's production RPC postprocessor requires these historical compatibility types. */
export function pythonRpcFixture(schema: ApiSchema): ApiSchema {
    return {
        ...schema,
        definitions: {
            MCPServerConfigHTTP: {
                title: "MCPServerConfigHTTP",
                type: "object",
                properties: {
                    url: { type: "string" },
                    oauthScopes: { type: "array", items: { type: "string" } },
                },
                required: ["url"],
            },
            SessionFsSetProviderCapabilities: {
                title: "SessionFsSetProviderCapabilities",
                type: "object",
                additionalProperties: false,
                properties: {
                    sqlite: { type: "boolean" },
                    binary: { type: "boolean" },
                },
            },
            ...schema.definitions,
        },
    };
}

export function presenceFixture(shape: "scalar" | "object" | "array" | "map"): ApiSchema {
    const shapes: Record<typeof shape, JSONSchema7> = {
        scalar: { type: "string" },
        object: { $ref: "#/definitions/PresenceValue" },
        array: { type: "array", items: { $ref: "#/definitions/PresenceValue" } },
        map: { type: "object", additionalProperties: { $ref: "#/definitions/PresenceValue" } },
    };
    const value = shapes[shape];
    return {
        definitions: {
            PresenceValue: {
                type: "object",
                additionalProperties: false,
                properties: { name: { type: "string" } },
                required: ["name"],
            },
            Presence: {
                type: "object",
                additionalProperties: false,
                properties: {
                    requiredValue: structuredClone(value),
                    optionalValue: structuredClone(value),
                    requiredNullable: { anyOf: [structuredClone(value), { type: "null" }] },
                    optionalNullable: { anyOf: [structuredClone(value), { type: "null" }] },
                },
                required: ["requiredValue", "requiredNullable"],
            },
        },
        server: {
            sample: {
                presence: {
                    rpcMethod: "sample.presence",
                    params: null,
                    result: { $ref: "#/definitions/Presence" },
                },
            },
        },
    };
}

export function referenceFixture(): ApiSchema {
    return {
        definitions: {
            ReferenceLeaf: {
                type: "object",
                additionalProperties: false,
                properties: { code: { type: "string" } },
                required: ["code"],
            },
            ReferenceNode: {
                type: "object",
                additionalProperties: false,
                properties: { leaf: { $ref: "#/definitions/ReferenceLeaf" } },
                required: ["leaf"],
            },
            ReferenceGraph: {
                type: "object",
                additionalProperties: false,
                properties: {
                    first: { $ref: "#/definitions/ReferenceNode" },
                    second: { $ref: "#/definitions/ReferenceNode" },
                    nodes: { type: "array", items: { $ref: "#/definitions/ReferenceNode" } },
                    lookup: {
                        type: "object",
                        additionalProperties: { $ref: "#/definitions/ReferenceNode" },
                    },
                },
                required: ["first", "second", "nodes", "lookup"],
            },
        },
        server: {
            sample: {
                graph: {
                    rpcMethod: "sample.graph",
                    params: { $ref: "#/definitions/ReferenceGraph" },
                    result: { $ref: "#/definitions/ReferenceGraph" },
                },
            },
        },
    };
}

export function jsonShapesFixture(): ApiSchema {
    return {
        server: {
            sample: {
                json: {
                    rpcMethod: "sample.json",
                    params: null,
                    result: {
                        title: "JsonShapes",
                        type: "object",
                        properties: {
                            empty: { type: "object", properties: {}, additionalProperties: false },
                            open: { type: "object", additionalProperties: true },
                            opaque: { "x-opaque-json": true } as JSONSchema7,
                        },
                        required: ["empty", "open", "opaque"],
                    },
                },
            },
        },
    };
}

export function nestedUnionFixture(keyword: "anyOf" | "oneOf", addVariant = false): ApiSchema {
    const variants = ["Allow", "Deny", ...(addVariant ? ["Pending"] : [])];
    return {
        definitions: {
            ...Object.fromEntries(
                variants.map((kind) => [
                    `${kind}Verdict`,
                    {
                        title: `${kind}Verdict`,
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            kind: { type: "string", const: kind.toLowerCase() },
                            message: { type: "string" },
                        },
                        required: ["kind", "message"],
                    },
                ])
            ),
            Verdict: {
                title: "Verdict",
                [keyword]: variants.map((kind) => ({ $ref: `#/definitions/${kind}Verdict` })),
            },
            VerdictSet: {
                type: "object",
                properties: {
                    selected: { anyOf: [{ $ref: "#/definitions/Verdict" }, { type: "null" }] },
                    decisions: {
                        type: "object",
                        additionalProperties: { $ref: "#/definitions/Verdict" },
                    },
                },
                required: ["selected", "decisions"],
            },
        },
        server: {
            sample: {
                decide: {
                    rpcMethod: "sample.decide",
                    params: null,
                    result: { $ref: "#/definitions/VerdictSet" },
                },
            },
        },
    };
}

export function booleanUnionFixture(): ApiSchema {
    // Rust's boolean-union emission is restricted to these published type names.
    return {
        definitions: {
            EnqueueCommandResult: {
                anyOf: [
                    { $ref: "#/definitions/AcceptedEnqueueCommandResult" },
                    { $ref: "#/definitions/UnsupportedEnqueueCommandResult" },
                ],
            },
            AcceptedEnqueueCommandResult: {
                type: "object",
                properties: {
                    queued: { type: "boolean", const: true },
                    value: { type: "string" },
                },
                required: ["queued", "value"],
            },
            UnsupportedEnqueueCommandResult: {
                type: "object",
                properties: {
                    queued: { type: "boolean", const: false },
                    reason: { type: "string" },
                },
                required: ["queued", "reason"],
            },
        },
        server: {
            sample: {
                accept: {
                    rpcMethod: "sample.accept",
                    params: null,
                    result: { $ref: "#/definitions/EnqueueCommandResult" },
                },
            },
        },
    };
}

export function namingFixture(): ApiSchema {
    return {
        server: {
            sample: {
                names: {
                    rpcMethod: "sample.names",
                    params: null,
                    result: {
                        title: "WireNames",
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            class: { type: "string" },
                            default: { type: "boolean" },
                            type: { type: "string" },
                            requestId: { type: "string" },
                            "content-type": { type: "string" },
                        },
                        required: ["class", "default", "type", "requestId", "content-type"],
                    },
                },
            },
        },
    };
}

export function visibilityFixture(): ApiSchema {
    return {
        definitions: {
            SharedValue: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
            SecretLeaf: {
                type: "object",
                properties: { secret: { type: "string" } },
                required: ["secret"],
            },
            PublicResult: {
                type: "object",
                properties: { shared: { $ref: "#/definitions/SharedValue" } },
                required: ["shared"],
            },
            PrivateResult: {
                type: "object",
                properties: {
                    shared: { $ref: "#/definitions/SharedValue" },
                    detail: { $ref: "#/definitions/SecretLeaf" },
                },
                required: ["shared", "detail"],
            },
        },
        server: {
            sample: {
                visible: {
                    rpcMethod: "sample.visible",
                    params: null,
                    result: { $ref: "#/definitions/PublicResult" },
                },
                secret: {
                    rpcMethod: "sample.secret",
                    visibility: "internal",
                    params: null,
                    result: { $ref: "#/definitions/PrivateResult" },
                },
            },
            host: {
                visible: {
                    rpcMethod: "host.visible",
                    params: null,
                    result: { $ref: "#/definitions/PublicResult" },
                },
                secret: {
                    rpcMethod: "host.secret",
                    visibility: "internal",
                    params: null,
                    result: { $ref: "#/definitions/PrivateResult" },
                },
            },
        },
    };
}

export function eventMatrixVariants() {
    return [
        {
            typeName: "matrix.empty",
            className: "MatrixEmptyEvent",
            dataSchema: { type: "object", properties: {} },
        },
        {
            typeName: "matrix.value",
            className: "MatrixValueEvent",
            dataSchema: eventPayloadFixture(),
        },
        {
            typeName: "matrix.union",
            className: "MatrixUnionEvent",
            dataSchema: {
                anyOf: ["first", "second"].map((kind) => ({
                    type: "object",
                    properties: {
                        kind: { type: "string", const: kind },
                        value: { type: "string" },
                    },
                    required: ["kind", "value"],
                })),
            },
        },
    ] satisfies { typeName: string; className: string; dataSchema: JSONSchema7 }[];
}

export function eventMatrixFixture(): JSONSchema7 {
    return {
        definitions: {
            ...Object.fromEntries(
                eventMatrixVariants().map((variant) => [variant.className, variant.dataSchema])
            ),
            SessionEvent: {
                anyOf: eventMatrixVariants().map((variant) => ({
                    type: "object",
                    properties: {
                        type: { const: variant.typeName },
                        data: { $ref: `#/definitions/${variant.className}` },
                    },
                    required: ["type", "data"],
                })),
            },
        },
    };
}

export function sharedReferenceFixture() {
    const api = referenceFixture();
    const events: JSONSchema7 = {
        definitions: {
            ...structuredClone(api.definitions),
            SessionEvent: {
                anyOf: [
                    {
                        type: "object",
                        properties: {
                            type: { const: "matrix.shared" },
                            data: {
                                type: "object",
                                properties: { graph: { $ref: "#/definitions/ReferenceGraph" } },
                                required: ["graph"],
                            },
                        },
                        required: ["type", "data"],
                    },
                ],
            },
        },
    };
    return { api, events };
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from "http";
import { AddressInfo } from "net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
    approveAll,
    CopilotRequestHandler,
    CopilotWebSocketForwarder,
    defineTool,
    type CopilotRequestContext,
    type SessionConfig,
} from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { waitForCondition } from "./harness/sdkTestHelper.js";
import { mcpTestServerConfig } from "./harness/mcpTestServer.js";

const HTTP_TEXT = "OK from synthetic HTTP upstream.";
const WS_TEXT = "OK from synthetic WS upstream.";

/**
 * Stand up an in-process upstream that speaks the real CAPI shapes the
 * runtime needs: model catalog, policy, `/responses` SSE for HTTP
 * inference, and a WebSocket endpoint at `/responses` that answers each
 * inbound `response.create` with the ordered `/responses` events the
 * reducer expects.
 *
 * Returned `url` is what the handler subclass rewrites every
 * intercepted request to point at — the runtime never talks to this
 * server directly; the handler does, on the runtime's behalf.
 */
async function startFakeUpstream(): Promise<{
    url: string;
    server: HttpServer;
    wsRequestCount: () => number;
    wsBodies: () => Array<Record<string, unknown>>;
    httpBodies: () => Array<Record<string, unknown>>;
    chatBodies: () => Array<Record<string, unknown>>;
    close: () => Promise<void>;
}> {
    let wsRequests = 0;
    const wsBodies: Array<Record<string, unknown>> = [];
    const httpBodies: Array<Record<string, unknown>> = [];
    const chatBodies: Array<Record<string, unknown>> = [];

    const httpServer = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        if (url.pathname === "/models" && req.method === "GET") {
            sendJson(res, 200, {
                data: [
                    {
                        id: "claude-sonnet-5",
                        name: "Claude Sonnet 5",
                        object: "model",
                        vendor: "Anthropic",
                        version: "1",
                        preview: false,
                        model_picker_enabled: true,
                        supported_endpoints: ["/responses", "ws:/responses"],
                        capabilities: {
                            type: "chat",
                            family: "claude-sonnet-5",
                            tokenizer: "o200k_base",
                            limits: {
                                max_context_window_tokens: 200000,
                                max_output_tokens: 8192,
                            },
                            supports: {
                                streaming: true,
                                tool_calls: true,
                                parallel_tool_calls: true,
                                vision: true,
                            },
                        },
                    },
                    {
                        id: "gpt-5.5",
                        name: "GPT-5.5",
                        vendor: "OpenAI",
                        model_picker_enabled: true,
                        supported_endpoints: ["/chat/completions"],
                        capabilities: {
                            type: "chat",
                            family: "gpt-5.5",
                            tokenizer: "o200k_base",
                            limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
                            supports: { streaming: true, tool_calls: true },
                        },
                    },
                    {
                        id: "gpt-6-sol",
                        name: "GPT-6 Sol",
                        object: "model",
                        vendor: "OpenAI",
                        version: "1",
                        preview: false,
                        model_picker_enabled: true,
                        supported_endpoints: ["/responses", "ws:/responses"],
                        capabilities: {
                            type: "chat",
                            family: "gpt-6-sol",
                            tokenizer: "o200k_base",
                            limits: {
                                max_context_window_tokens: 200000,
                                max_output_tokens: 8192,
                            },
                            supports: {
                                streaming: true,
                                tool_calls: true,
                                parallel_tool_calls: true,
                            },
                        },
                    },
                ],
            });
            return;
        }
        if (url.pathname.endsWith("/models/session")) {
            sendJson(res, 200, {});
            return;
        }
        if (url.pathname.includes("/policy")) {
            sendJson(res, 200, { state: "enabled" });
            return;
        }
        if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
            drainBody(req)
                .then((raw) => {
                    const body = JSON.parse(raw.toString()) as Record<string, unknown>;
                    chatBodies.push(body);
                    const serialized = JSON.stringify(body.messages);
                    const toolResult = (body.messages as Array<{ role: string }>).some(
                        (message) => message.role === "tool"
                    );
                    const call =
                        serialized.includes("SDK_CHAT_RESTORED") &&
                        !serialized.includes("SDK_CHAT_EXECUTED_RESULT");
                    const removedCall = serialized.includes("SDK_CHAT_REMOVED") && !toolResult;
                    const message =
                        call || removedCall
                            ? {
                                  role: "assistant",
                                  content: null,
                                  tool_calls: [
                                      {
                                          index: 0,
                                          id: "chat_call",
                                          type: "function",
                                          function: { name: "sdk_chat_removed", arguments: "{}" },
                                      },
                                  ],
                              }
                            : {
                                  role: "assistant",
                                  content: serialized.includes("SDK_CHAT_RESTORED")
                                      ? "SDK_CHAT_RESTORED_OK"
                                      : serialized.includes("SDK_CHAT_REMOVED")
                                        ? "SDK_CHAT_REMOVED_OK"
                                        : "SDK_CHAT_FIRST_OK",
                              };
                    const finishReason = call || removedCall ? "tool_calls" : "stop";
                    if (body.stream !== true) {
                        sendJson(res, 200, {
                            id: "chat_response",
                            choices: [{ index: 0, message, finish_reason: finishReason }],
                            usage: { prompt_tokens: 5, completion_tokens: 7 },
                        });
                        return;
                    }
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.write(
                        `data: ${JSON.stringify({ id: "chat_response", choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`
                    );
                    res.end(
                        `data: ${JSON.stringify({ id: "chat_response", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`
                    );
                })
                .catch((error: unknown) => {
                    sendJson(res, 500, { error: String(error) });
                });
            return;
        }
        if (url.pathname.endsWith("/responses") && req.method === "POST") {
            drainBody(req)
                .then((raw) => {
                    const body = JSON.parse(raw.toString()) as Record<string, unknown>;
                    httpBodies.push(body);
                    const events = toolUpdateEvents(body, "resp_stub_http", HTTP_TEXT);
                    if (events[0]?.type === "error") {
                        sendJson(res, 422, { error: events[0].error });
                        return;
                    }
                    if (body.stream !== true) {
                        sendJson(res, 200, events.at(-1)!.response);
                        return;
                    }
                    res.writeHead(200, {
                        "content-type": "text/event-stream",
                        "cache-control": "no-cache",
                    });
                    for (const event of events) {
                        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                    }
                    res.end();
                })
                .catch(() => {
                    res.writeHead(500).end();
                });
            return;
        }
        // Anything else: not found.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
    });

    const wss = new WebSocketServer({ server: httpServer, path: "/responses" });
    wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
            wsRequests++;
            const body = JSON.parse(raw.toString()) as Record<string, unknown>;
            wsBodies.push(body);
            const id = `resp_stub_ws_${wsRequests}`;
            for (const event of toolUpdateEvents(body, id, WS_TEXT)) {
                socket.send(JSON.stringify(event));
            }
        });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    return {
        url,
        server: httpServer,
        wsRequestCount: () => wsRequests,
        wsBodies: () => [...wsBodies],
        httpBodies: () => [...httpBodies],
        chatBodies: () => [...chatBodies],
        async close() {
            wss.clients.forEach((c) => c.terminate());
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        },
    };
}

function toolUpdateEvents(
    body: Record<string, unknown>,
    id: string,
    defaultText: string
): Array<Record<string, unknown>> {
    const input = JSON.stringify(body.input);
    const positionedUpdate =
        Array.isArray(body.input) &&
        body.input.some((item: { type?: string }) => item.type === "additional_tools");
    const rejection = {
        type: "error",
        error: {
            code: "bad_request",
            type: "websocket_error",
            message: "additional_tools rejected",
        },
    };
    const restricted =
        (body.tool_choice as { type?: string } | undefined)?.type === "allowed_tools";
    if (positionedUpdate && input.includes("SDK_RESPONSES_REJECT_GENERIC")) {
        return [{ type: "error", error: { message: "invalid request" } }];
    }
    if (restricted && input.includes("SDK_ALLOWLIST_REJECT_BEFORE")) {
        return [
            {
                ...rejection,
                error: {
                    ...rejection.error,
                    code: "invalid_request_body",
                    message: "allowed_tools rejected",
                },
            },
        ];
    }
    if (restricted && input.includes("SDK_ALLOWLIST_REJECT_AFTER")) {
        return [
            ...buildResponsesEvents("already streamed", id).slice(0, 4),
            {
                ...rejection,
                error: {
                    ...rejection.error,
                    code: "invalid_request_body",
                    message: "allowed_tools rejected",
                },
            },
        ];
    }
    if (input.includes("SDK_REMOVAL_RESTORED")) {
        return buildResponsesEvents("SDK_REMOVAL_RESTORED_OK", id);
    }
    if (input.includes("SDK_REMOVAL_ALL")) {
        return buildResponsesEvents(defaultText, id);
    }
    if (input.includes("SDK_ALLOWLIST_REJECT_BEFORE")) {
        return buildResponsesEvents("SDK_ALLOWLIST_RECOVERED", id);
    }
    if (positionedUpdate && input.includes("SDK_RESPONSES_REJECT_BEFORE")) {
        return [rejection];
    }
    if (positionedUpdate && input.includes("SDK_RESPONSES_REJECT_AFTER")) {
        return [...buildResponsesEvents("already streamed", id).slice(0, 4), rejection];
    }
    if (input.includes("SDK_RESPONSES_LEGACY_FOLLOW_UP")) {
        return buildResponsesEvents("SDK_RESPONSES_LEGACY_OK", id);
    }
    if (input.includes("SDK_RESPONSES_REJECT_BEFORE")) {
        return buildResponsesEvents("SDK_RESPONSES_RECOVERED", id);
    }
    if (input.includes("MCP_RESPONSES_REMOVED_AGAIN")) {
        return buildResponsesEvents("MCP_RESPONSES_REMOVED_OK", id);
    }
    if (input.includes("MCP_RESPONSES_AFTER") && !input.includes("MCP_ADDED_TOOL_RESULT")) {
        return buildFunctionCallEvents(
            id,
            "a_server-get_env",
            JSON.stringify({ name: "CACHE_TEST_RESULT" })
        );
    }
    if (input.includes("MCP_ADDED_TOOL_RESULT")) {
        return buildResponsesEvents("MCP_RESPONSES_TOOL_OK", id);
    }
    if (input.includes("SDK_RESPONSES_AFTER") && !input.includes("SDK_ADDED_TOOL_RESULT")) {
        return buildFunctionCallEvents(id);
    }
    return buildResponsesEvents(
        input.includes("SDK_ADDED_TOOL_RESULT") ? "SDK_RESPONSES_TOOL_OK" : defaultText,
        id
    );
}

function buildFunctionCallEvents(
    id: string,
    name = "sdk_epoch_added",
    args = "{}"
): Array<Record<string, unknown>> {
    const call = {
        type: "function_call",
        id: "fc_sdk_added",
        call_id: "call_sdk_added",
        name,
        arguments: args,
        status: "completed",
    };
    return [
        {
            type: "response.created",
            response: { id, object: "response", status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item: call },
        { type: "response.output_item.done", output_index: 0, item: call },
        {
            type: "response.completed",
            response: {
                id,
                object: "response",
                status: "completed",
                output: [call],
                usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
            },
        },
    ];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

async function drainBody(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    return Buffer.concat(parts);
}

function buildResponsesEvents(text: string, id: string): Array<Record<string, unknown>> {
    return [
        {
            type: "response.created",
            response: { id, object: "response", status: "in_progress", output: [] },
        },
        {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: "msg_1", type: "message", role: "assistant", content: [] },
        },
        {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_text.done", output_index: 0, content_index: 0, text },
        {
            type: "response.completed",
            response: {
                id,
                object: "response",
                status: "completed",
                output: [
                    {
                        id: "msg_1",
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text }],
                    },
                ],
                usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
            },
        },
    ];
}

interface Counters {
    httpRequests: number;
    httpResponses: number;
    wsRequestMessages: number;
    wsResponseMessages: number;
}

/**
 * Single handler subclass that services BOTH transports against the
 * per-test fake upstream. Demonstrates mutation in each direction:
 *
 * - HTTP: rewrites the URL to point at the test server, adds an
 *   `X-Test-Mutated` header to the outbound request, and adds an
 *   `X-Test-Response-Mutated` header on the way back. The test server
 *   echoes the request header into a counter so we can assert it
 *   actually arrived upstream.
 * - WebSocket: rewrites the WS URL similarly and forwards through the
 *   default WebSocket forwarder while observing message counts in both
 *   directions.
 */
class TestHandler extends CopilotRequestHandler {
    constructor(
        private readonly upstreamUrl: string,
        private readonly counters: Counters,
        private readonly failWebSocket = false
    ) {
        super();
    }

    private rewriteUrl(originalUrl: string): string {
        const parsed = new URL(originalUrl);
        const upstream = new URL(this.upstreamUrl);
        parsed.protocol = upstream.protocol;
        parsed.host = upstream.host;
        return parsed.toString();
    }

    private rewriteWsUrl(originalUrl: string): string {
        const parsed = new URL(originalUrl);
        const upstream = new URL(this.upstreamUrl);
        // The upstream URL is http(s); flip to ws(s) for the WS open.
        parsed.protocol = upstream.protocol === "https:" ? "wss:" : "ws:";
        parsed.host = upstream.host;
        return parsed.toString();
    }

    protected override async sendRequest(
        request: Request,
        _ctx: CopilotRequestContext
    ): Promise<Response> {
        this.counters.httpRequests++;
        const rewritten = this.rewriteUrl(request.url);
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set("x-test-mutated", "1");
        const rewrittenRequest = new Request(rewritten, {
            method: request.method,
            headers: requestHeaders,
            body: request.body,
            // @ts-expect-error duplex is required by undici when streaming a body
            duplex: "half",
        });
        const response = await fetch(rewrittenRequest, { signal: _ctx.signal });
        this.counters.httpResponses++;
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("x-test-response-mutated", "1");
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });
    }

    protected override async openWebSocket(
        ctx: CopilotRequestContext
    ): Promise<CopilotWebSocketForwarder> {
        if (this.failWebSocket) {
            throw new Error("Synthetic WebSocket handshake refused");
        }
        ctx.url = this.rewriteWsUrl(ctx.url);
        return new CountingSocketForwarder(ctx, this.counters);
    }
}

class CountingSocketForwarder extends CopilotWebSocketForwarder {
    constructor(
        ctx: CopilotRequestContext,
        private readonly counters: Counters
    ) {
        super(ctx);
    }

    override sendRequestMessage(data: string | Uint8Array): void {
        this.counters.wsRequestMessages++;
        super.sendRequestMessage(data);
    }

    override async sendResponseMessage(data: string | Uint8Array): Promise<void> {
        this.counters.wsResponseMessages++;
        await super.sendResponseMessage(data);
    }
}

describe("CopilotRequestHandler — single subclass handles HTTP + WebSocket", async () => {
    const upstream = await startFakeUpstream();
    const counters: Counters = {
        httpRequests: 0,
        httpResponses: 0,
        wsRequestMessages: 0,
        wsResponseMessages: 0,
    };

    const {
        copilotClient: client,
        env,
        workDir,
    } = await createSdkTestContext({
        copilotClientOptions: {
            requestHandler: new TestHandler(upstream.url, counters),
        },
    });

    // Enable the WebSocket Responses transport in the spawned runtime so
    // the main agent turn picks the WS path; single-shot calls (title
    // generation) still go over HTTP through the same subclass.
    env.COPILOT_EXP_COPILOT_CLI_WEBSOCKET_RESPONSES = "true";

    afterAll(async () => {
        await upstream.close();
    });

    it("services both an HTTP turn and a WebSocket turn end-to-end via one handler", async () => {
        await client.start();
        const session = await client.createSession({ onPermissionRequest: approveAll });
        let resultJson = "";
        try {
            const result = await session.sendAndWait({ prompt: "Say OK." });
            resultJson = JSON.stringify(result);
        } finally {
            await session.disconnect();
        }

        // The HTTP hooks fired — the runtime issued model-layer GETs
        // (catalog, policy) and possibly a single-shot inference.
        expect(counters.httpRequests, "expected sendRequest to fire").toBeGreaterThan(0);
        expect(
            counters.httpResponses,
            "expected sendRequest response mutation to fire"
        ).toBeGreaterThan(0);

        // The WebSocket hooks fired — the main agent turn went over
        // the WS path and we observed messages in both directions.
        expect(
            counters.wsRequestMessages,
            "expected sendRequestMessage (runtime → upstream) to fire"
        ).toBeGreaterThan(0);
        expect(
            counters.wsResponseMessages,
            "expected sendResponseMessage (upstream → runtime) to fire"
        ).toBeGreaterThan(0);
        expect(
            upstream.wsRequestCount(),
            "expected upstream WS to receive request messages"
        ).toBeGreaterThan(0);

        // The synthetic content from the upstream surfaced in the
        // assistant turn — proves the full chain (runtime → handler
        // → upstream → handler → runtime) is intact for the
        // transport the main agent turn used.
        // Validate the final assistant response arrived (guards against truncated captures)
        expect(resultJson).toMatch(/OK from synthetic (HTTP|WS) upstream/);
    }, 90_000);

    it("applies SDK tool additions at the WebSocket boundary without a stale continuation", async () => {
        const original = {
            name: "sdk_epoch_original",
            description: "Original SDK tool",
            parameters: { type: "object", properties: {} },
            defer: "never",
        } as const;
        const added = {
            name: "sdk_epoch_added",
            description: "Added SDK tool",
            parameters: { type: "object", properties: {} },
            defer: "never",
        } as const;
        let addedToolCalls = 0;
        await client.start();
        const beforeRequests = upstream.wsBodies().length;
        const session = await client.createSession({
            model: "gpt-6-sol",
            onPermissionRequest: approveAll,
            capi: { enableWebSocketResponses: true },
            toolSearch: { enabled: false },
            tools: [
                defineTool(original.name, {
                    description: original.description,
                    handler: () => "ORIGINAL_TOOL_RESULT",
                }),
                defineTool(added.name, {
                    description: added.description,
                    handler: () => {
                        addedToolCalls++;
                        return "SDK_ADDED_TOOL_RESULT";
                    },
                }),
            ],
        });
        try {
            await session.rpc.tools.initializeAndValidate();
            await session.rpc.tools.set({ tools: [original] });
            const first = await session.sendAndWait({ prompt: "SDK_RESPONSES_FIRST" });
            expect(first?.data.content).toContain(WS_TEXT);

            await session.rpc.tools.set({ tools: [original, added] });
            const second = await session.sendAndWait({
                prompt: "SDK_RESPONSES_AFTER: use sdk_epoch_added now.",
            });
            // Validate the final assistant response arrived (guards against truncated captures)
            expect(second?.data.content).toContain("SDK_RESPONSES_TOOL_OK");
            expect(addedToolCalls).toBe(1);

            const requests = upstream.wsBodies().slice(beforeRequests);
            expect(requests).toHaveLength(3);
            const [before, update, afterTool] = requests;
            expect(update.tools).toEqual(before.tools);
            expect(update.previous_response_id ?? null).toBeNull();
            const input = update.input as Array<Record<string, unknown>>;
            expect(input).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "additional_tools",
                        tools: expect.arrayContaining([
                            expect.objectContaining({ name: added.name }),
                        ]),
                    }),
                ])
            );
            const additionIndex = input.findIndex((item) => item.type === "additional_tools");
            expect(additionIndex).toBeGreaterThan(0);
            expect(JSON.stringify(input.slice(0, additionIndex))).toContain("SDK_RESPONSES_AFTER");
            expect(JSON.stringify(input.slice(additionIndex + 1))).not.toContain(
                "SDK_RESPONSES_AFTER"
            );
            expect(JSON.stringify(afterTool.input)).toContain("SDK_ADDED_TOOL_RESULT");
        } finally {
            await session.disconnect();
        }
    }, 90_000);

    const routes: Array<{
        name: string;
        config: Partial<SessionConfig>;
        bodies: () => Array<Record<string, unknown>>;
        firstText: string;
    }> = [
        {
            name: "CAPI WebSocket",
            config: { capi: { enableWebSocketResponses: true } },
            bodies: upstream.wsBodies,
            firstText: WS_TEXT,
        },
        {
            name: "CAPI HTTP",
            config: { capi: { enableWebSocketResponses: false } },
            bodies: upstream.httpBodies,
            firstText: HTTP_TEXT,
        },
        ...(["http", "websockets"] as const).map((transport) => ({
            name: `BYOK ${transport}`,
            config: {
                provider: {
                    type: "openai" as const,
                    wireApi: "responses" as const,
                    transport,
                    baseUrl: upstream.url,
                    apiKey: "synthetic-provider-key",
                    modelId: "gpt-6-sol",
                    wireModel: "gpt-6-sol",
                },
            },
            bodies: transport === "http" ? upstream.httpBodies : upstream.wsBodies,
            firstText: transport === "http" ? HTTP_TEXT : WS_TEXT,
        })),
    ];
    for (const route of routes) {
        describe(route.name, async () => {
            const routeClient =
                route.config.capi?.enableWebSocketResponses === false
                    ? (
                          await createSdkTestContext({
                              copilotClientOptions: {
                                  requestHandler: new TestHandler(upstream.url, counters),
                                  // This runtime does not yet wire the session-level CAPI transport opt-out.
                                  env: { COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES: "true" },
                              },
                          })
                      ).copilotClient
                    : client;
            it(`${route.config.provider ? "sends current tools" : "preserves the prefix"} on ${route.name} and executes a tool from a newly enabled MCP server`, async () => {
                const config = mcpTestServerConfig("MCP_ADDED_TOOL_RESULT");
                await routeClient.start();
                const beforeRequests = route.bodies().length;
                const session = await routeClient.createSession({
                    model: "gpt-6-sol",
                    onPermissionRequest: approveAll,
                    ...route.config,
                    toolSearch: { enabled: false },
                    mcpServers: { z_server: config, a_server: config },
                    disabledMcpServers: ["a_server"],
                });
                try {
                    await session.rpc.tools.initializeAndValidate();
                    expect(
                        (await session.rpc.tools.getCurrentMetadata()).tools.map(
                            (tool) => tool.name
                        )
                    ).toContain("z_server-get_env");
                    expect(
                        (await session.rpc.tools.getCurrentMetadata()).tools.map(
                            (tool) => tool.name
                        )
                    ).not.toContain("a_server-get_env");
                    const first = await session.sendAndWait({ prompt: "MCP_RESPONSES_FIRST" });
                    expect(first?.data.content).toContain(route.firstText);

                    await session.rpc.mcp.setEnvValueMode({ mode: "direct" });
                    await session.rpc.mcp.enable({ serverName: "a_server" });
                    await session.rpc.tools.initializeAndValidate();
                    expect(
                        (await session.rpc.tools.getCurrentMetadata()).tools.map(
                            (tool) => tool.name
                        )
                    ).toContain("a_server-get_env");
                    const second = await session.sendAndWait({
                        prompt: "MCP_RESPONSES_AFTER: call a_server-get_env.",
                    });
                    expect(second?.data.content).toContain("MCP_RESPONSES_TOOL_OK");

                    const requests = route.bodies().slice(beforeRequests);
                    expect(requests).toHaveLength(3);
                    const [before, update, afterTool] = requests;
                    expect(before.tools).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ name: "z_server-get_env" }),
                        ])
                    );
                    expect(JSON.stringify(before.tools)).not.toContain('"name":"a_server-get_env"');
                    for (const request of [update, afterTool]) {
                        if (route.config.provider) {
                            expect(request.tools).toEqual(
                                expect.arrayContaining([
                                    expect.objectContaining({ name: "a_server-get_env" }),
                                    expect.objectContaining({ name: "z_server-get_env" }),
                                ])
                            );
                            expect(request.tools).toEqual(update.tools);
                        } else {
                            expect(JSON.stringify(request.tools)).toBe(
                                JSON.stringify(before.tools)
                            );
                        }
                        expect(request.instructions).toEqual(before.instructions);
                    }
                    expect(update.previous_response_id ?? null).toBeNull();
                    const input = update.input as Array<Record<string, unknown>>;
                    expect(JSON.stringify(input[0])).toBe(
                        JSON.stringify((before.input as Array<Record<string, unknown>>)[0])
                    );
                    if (route.config.provider) {
                        expect(JSON.stringify(input)).not.toContain('"type":"additional_tools"');
                    } else {
                        expect(input).toContainEqual(
                            expect.objectContaining({
                                type: "additional_tools",
                                tools: expect.arrayContaining([
                                    expect.objectContaining({ name: "a_server-get_env" }),
                                ]),
                            })
                        );
                        const additionIndex = input.findIndex(
                            (item) => item.type === "additional_tools"
                        );
                        expect(additionIndex).toBeGreaterThan(0);
                        expect(JSON.stringify(input.slice(0, additionIndex))).toContain(
                            "MCP_RESPONSES_AFTER"
                        );
                    }
                    expect(JSON.stringify(afterTool.input)).toContain("MCP_ADDED_TOOL_RESULT");
                } finally {
                    await session.disconnect();
                }
            }, 90_000);

            it(`removes MCP tools on ${route.name} and executes a restored tool`, async () => {
                const toolName = "a_server-get_env";
                const survivor = "z_server-get_env";
                const config = mcpTestServerConfig("MCP_ADDED_TOOL_RESULT");
                await client.start();
                const beforeRequests = route.bodies().length;
                const session = await routeClient.createSession({
                    model: "gpt-6-sol",
                    onPermissionRequest: approveAll,
                    ...route.config,
                    toolSearch: { enabled: false },
                    availableTools: [toolName, survivor],
                    mcpServers: { a_server: config, z_server: config },
                });
                try {
                    await session.rpc.mcp.setEnvValueMode({ mode: "direct" });
                    await session.rpc.tools.initializeAndValidate();
                    expect(
                        (await session.rpc.tools.getCurrentMetadata()).tools.map(
                            (tool) => tool.name
                        )
                    ).toEqual(expect.arrayContaining([toolName, survivor]));
                    expect(
                        (await session.sendAndWait({ prompt: "MCP_RESPONSES_FIRST" }))?.data.content
                    ).toContain(route.firstText);

                    await session.rpc.mcp.disable({ serverName: "a_server" });
                    await session.rpc.tools.initializeAndValidate();
                    // Tool metadata includes the previous request; the host reports live availability.
                    const disabled = await session.rpc.mcp.list();
                    expect(disabled.host?.disabledServers).toContain("a_server");
                    expect(disabled.host?.disabledServers).not.toContain("z_server");
                    expect(disabled.servers).toContainEqual(
                        expect.objectContaining({ name: "a_server", status: "disabled" })
                    );
                    expect(
                        (await session.sendAndWait({ prompt: "MCP_RESPONSES_REMOVED" }))?.data
                            .content
                    ).toContain(route.firstText);

                    await session.rpc.mcp.enable({ serverName: "a_server" });
                    await session.rpc.tools.initializeAndValidate();
                    expect(
                        (await session.rpc.tools.getCurrentMetadata()).tools.map(
                            (tool) => tool.name
                        )
                    ).toContain(toolName);
                    expect(
                        (
                            await session.sendAndWait({
                                prompt: `MCP_RESPONSES_AFTER: call ${toolName}.`,
                            })
                        )?.data.content
                    ).toContain("MCP_RESPONSES_TOOL_OK");

                    await session.rpc.mcp.disable({ serverName: "a_server" });
                    await session.rpc.tools.initializeAndValidate();
                    const disabledAgain = await session.rpc.mcp.list();
                    expect(disabledAgain.host?.disabledServers).toContain("a_server");
                    expect(disabledAgain.host?.disabledServers).not.toContain("z_server");
                    expect(disabledAgain.servers).toContainEqual(
                        expect.objectContaining({ name: "a_server", status: "disabled" })
                    );
                    expect(
                        (await session.sendAndWait({ prompt: "MCP_RESPONSES_REMOVED_AGAIN" }))?.data
                            .content
                    ).toContain("MCP_RESPONSES_REMOVED_OK");

                    const requests = route.bodies().slice(beforeRequests);
                    expect(requests).toHaveLength(5);
                    const [before, removed, restored, afterTool, removedAgain] = requests;
                    expect(before.tools).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ name: toolName }),
                            expect.objectContaining({ name: survivor }),
                        ])
                    );
                    for (const request of [removed, restored, afterTool, removedAgain]) {
                        expect(request.instructions).toEqual(before.instructions);
                        expect(JSON.stringify(request.input)).not.toContain(
                            '"type":"additional_tools"'
                        );
                    }
                    const choice = {
                        type: "allowed_tools",
                        mode: "auto",
                        tools: [{ type: "function", name: survivor }],
                    };
                    for (const request of [removed, removedAgain]) {
                        if (route.config.provider) {
                            expect(request.tools).toEqual(
                                (before.tools as Array<Record<string, unknown>>).filter(
                                    (tool) => tool.name !== toolName
                                )
                            );
                            expect(request.tool_choice).not.toEqual(
                                expect.objectContaining({ type: "allowed_tools" })
                            );
                        } else {
                            expect(JSON.stringify(request.tools)).toBe(
                                JSON.stringify(before.tools)
                            );
                            expect(request.tool_choice).toEqual(choice);
                        }
                        expect(request.previous_response_id ?? null).toBeNull();
                    }
                    for (const request of [restored, afterTool]) {
                        expect(JSON.stringify(request.tools)).toBe(JSON.stringify(before.tools));
                        expect(request.tool_choice).not.toEqual(
                            expect.objectContaining({ type: "allowed_tools" })
                        );
                    }
                    expect(restored.previous_response_id ?? null).toBeNull();
                    expect(JSON.stringify(afterTool.input)).toContain("MCP_ADDED_TOOL_RESULT");
                } finally {
                    await session.disconnect();
                }
            }, 90_000);
        });
    }

    for (const byok of [false, true]) {
        it(`preserves ${byok ? "BYOK" : "CAPI"} Chat Completions tools through removal and restores real execution`, async () => {
            const original = {
                name: "sdk_chat_original",
                description: "Original",
                parameters: { type: "object", properties: {} },
                defer: "never",
            } as const;
            const removable = { ...original, name: "sdk_chat_removed", description: "Removable" };
            let calls = 0;
            const start = upstream.chatBodies().length;
            const session = await client.createSession({
                model: "gpt-5.5",
                ...(byok
                    ? {
                          provider: {
                              type: "openai" as const,
                              wireApi: "completions" as const,
                              baseUrl: upstream.url,
                              apiKey: "synthetic-provider-key",
                              modelId: "gpt-5.5",
                              wireModel: "gpt-5.5",
                          },
                      }
                    : {}),
                toolSearch: { enabled: false },
                onPermissionRequest: approveAll,
                availableTools: [original.name, removable.name],
                tools: [
                    defineTool(original.name, {
                        description: original.description,
                        handler: () => "SDK_CHAT_ORIGINAL_RESULT",
                    }),
                    defineTool(removable.name, {
                        description: removable.description,
                        handler: () => {
                            calls++;
                            return "SDK_CHAT_EXECUTED_RESULT";
                        },
                    }),
                ],
            });
            try {
                await session.rpc.tools.initializeAndValidate();
                expect(
                    (await session.sendAndWait({ prompt: "SDK_CHAT_FIRST" }))?.data.content
                ).toContain("SDK_CHAT_FIRST_OK");
                await session.rpc.tools.set({ tools: [original] });
                expect(
                    (await session.sendAndWait({ prompt: "SDK_CHAT_REMOVED" }))?.data.content
                ).toContain("SDK_CHAT_REMOVED_OK");
                expect(calls).toBe(0);
                const removedRequests = upstream.chatBodies().slice(start);
                expect(removedRequests).toHaveLength(3);
                const [before, removed, afterRejectedCall] = removedRequests;
                expect(JSON.stringify(removed.tools)).toBe(JSON.stringify(before.tools));
                expect(removed.tool_choice).toEqual({
                    type: "allowed_tools",
                    allowed_tools: {
                        mode: "auto",
                        tools: [{ type: "function", function: { name: original.name } }],
                    },
                });
                expect(JSON.stringify(afterRejectedCall.messages)).toContain("does not exist");
                await session.rpc.tools.set({ tools: [original, removable] });
                expect(
                    (await session.sendAndWait({ prompt: "SDK_CHAT_RESTORED" }))?.data.content
                ).toContain("SDK_CHAT_RESTORED_OK");
                expect(calls).toBe(1);
                const requests = upstream.chatBodies().slice(start);
                expect(requests).toHaveLength(5);
                for (const request of requests.slice(3)) {
                    expect(JSON.stringify(request.tools)).toBe(JSON.stringify(before.tools));
                    expect(request.tool_choice).not.toEqual(
                        expect.objectContaining({ type: "allowed_tools" })
                    );
                }
                expect(JSON.stringify(requests[4].messages)).toContain("SDK_CHAT_EXECUTED_RESULT");
            } finally {
                await session.disconnect();
            }
        });
    }

    describe("WebSocket to HTTP tool-update fallback", async () => {
        const { copilotClient: fallbackClient } = await createSdkTestContext({
            copilotClientOptions: { requestHandler: new TestHandler(upstream.url, counters, true) },
        });
        it("recovers an unrecognized HTTP 422 once and keeps later turns on current tools", async () => {
            const original = {
                name: "sdk_epoch_original",
                description: "Original",
                parameters: { type: "object", properties: {} },
                defer: "never",
            } as const;
            const added = { ...original, name: "sdk_epoch_added", description: "Added" };
            const start = upstream.httpBodies().length;
            const session = await fallbackClient.createSession({
                model: "gpt-6-sol",
                capi: { enableWebSocketResponses: true },
                toolSearch: { enabled: false },
                onPermissionRequest: approveAll,
                tools: [
                    defineTool(original.name, { handler: () => "original" }),
                    defineTool(added.name, { handler: () => "added" }),
                ],
            });
            try {
                await session.rpc.tools.initializeAndValidate();
                await session.rpc.tools.set({ tools: [original] });
                expect(
                    (await session.sendAndWait({ prompt: "SDK_RESPONSES_FIRST" }))?.data.content
                ).toContain(HTTP_TEXT);
                await session.rpc.tools.set({ tools: [original, added] });
                expect(
                    (await session.sendAndWait({ prompt: "SDK_RESPONSES_REJECT_GENERIC" }))?.data
                        .content
                ).toContain(HTTP_TEXT);
                expect(
                    (await session.sendAndWait({ prompt: "SDK_RESPONSES_LEGACY_FOLLOW_UP" }))?.data
                        .content
                ).toContain("SDK_RESPONSES_LEGACY_OK");
                const requests = upstream.httpBodies().slice(start);
                expect(requests).toHaveLength(4);
                const [before, rejected, recovered, later] = requests;
                expect(JSON.stringify(rejected.tools)).toBe(JSON.stringify(before.tools));
                expect(JSON.stringify(rejected.input)).toContain('"type":"additional_tools"');
                for (const request of [recovered, later]) {
                    expect(JSON.stringify(request.input)).not.toContain(
                        '"type":"additional_tools"'
                    );
                    expect(request.tools).toEqual(
                        expect.arrayContaining([expect.objectContaining({ name: added.name })])
                    );
                }
            } finally {
                await session.disconnect();
            }
        });
    });

    it("rebases a refreshed MCP definition before executing the restarted server", async () => {
        const toolName = "a_server-get_env";
        const descriptionFile = join(workDir, "tool-description.txt");
        await writeFile(descriptionFile, "MCP_ORIGINAL_DESCRIPTION");
        await client.start();
        const beforeRequests = upstream.wsBodies().length;
        const session = await client.createSession({
            model: "gpt-6-sol",
            onPermissionRequest: approveAll,
            capi: { enableWebSocketResponses: true },
            toolSearch: { enabled: false },
            mcpServers: {
                a_server: mcpTestServerConfig("MCP_ADDED_TOOL_RESULT", descriptionFile),
            },
        });
        try {
            await session.rpc.mcp.setEnvValueMode({ mode: "direct" });
            await session.rpc.tools.initializeAndValidate();
            expect(
                (await session.rpc.tools.getCurrentMetadata()).tools.find(
                    (tool) => tool.name === toolName
                )?.description
            ).toContain("MCP_ORIGINAL_DESCRIPTION");
            expect(
                (await session.sendAndWait({ prompt: "MCP_RESPONSES_FIRST" }))?.data.content
            ).toContain(WS_TEXT);

            await writeFile(descriptionFile, "MCP_REPLACEMENT_DESCRIPTION");
            await session.rpc.mcp.restartServer({ serverName: "a_server" });
            await session.rpc.tools.initializeAndValidate();
            expect(
                (await session.rpc.tools.getCurrentMetadata()).tools.find(
                    (tool) => tool.name === toolName
                )?.description
            ).toContain("MCP_REPLACEMENT_DESCRIPTION");
            expect(
                (await session.sendAndWait({ prompt: `MCP_RESPONSES_AFTER: call ${toolName}.` }))
                    ?.data.content
            ).toContain("MCP_RESPONSES_TOOL_OK");

            const requests = upstream.wsBodies().slice(beforeRequests);
            expect(requests).toHaveLength(3);
            const [before, update, afterTool] = requests;
            expect(JSON.stringify(before.tools)).toContain("MCP_ORIGINAL_DESCRIPTION");
            expect(JSON.stringify(update.tools)).toContain("MCP_REPLACEMENT_DESCRIPTION");
            expect(JSON.stringify(update.tools)).not.toContain("MCP_ORIGINAL_DESCRIPTION");
            expect(update.instructions).toEqual(before.instructions);
            expect(update.previous_response_id ?? null).toBeNull();
            for (const request of [update, afterTool]) {
                expect(JSON.stringify(request.input)).not.toContain('"type":"additional_tools"');
            }
            expect(JSON.stringify(afterTool.tools)).toBe(JSON.stringify(update.tools));
            expect(JSON.stringify(afterTool.input)).toContain("MCP_ADDED_TOOL_RESULT");
        } finally {
            await session.disconnect();
        }
    }, 90_000);

    it("keeps the SDK removal prefix while restricting tools across continuations and restoration", async () => {
        const original = {
            name: "sdk_epoch_original",
            description: "Original SDK tool",
            parameters: { type: "object", properties: {} },
            defer: "never",
        } as const;
        const added = {
            ...original,
            name: "sdk_epoch_added",
            description: "Added SDK tool",
        } as const;
        let survivorCalls = 0;
        await client.start();
        const beforeRequests = upstream.wsBodies().length;
        const session = await client.createSession({
            model: "gpt-6-sol",
            onPermissionRequest: approveAll,
            capi: { enableWebSocketResponses: true },
            toolSearch: { enabled: false },
            availableTools: [original.name, added.name],
            tools: [
                defineTool(original.name, {
                    description: original.description,
                    handler: () => {
                        throw new Error("Removed SDK tool was executed");
                    },
                }),
                defineTool(added.name, {
                    description: added.description,
                    handler: () => {
                        survivorCalls++;
                        return "SDK_ADDED_TOOL_RESULT";
                    },
                }),
            ],
        });
        try {
            await session.rpc.tools.initializeAndValidate();
            await session.rpc.tools.set({ tools: [original, added] });
            expect(
                (await session.sendAndWait({ prompt: "SDK_REMOVAL_FIRST" }))?.data.content
            ).toContain(WS_TEXT);
            await session.rpc.tools.set({ tools: [added] });
            const used = await session.sendAndWait({
                prompt: "SDK_RESPONSES_AFTER: use sdk_epoch_added now.",
            });
            expect(used?.data.content).toContain("SDK_RESPONSES_TOOL_OK");
            expect(survivorCalls).toBe(1);
            let requests = upstream.wsBodies().slice(beforeRequests);
            expect(requests).toHaveLength(3);
            const [before, removed, afterTool] = requests;
            const choice = {
                type: "allowed_tools",
                mode: "auto",
                tools: [{ type: "function", name: added.name }],
            };
            expect(removed.tools).toEqual(before.tools);
            expect(removed.instructions).toEqual(before.instructions);
            expect(removed.tool_choice).toEqual(choice);
            expect(afterTool.tool_choice).toEqual(choice);
            expect(removed.previous_response_id ?? null).toBeNull();
            expect(JSON.stringify(removed.input)).toContain("SDK_REMOVAL_FIRST");

            await session.rpc.tools.set({ tools: [] });
            expect(
                (await session.sendAndWait({ prompt: "SDK_REMOVAL_ALL" }))?.data.content
            ).toContain(HTTP_TEXT);
            // No remaining tools selects HTTP, which keeps the prefix and forbids all calls.
            const allRemoved = upstream
                .httpBodies()
                .findLast((body) => JSON.stringify(body.input).includes("SDK_REMOVAL_ALL"))!;
            expect(JSON.stringify(allRemoved.tools)).toBe(JSON.stringify(before.tools));
            expect(allRemoved.tool_choice).toBe("none");
            expect(allRemoved.previous_response_id ?? null).toBeNull();

            await session.rpc.tools.set({ tools: [original, added] });
            const restored = await session.sendAndWait({ prompt: "SDK_REMOVAL_RESTORED" });
            // Validate the final assistant response arrived (guards against truncated captures)
            expect(restored?.data.content).toContain("SDK_REMOVAL_RESTORED_OK");
            requests = upstream.wsBodies().slice(beforeRequests);
            const last = requests.at(-1)!;
            expect(last.tools).toEqual(before.tools);
            expect(last.tool_choice).not.toEqual(
                expect.objectContaining({ type: "allowed_tools" })
            );
            expect(last.previous_response_id ?? null).toBeNull();
            expect(JSON.stringify(last.input)).not.toContain('"type":"additional_tools"');
        } finally {
            await session.disconnect();
        }
    }, 90_000);

    for (const phase of ["BEFORE", "AFTER"] as const) {
        it(`only replays a rejected SDK tool allowlist ${phase.toLowerCase()} output`, async () => {
            const original = {
                name: "sdk_epoch_original",
                description: "Original SDK tool",
                parameters: { type: "object", properties: {} },
                defer: "never",
            } as const;
            const added = {
                ...original,
                name: "sdk_epoch_added",
                description: "Added SDK tool",
            } as const;
            await client.start();
            const beforeRequests = upstream.wsBodies().length;
            const session = await client.createSession({
                model: "gpt-6-sol",
                onPermissionRequest: approveAll,
                capi: { enableWebSocketResponses: true },
                toolSearch: { enabled: false },
                availableTools: [original.name, added.name],
                tools: [original, added].map((tool) =>
                    defineTool(tool.name, {
                        description: tool.description,
                        handler: () => "UNUSED",
                    })
                ),
            });
            let failedTurnIdle = false;
            const unsubscribe = session.on((event) => {
                if (event.type === "session.idle" && !event.agentId) {
                    failedTurnIdle = true;
                }
            });
            try {
                await session.rpc.tools.initializeAndValidate();
                await session.rpc.tools.set({ tools: [original, added] });
                expect(
                    (await session.sendAndWait({ prompt: "SDK_ALLOWLIST_FIRST" }))?.data.content
                ).toContain(WS_TEXT);
                failedTurnIdle = false;
                await session.rpc.tools.set({ tools: [added] });
                const changed = session.sendAndWait({ prompt: `SDK_ALLOWLIST_REJECT_${phase}` });
                if (phase === "BEFORE") {
                    expect((await changed)?.data.content).toContain("SDK_ALLOWLIST_RECOVERED");
                } else {
                    await expect(changed).rejects.toThrow(/allowed_tools rejected/);
                    await waitForCondition(() => failedTurnIdle, {
                        timeoutMessage: "Rejected SDK allowlist did not reach session.idle",
                    });
                }
                const requests = upstream.wsBodies().slice(beforeRequests);
                expect(requests).toHaveLength(phase === "BEFORE" ? 3 : 2);
                expect(requests[1].tools).toEqual(requests[0].tools);
                expect(requests[1].tool_choice).toMatchObject({ type: "allowed_tools" });
                expect(requests[1].previous_response_id ?? null).toBeNull();
                if (phase === "BEFORE") {
                    expect(requests[2].tool_choice).not.toEqual(
                        expect.objectContaining({ type: "allowed_tools" })
                    );
                    expect(JSON.stringify(requests[2].tools)).not.toContain(original.name);
                    expect(requests[2].previous_response_id ?? null).toBeNull();
                }
                const followUp = await session.sendAndWait({
                    prompt: "SDK_RESPONSES_LEGACY_FOLLOW_UP",
                });
                // Validate the final assistant response arrived (guards against truncated captures)
                expect(followUp?.data.content).toContain("SDK_RESPONSES_LEGACY_OK");
                const last = upstream.wsBodies().at(-1)!;
                expect(last.tool_choice).not.toEqual(
                    expect.objectContaining({ type: "allowed_tools" })
                );
                expect(JSON.stringify(last.tools)).not.toContain(original.name);
            } finally {
                unsubscribe();
                await session.disconnect();
            }
        }, 90_000);
    }

    for (const phase of ["BEFORE", "AFTER"] as const) {
        it(`only replays a rejected SDK WebSocket tool update ${phase.toLowerCase()} output`, async () => {
            const original = {
                name: "sdk_epoch_original",
                description: "Original SDK tool",
                parameters: { type: "object", properties: {} },
                defer: "never",
            } as const;
            const added = {
                name: "sdk_epoch_added",
                description: "Added SDK tool",
                parameters: { type: "object", properties: {} },
                defer: "never",
            } as const;
            await client.start();
            const beforeRequests = upstream.wsBodies().length;
            const session = await client.createSession({
                model: "gpt-6-sol",
                onPermissionRequest: approveAll,
                capi: { enableWebSocketResponses: true },
                toolSearch: { enabled: false },
                tools: [
                    defineTool(original.name, {
                        description: original.description,
                        handler: () => "ORIGINAL_TOOL_RESULT",
                    }),
                    defineTool(added.name, {
                        description: added.description,
                        handler: () => "SDK_ADDED_TOOL_RESULT",
                    }),
                ],
            });
            let failedTurnIdle = false;
            const unsubscribe = session.on((event) => {
                if (event.type === "session.idle" && !event.agentId) {
                    failedTurnIdle = true;
                }
            });
            try {
                await session.rpc.tools.initializeAndValidate();
                await session.rpc.tools.set({ tools: [original] });
                const first = await session.sendAndWait({ prompt: "SDK_RESPONSES_FIRST" });
                expect(first?.data.content).toContain(WS_TEXT);
                failedTurnIdle = false;

                await session.rpc.tools.set({ tools: [original, added] });
                const changedTurn = session.sendAndWait({
                    prompt: `SDK_RESPONSES_REJECT_${phase}: use sdk_epoch_added now.`,
                });
                if (phase === "BEFORE") {
                    const recovered = await changedTurn;
                    expect(recovered?.data.content).toContain("SDK_RESPONSES_RECOVERED");
                } else {
                    await expect(changedTurn).rejects.toThrow(/additional_tools rejected/);
                    await waitForCondition(() => failedTurnIdle, {
                        timeoutMessage: "Rejected SDK tool update did not reach session.idle",
                    });
                }

                const requests = upstream.wsBodies().slice(beforeRequests);
                expect(requests).toHaveLength(phase === "BEFORE" ? 3 : 2);
                const [before, rejected, retry] = requests;
                expect(rejected.tools).toEqual(before.tools);
                expect(rejected.previous_response_id ?? null).toBeNull();
                const positioned = (rejected.input as Array<{ type?: string }>).filter(
                    (item) => item.type === "additional_tools"
                );
                expect(positioned).toHaveLength(1);
                expect(JSON.stringify(positioned[0])).toContain(added.name);
                if (phase === "BEFORE") {
                    expect(retry?.previous_response_id ?? null).toBeNull();
                    expect(JSON.stringify(retry?.input)).not.toContain('"type":"additional_tools"');
                    expect(JSON.stringify(retry?.tools)).toContain(added.name);

                    const followUp = await session.sendAndWait({
                        prompt: "SDK_RESPONSES_LEGACY_FOLLOW_UP",
                    });
                    expect(followUp?.data.content).toContain("SDK_RESPONSES_LEGACY_OK");
                    const followUpRequest = upstream.wsBodies().at(-1);
                    expect(JSON.stringify(followUpRequest?.tools)).toEqual(
                        JSON.stringify(retry?.tools)
                    );
                    expect(JSON.stringify(followUpRequest?.input)).not.toContain(
                        '"type":"additional_tools"'
                    );
                } else {
                    const followUp = await session.sendAndWait({
                        prompt: "SDK_RESPONSES_LEGACY_FOLLOW_UP",
                    });
                    expect(followUp?.data.content).toContain("SDK_RESPONSES_LEGACY_OK");
                    const followUpRequest = upstream.wsBodies().at(-1);
                    expect(upstream.wsBodies().slice(beforeRequests)).toHaveLength(3);
                    expect(followUpRequest?.previous_response_id ?? null).toBeNull();
                    expect(JSON.stringify(followUpRequest?.tools)).toContain(added.name);
                    expect(JSON.stringify(followUpRequest?.input)).not.toContain(
                        '"type":"additional_tools"'
                    );
                }
            } finally {
                unsubscribe();
                await session.disconnect();
            }
        }, 90_000);
    }
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, onTestFailed } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    approveAll,
    CopilotRequestHandler,
    type CopilotSession,
    type GitHubTelemetryNotification,
    type SessionEvent,
} from "../../src/index.js";
import { createSdkTestContext, isCI } from "./harness/sdkTestContext.js";
import { testBackend } from "./harness/testBackend.js";
import { withTestCleanup } from "../helpers/withTestCleanup.js";

const compactionTimeoutMs = 60_000;
const uncataloguedModelTelemetryHash = createHash("sha256")
    .update("uncatalogued-budget-model")
    .digest("hex");

interface CacheWireBlock {
    text?: string;
    cache_control?: unknown;
    copilot_cache_control?: unknown;
    output_config?: { effort?: string };
}

interface CacheWireRequest extends CacheWireBlock {
    model: string;
    max_tokens: number;
    stream?: boolean;
    system?: CacheWireBlock[];
    tools?: CacheWireBlock[];
    tool_choice?: unknown;
    messages: (CacheWireBlock & { role: string; content: string | CacheWireBlock[] })[];
}

class RefusalBudgetReplayHandler extends CopilotRequestHandler {
    readonly requests: CacheWireRequest[] = [];
    readonly requestUrls: string[] = [];

    constructor(
        private readonly endpoint: "/v1/messages" | "/chat/completions" = "/v1/messages",
        private readonly fusionCritic = false
    ) {
        super();
    }

    protected override async sendRequest(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/models") {
            return Response.json({
                data: [
                    ["claude-sonnet-5.5", 250_000, 384_000, 128_000],
                    ["claude-sonnet-5", 112_000, 128_000, 64_000],
                    ...(this.fusionCritic ? [["claude-opus-5", 112_000, 128_000, 64_000]] : []),
                ].map(([id, prompt, context, output]) => ({
                    id,
                    name: id,
                    object: "model",
                    vendor: "Anthropic",
                    version: "1",
                    model_picker_enabled: true,
                    policy: { state: "enabled" },
                    supported_endpoints: [this.endpoint],
                    // Synthetic prices exercise TTL eligibility, not measured savings.
                    billing: {
                        token_prices: {
                            batch_size: 1_000_000,
                            default: {
                                input_price: 3,
                                output_price: 15,
                                cache_read_price: 0.3,
                                cache_write_price: 1,
                                cache_write_1h_price: 2,
                            },
                        },
                    },
                    capabilities: {
                        type: "chat",
                        family: id,
                        tokenizer: "o200k_base",
                        supports: { streaming: true, tool_calls: true, vision: false },
                        limits: {
                            max_prompt_tokens: prompt,
                            max_context_window_tokens: context,
                            max_output_tokens: output,
                        },
                    },
                })),
            });
        }
        if (this.fusionCritic && path === "/model/fusion") {
            return Response.json({
                fusion_mode: "hydrafusion-max",
                fusion_pattern: "critique",
                plan_version: "1",
                steps: [
                    { role: "draft", model_id: "claude-opus-5" },
                    { role: "critic", model_id: "claude-opus-5" },
                    { role: "revision", model_id: "claude-opus-5" },
                ],
                session: { token: "jwt.fake.cache-wire-fusion", expires_at: 0 },
            });
        }
        if (path.endsWith("/models/session")) return Response.json({});
        if (path.includes("/policy")) return Response.json({ state: "enabled" });
        expect(path).toBe(this.endpoint);
        const body = (await request.json()) as CacheWireRequest;
        this.requests.push(body);
        this.requestUrls.push(request.url);
        const refuses = body.model === "claude-sonnet-5.5";
        const content = refuses
            ? "PRIMARY_REFUSAL"
            : this.fusionCritic && !body.tools?.length
              ? JSON.stringify({ assessment: "approve", feedback: "" })
              : "FALLBACK_BUDGET_OK";
        const compaction =
            Boolean(body.tools?.length) &&
            (body.tool_choice === "none" ||
                (typeof body.tool_choice === "object" &&
                    body.tool_choice !== null &&
                    "type" in body.tool_choice &&
                    body.tool_choice.type === "none"));
        // Model a warm tools/system prefix; this is accounting coverage, not a measured hit.
        const cacheReadTokens = compaction ? 50 : 0;
        if (this.endpoint === "/chat/completions") {
            const usage = {
                prompt_tokens: 100 + cacheReadTokens,
                completion_tokens: 10,
                total_tokens: 110 + cacheReadTokens,
                prompt_tokens_details: {
                    cached_tokens: cacheReadTokens,
                    cache_creation_tokens: 0,
                },
            };
            const choice = {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
            };
            if (!body.stream) {
                return Response.json({
                    id: "cache-wire-replay",
                    object: "chat.completion",
                    model: body.model,
                    choices: [choice],
                    usage,
                });
            }
            const chunk = {
                id: "cache-wire-replay",
                object: "chat.completion.chunk",
                model: body.model,
                choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
                usage,
            };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
                headers: { "content-type": "text/event-stream" },
            });
        }
        const message = {
            id: "refusal-budget-replay",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: content }],
            stop_reason: refuses ? "refusal" : "end_turn",
            stop_sequence: null,
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: cacheReadTokens,
                cache_creation_input_tokens: 0,
            },
        };
        if (!body.stream) return Response.json(message);
        const events = [
            {
                type: "message_start",
                message: { ...message, content: [], stop_reason: null },
            },
            {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: content },
            },
            { type: "content_block_stop", index: 0 },
            {
                type: "message_delta",
                delta: { stop_reason: message.stop_reason, stop_sequence: null },
                usage: { output_tokens: 10 },
            },
            { type: "message_stop" },
        ];
        return new Response(
            events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            { headers: { "content-type": "text/event-stream" } }
        );
    }
}

class CompactionRedispatchFailureHandler extends RefusalBudgetReplayHandler {
    readonly compactionModels: string[] = [];

    protected override async sendRequest(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path !== "/v1/messages") {
            return super.sendRequest(request);
        }

        const body = (await request.json()) as CacheWireRequest;
        this.requests.push(body);
        this.requestUrls.push(request.url);
        const compaction =
            Boolean(body.tools?.length) &&
            typeof body.tool_choice === "object" &&
            body.tool_choice !== null &&
            "type" in body.tool_choice &&
            body.tool_choice.type === "none";
        if (!compaction) {
            return this.message(body, "FOREGROUND_REDISPATCH_OK", "end_turn");
        }

        this.compactionModels.push(body.model);
        if (this.compactionModels.length === 1) {
            return this.message(body, "PARTIAL_COMPACTION_SUMMARY", "max_tokens");
        }
        if (this.compactionModels.length === 2) {
            return this.message(body, "PRIMARY_COMPACTION_REFUSAL", "refusal");
        }

        expect(this.compactionModels).toHaveLength(3);
        expect(body.model).toBe("claude-sonnet-5");
        return Response.json(
            {
                error: {
                    code: "invalid_request",
                    message: "Controlled fallback compaction rejection",
                },
            },
            { status: 400 }
        );
    }

    private message(request: CacheWireRequest, content: string, stopReason: string): Response {
        const message = {
            id: "compaction-redispatch-replay",
            type: "message",
            role: "assistant",
            model: request.model,
            content: [{ type: "text", text: content }],
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
        };
        if (!request.stream) return Response.json(message);
        const events = [
            {
                type: "message_start",
                message: { ...message, content: [], stop_reason: null },
            },
            {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: content },
            },
            { type: "content_block_stop", index: 0 },
            {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: 10 },
            },
            { type: "message_stop" },
        ];
        return new Response(
            events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            { headers: { "content-type": "text/event-stream" } }
        );
    }
}

function expectNoConversationCacheMarkers(request: CacheWireRequest): void {
    expect(request.cache_control).toBeUndefined();
    expect(Boolean(request.copilot_cache_control)).toBe(false);
    for (const message of request.messages.filter(({ role }) => role !== "system")) {
        expect(Boolean(message.copilot_cache_control)).toBe(false);
        if (typeof message.content !== "string") {
            for (const block of message.content) {
                expect(block.cache_control).toBeUndefined();
            }
        }
    }
}

function systemCacheMarkers(request: CacheWireRequest): unknown[] {
    return [
        ...(request.system ?? []).map(({ cache_control }) => cache_control),
        ...request.messages
            .filter(({ role }) => role === "system")
            .map(({ copilot_cache_control }) => copilot_cache_control),
    ].filter(Boolean);
}

for (const oneHour of [false, true]) {
    describe.each(["CAPI Messages", "CAPI Chat", "BYOK Messages"] as const)(
        `Disposable Anthropic prompt caching (one-hour ${oneHour}, %s)`,
        async (route) => {
            const { createClient } = await createSdkTestContext({
                replayOnly: true,
                logLevel: "debug",
            });

            it(`keeps reusable prefixes but not disposable writes on ${route}`, async () => {
                const handler = new RefusalBudgetReplayHandler(
                    route === "CAPI Chat" ? "/chat/completions" : "/v1/messages"
                );
                const cacheClient = createClient({ requestHandler: handler });
                let phase = "create session";
                const events: string[] = [];
                onTestFailed(() => {
                    console.error(
                        `[cache-wire-progress] ${JSON.stringify({
                            phase,
                            events: events.slice(-20),
                            requests: handler.requests.map((request, index) => ({
                                endpoint: new URL(handler.requestUrls[index]!).pathname,
                                model: request.model,
                                stream: request.stream,
                                messages: request.messages.length,
                                hasTools: Boolean(request.tools?.length),
                                toolChoice: request.tool_choice,
                            })),
                        })}`
                    );
                });
                try {
                    const session = await cacheClient.createSession({
                        onPermissionRequest: approveAll,
                        model: "claude-sonnet-5",
                        contextTier: "default",
                        featureFlags: { ANTHROPIC_1_HOUR_PROMPT_CACHE: oneHour },
                        expAssignments: {
                            Features: ["copilot_cli_anthropic_1_hour_prompt_cache"],
                            Flights: {
                                copilot_cli_anthropic_1_hour_prompt_cache: String(oneHour),
                            },
                            Configs: [
                                {
                                    Id: "default",
                                    Parameters: {
                                        copilot_cli_anthropic_1_hour_prompt_cache: oneHour,
                                    },
                                },
                            ],
                            AssignmentContext: `cache-wire-one-hour-${oneHour}`,
                        },
                        ...(route === "BYOK Messages"
                            ? {
                                  provider: {
                                      type: "anthropic" as const,
                                      baseUrl: "https://cache-wire-replay.invalid",
                                      apiKey: "fake-cache-wire-key",
                                      modelId: "claude-sonnet-5",
                                  },
                              }
                            : { providers: [] }),
                        systemMessage: {
                            mode: "replace",
                            content: "Reusable agent policy. ".repeat(4_096),
                        },
                        streaming: false,
                        infiniteSessions: { enabled: false },
                    });
                    session.on((event) => events.push(event.type));
                    phase = "initial turn";
                    expect(
                        (
                            await session.sendAndWait({
                                prompt: "Initialize the reusable conversation.",
                            })
                        )?.data.content
                    ).toBe("FALLBACK_BUDGET_OK");
                    const initial = handler.requests.at(-1)!;
                    expect(
                        new URL(handler.requestUrls.at(-1)!).hostname ===
                            "cache-wire-replay.invalid"
                    ).toBe(route === "BYOK Messages");
                    const marker = {
                        type: "ephemeral",
                        ...(oneHour && route !== "BYOK Messages" ? { ttl: "1h" } : {}),
                    };
                    expect(systemCacheMarkers(initial)).toContainEqual(marker);
                    expect(
                        initial.tools?.some((tool) =>
                            Boolean(tool.cache_control ?? tool.copilot_cache_control)
                        )
                    ).toBe(true);

                    const beforeSampling = handler.requests.length;
                    phase = "sampling and concurrent turn";
                    const [sampling, concurrentTurn] = await Promise.all([
                        session.rpc.mcp.executeSampling({
                            requestId: "cache-wire-sampling",
                            serverName: "cache-wire-server",
                            mcpRequestId: "cache-wire-mcp",
                            request: {
                                systemPrompt: "Disposable caller-owned policy. ".repeat(4_096),
                                messages: [
                                    {
                                        role: "user",
                                        content: {
                                            type: "text",
                                            text: "Compute a sampling result.",
                                        },
                                    },
                                ],
                                maxTokens: 4096,
                            },
                        }),
                        session.sendAndWait({
                            prompt: "Continue while sampling runs independently.",
                        }),
                    ]);
                    expect(concurrentTurn?.data.content).toBe("FALLBACK_BUDGET_OK");
                    expect(sampling).toMatchObject({
                        action: "success",
                        result: { content: { type: "text", text: "FALLBACK_BUDGET_OK" } },
                    });
                    const concurrentRequests = handler.requests.slice(beforeSampling);
                    expect(concurrentRequests).toHaveLength(2);
                    const sampled = concurrentRequests.find((request) => !request.tools?.length)!;
                    const continued = concurrentRequests.find((request) =>
                        Boolean(request.tools?.length)
                    )!;
                    expect(systemCacheMarkers(sampled)).toEqual([]);
                    expectNoConversationCacheMarkers(sampled);
                    expect(systemCacheMarkers(continued)).toContainEqual(marker);

                    phase = "handoff summary";
                    expect(await session.rpc.history.summarizeForHandoff()).toMatchObject({
                        summary: "FALLBACK_BUDGET_OK",
                    });
                    expect(systemCacheMarkers(handler.requests.at(-1)!)).toEqual([]);
                    expectNoConversationCacheMarkers(handler.requests.at(-1)!);

                    phase = "manual compaction";
                    const completed = getNextSessionEvent(
                        session,
                        "session.compaction_complete",
                        "manual cache compaction"
                    );
                    const [compacted, completionEvent] = await Promise.all([
                        session.rpc.history.compact({ trigger: "manual" }),
                        completed,
                    ]);
                    expect(compacted).toMatchObject({
                        success: true,
                        summaryContent: "FALLBACK_BUDGET_OK",
                    });
                    expect(completionEvent.data.compactionTokensUsed).toMatchObject({
                        inputTokens: 150,
                        outputTokens: 10,
                        cacheReadTokens: 50,
                        cacheWriteTokens: 0,
                    });
                    const compacting = handler.requests.at(-1)!;
                    expect(systemCacheMarkers(compacting)).toEqual(systemCacheMarkers(initial));
                    expect(compacting.tools).toEqual(initial.tools);
                    expect(compacting.tool_choice).toEqual(
                        route === "CAPI Chat" ? "none" : { type: "none" }
                    );
                    expectNoConversationCacheMarkers(compacting);

                    phase = "post-compaction turn";
                    expect(
                        (await session.sendAndWait({ prompt: "Continue after compaction." }))?.data
                            .content
                    ).toBe("FALLBACK_BUDGET_OK");
                    expect(systemCacheMarkers(handler.requests.at(-1)!)).toContainEqual(marker);
                    phase = "disconnect session";
                    await session.disconnect();
                } finally {
                    phase = `stop client (after ${phase})`;
                    await cacheClient.stop();
                }
            });
        }
    );
}

describe.each(["CAPI Messages", "CAPI Chat", "BYOK Messages"] as const)(
    "Disposable Anthropic prompt caching during automatic compaction (%s)",
    async (route) => {
        const { createClient } = await createSdkTestContext({ replayOnly: true });
        it(`avoids discarded transcript writes during automatic compaction on ${route}`, async () => {
            const handler = new RefusalBudgetReplayHandler(
                route === "CAPI Chat" ? "/chat/completions" : "/v1/messages"
            );
            const cacheClient = createClient({ requestHandler: handler });
            try {
                const session = await cacheClient.createSession({
                    onPermissionRequest: approveAll,
                    model: "claude-sonnet-5",
                    ...(route === "BYOK Messages"
                        ? {
                              provider: {
                                  type: "anthropic" as const,
                                  baseUrl: "https://cache-wire-replay.invalid",
                                  apiKey: "fake-cache-wire-key",
                                  modelId: "claude-sonnet-5",
                              },
                          }
                        : { providers: [] }),
                    systemMessage: {
                        mode: "replace",
                        content: "Reusable automatic policy. ".repeat(600),
                    },
                    streaming: false,
                    infiniteSessions: {
                        enabled: true,
                        backgroundCompactionThreshold: 0.005,
                        bufferExhaustionThreshold: 0.01,
                    },
                });
                const completed = getNextSessionEvent(
                    session,
                    "session.compaction_complete",
                    "automatic cache compaction"
                );
                const [, completionEvent] = await Promise.all([
                    (async () => {
                        expect(
                            (
                                await session.sendAndWait({
                                    prompt: "Start the automatic compaction scenario.",
                                })
                            )?.data.content
                        ).toBe("FALLBACK_BUDGET_OK");
                        expect(
                            (
                                await session.sendAndWait({
                                    prompt: "Continue the automatic compaction scenario.",
                                })
                            )?.data.content
                        ).toBe("FALLBACK_BUDGET_OK");
                    })(),
                    completed,
                ]);
                expect(completionEvent.data).toMatchObject({
                    success: true,
                    summaryContent: "FALLBACK_BUDGET_OK",
                    compactionTokensUsed: {
                        inputTokens: 150,
                        outputTokens: 10,
                        cacheReadTokens: 50,
                        cacheWriteTokens: 0,
                    },
                });
                const compactions = handler.requests.filter(({ tool_choice }) =>
                    route === "CAPI Chat"
                        ? tool_choice === "none"
                        : typeof tool_choice === "object" &&
                          tool_choice !== null &&
                          "type" in tool_choice &&
                          tool_choice.type === "none"
                );
                expect(compactions.length).toBeGreaterThan(0);
                for (const request of compactions) {
                    expect(systemCacheMarkers(request)).not.toEqual([]);
                    expect(request.tools).toEqual(handler.requests[0].tools);
                    expectNoConversationCacheMarkers(request);
                }
                await session.disconnect();
            } finally {
                await cacheClient.stop();
            }
        });
    }
);

describe("Disposable Anthropic prompt caching during refusal fallback", async () => {
    const { createClient } = await createSdkTestContext({
        replayOnly: true,
        copilotClientOptions: {
            env: {
                ANTHROPIC_REFUSAL_FALLBACK: "true",
                COPILOT_EXP_COPILOT_CLI_ANTHROPIC_REFUSAL_FALLBACK: "true",
            },
        },
    });

    it("preserves single-use cache intent across refusal fallback", async () => {
        const handler = new RefusalBudgetReplayHandler();
        const cacheClient = createClient({ requestHandler: handler });
        try {
            const session = await cacheClient.createSession({
                onPermissionRequest: approveAll,
                model: "claude-sonnet-5.5",
                providers: [],
                infiniteSessions: { enabled: false },
            });
            const sampled = await session.rpc.mcp.executeSampling({
                requestId: "fallback-cache-sampling",
                serverName: "cache-wire-server",
                mcpRequestId: "fallback-cache-mcp",
                request: {
                    systemPrompt: "Disposable fallback policy. ".repeat(4_096),
                    messages: [
                        {
                            role: "user",
                            content: { type: "text", text: "Compute a sampling result." },
                        },
                    ],
                    maxTokens: 4096,
                },
            });
            expect(sampled).toMatchObject({
                action: "success",
                result: { content: { text: "FALLBACK_BUDGET_OK" } },
            });
            expect(handler.requests.map(({ model }) => model)).toEqual([
                "claude-sonnet-5.5",
                "claude-sonnet-5",
            ]);
            for (const request of handler.requests) {
                expect(systemCacheMarkers(request)).toEqual([]);
                expectNoConversationCacheMarkers(request);
            }
            await session.disconnect();
        } finally {
            await cacheClient.stop();
        }
    });
});

describe("Compaction failure attribution after model redispatch", async () => {
    const { createClient } = await createSdkTestContext({
        replayOnly: true,
        copilotClientOptions: {
            env: {
                ANTHROPIC_REFUSAL_FALLBACK: "true",
                COPILOT_EXP_COPILOT_CLI_ANTHROPIC_REFUSAL_FALLBACK: "true",
            },
        },
    });

    it("reports the terminal failure model while retaining earlier usage", async () => {
        const githubTelemetry: GitHubTelemetryNotification[] = [];
        const handler = new CompactionRedispatchFailureHandler();
        const compactionClient = createClient({
            requestHandler: handler,
            onGitHubTelemetry: (notification) => {
                githubTelemetry.push(notification);
            },
        });
        try {
            await using session = await compactionClient.createSession({
                onPermissionRequest: approveAll,
                model: "claude-sonnet-5.5",
                providers: [],
                streaming: false,
                systemMessage: {
                    mode: "replace",
                    content: "Automatic redispatch attribution policy. ".repeat(600),
                },
                infiniteSessions: {
                    enabled: true,
                    backgroundCompactionThreshold: 0.005,
                    bufferExhaustionThreshold: 0.01,
                },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize compaction redispatch." }))?.data
                    .content
            ).toBe("FOREGROUND_REDISPATCH_OK");

            const completed: Extract<SessionEvent, { type: "session.compaction_complete" }>[] = [];
            session.on("session.compaction_complete", (event) => completed.push(event));
            expect(
                (await session.sendAndWait({ prompt: "Trigger automatic compaction redispatch." }))
                    ?.data.content
            ).toBe("FOREGROUND_REDISPATCH_OK");
            await expect.poll(() => completed).toHaveLength(1);
            const completion = completed[0]!;
            expect(handler.compactionModels).toEqual([
                "claude-sonnet-5.5",
                "claude-sonnet-5.5",
                "claude-sonnet-5",
            ]);
            expect(completion.data).toMatchObject({
                success: false,
                outcome: "failed",
                trigger: "threshold",
                failureReason: "provider_rejected",
                model: "claude-sonnet-5",
                initialModel: "claude-sonnet-5.5",
                compactionTokensUsed: {
                    model: "claude-sonnet-5.5",
                    inputTokens: 200,
                    outputTokens: 20,
                },
            });
            await expect
                .poll(() =>
                    githubTelemetry.find(
                        ({ sessionId, restricted, event }) =>
                            sessionId === session.sessionId &&
                            !restricted &&
                            event.kind === "session_compaction_complete" &&
                            event.properties?.compaction_attempt_id ===
                                completion.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    event: {
                        properties: {
                            model: "claude-sonnet-5",
                            initial_model: "claude-sonnet-5.5",
                            failure_reason: "provider_rejected",
                        },
                    },
                });
        } finally {
            await compactionClient.stop();
        }
    });
});

describe("Disposable Anthropic prompt caching during Fusion review", async () => {
    const { createClient } = await createSdkTestContext({ replayOnly: true });
    it("avoids tool-less critic writes without disabling the solver cache", async () => {
        const handler = new RefusalBudgetReplayHandler("/v1/messages", true);
        const cacheClient = createClient({ requestHandler: handler });
        try {
            const session = await cacheClient.createSession({
                onPermissionRequest: approveAll,
                model: "hydrafusion-max",
                providers: [],
                enableExperimentalMode: true,
                featureFlags: {
                    HYDRAFUSION: true,
                    HYDRAFUSION_ROLLOUT: true,
                    HYDRAFUSION_PLAN_V2: true,
                },
                expAssignments: {
                    Features: [],
                    Flights: {},
                    Configs: [],
                    AssignmentContext: "cache-wire-fusion-review",
                },
                infiniteSessions: { enabled: false },
            });
            const events: SessionEvent[] = [];
            expect((await session.rpc.model.getCurrent()).modelId).toBe("hydrafusion-max");
            const unsubscribe = session.on((event) => events.push(event));
            try {
                expect(
                    (
                        await session.sendAndWait({
                            prompt: "Answer the cache policy review scenario without using tools.",
                        })
                    )?.data.content
                ).toBe("FALLBACK_BUDGET_OK");
                expect(
                    events.filter((event) => event.type === "session.fusion_route_failed")
                ).toEqual([]);
                expect(
                    events
                        .filter((event) => event.type === "assistant.fusion_phase_completed")
                        .map((event) => event.data.phaseKind)
                ).toEqual(["draft", "critic"]);
                expect(handler.requests).toHaveLength(2);
                expect(systemCacheMarkers(handler.requests[0])).not.toEqual([]);
                expect(handler.requests[0].tools?.length).toBeGreaterThan(0);
                const critic = handler.requests[1];
                expect(critic.model).toBe("claude-opus-5");
                expect(critic.tools ?? []).toEqual([]);
                expect(systemCacheMarkers(critic)).toEqual([]);
                expectNoConversationCacheMarkers(critic);
            } finally {
                unsubscribe();
                await session.disconnect();
            }
        } finally {
            await cacheClient.stop();
        }
    });
});

interface BudgetReplayRequest {
    model: string;
    stream?: boolean;
    messages?: Array<{ role: string; content: unknown }>;
    tools?: unknown[];
    tool_choice?: unknown;
}

class BudgetReplayHandler extends CopilotRequestHandler {
    readonly requests: BudgetReplayRequest[] = [];
    readonly requestUrls: string[] = [];

    protected responseContent(_request: BudgetReplayRequest, _requestNumber: number): string {
        return "BUDGET_CONTROL_OK";
    }

    protected async beforeResponse(
        _request: BudgetReplayRequest,
        _requestNumber: number
    ): Promise<void> {}

    protected override async sendRequest(request: Request): Promise<Response> {
        expect(request.url).toMatch(/\/chat\/completions$/);
        const body = (await request.json()) as BudgetReplayRequest;
        this.requests.push(body);
        this.requestUrls.push(request.url);
        await this.beforeResponse(body, this.requests.length);
        const content = this.responseContent(body, this.requests.length);
        if (!body.stream) {
            return Response.json({
                id: "budget-replay",
                object: "chat.completion",
                created: 1,
                model: body.model,
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content },
                        finish_reason: "stop",
                    },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            });
        }
        const chunk = {
            id: "budget-replay",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        return new Response(
            `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({
                ...chunk,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } }
        );
    }
}

class FailingCompactionReplayHandler extends BudgetReplayHandler {
    constructor(
        private readonly status = 400,
        private readonly code = "invalid_request"
    ) {
        super();
    }

    protected override async sendRequest(request: Request): Promise<Response> {
        if (this.requests.length === 0) {
            return super.sendRequest(request);
        }
        const body = (await request.json()) as BudgetReplayRequest;
        this.requests.push(body);
        this.requestUrls.push(request.url);
        return Response.json(
            {
                error: {
                    code: this.code,
                    message: "Controlled compaction rejection",
                },
            },
            { status: this.status }
        );
    }
}

interface CompactionEffortRequest {
    model: string;
    stream?: boolean;
    reasoning?: { effort?: string };
    input: Array<{ type?: string; role?: string; reasoning?: { effort?: string } }>;
}

class CompactionEffortReplayHandler extends CopilotRequestHandler {
    readonly requests: CompactionEffortRequest[] = [];
    summaryGate?: {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
    };

    protected override async sendRequest(request: Request): Promise<Response> {
        expect(new URL(request.url).pathname).toBe("/responses");
        const body = (await request.json()) as CompactionEffortRequest;
        this.requests.push(body);
        expect(body.stream).not.toBe(true);
        const incompleteSummary = this.requests.length === 2 && this.summaryGate;
        if (incompleteSummary) {
            incompleteSummary.entered.resolve();
            await incompleteSummary.release.promise;
        }
        return Response.json({
            id: "compaction-effort-response",
            object: "response",
            model: body.model,
            status: incompleteSummary ? "incomplete" : "completed",
            ...(incompleteSummary ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
            output: [
                {
                    id: "compaction-effort-message",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: incompleteSummary ? "SUMMARY_PART_ONE" : "COMPACTION_EFFORT_OK",
                        },
                    ],
                },
            ],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        });
    }
}

describe("Compaction reasoning effort", async () => {
    const { createClient } = await createSdkTestContext({ replayOnly: true });

    it("reduces only the OpenAI summary request and retains the session effort", async () => {
        const handler = new CompactionEffortReplayHandler();
        const effortClient = createClient({ requestHandler: handler });
        try {
            await using session = await effortClient.createSession({
                onPermissionRequest: approveAll,
                model: "gpt-6-sol",
                reasoningEffort: "max",
                provider: {
                    type: "openai",
                    wireApi: "responses",
                    baseUrl: "https://compaction-effort.invalid",
                    apiKey: "fake-byok-credential-for-e2e-tests",
                    modelId: "gpt-6-sol",
                },
                streaming: false,
                featureFlags: { COMPACTION_MEDIUM_REASONING_EFFORT: true },
                expAssignments: {
                    Features: [],
                    Flights: {},
                    Configs: [],
                    AssignmentContext: "compaction-medium-effort",
                },
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize the effort scenario." }))?.data
                    .content
            ).toBe("COMPACTION_EFFORT_OK");
            expect(handler.requests).toHaveLength(1);
            expect(handler.requests[0].reasoning?.effort).toBe("max");

            const compacted = await session.rpc.history.compact({ trigger: "manual" });
            expect(compacted).toMatchObject({
                success: true,
                summaryContent: "COMPACTION_EFFORT_OK",
            });
            expect(handler.requests).toHaveLength(2);
            const summaryRequest = handler.requests[1];
            expect(summaryRequest.reasoning?.effort).toBe("max");
            expect(
                summaryRequest.input.filter((item) => item.type === "configuration_update")
            ).toEqual([{ type: "configuration_update", reasoning: { effort: "medium" } }]);
            expect(summaryRequest.input.at(-2)?.reasoning?.effort).toBe("medium");
            expect((await session.rpc.model.getCurrent()).reasoningEffort).toBe("max");

            expect(
                (await session.sendAndWait({ prompt: "Continue after the summary." }))?.data.content
            ).toBe("COMPACTION_EFFORT_OK");
            expect(handler.requests).toHaveLength(3);
            const nextRequest = handler.requests[2];
            expect(nextRequest.reasoning?.effort).toBe("max");
            expect(
                nextRequest.input.filter((item) => item.type === "configuration_update")
            ).toEqual([]);
        } finally {
            await effortClient.stop();
        }
    });

    it("preserves Anthropic compaction effort even when the reduction is enabled", async () => {
        const handler = new RefusalBudgetReplayHandler();
        const effortClient = createClient({ requestHandler: handler });
        try {
            await using session = await effortClient.createSession({
                onPermissionRequest: approveAll,
                model: "claude-opus-5.5",
                reasoningEffort: "max",
                provider: {
                    type: "anthropic",
                    baseUrl: "https://compaction-effort.invalid",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "claude-opus-5.5",
                },
                featureFlags: { COMPACTION_MEDIUM_REASONING_EFFORT: true },
                expAssignments: {
                    Features: [],
                    Flights: {},
                    Configs: [],
                    AssignmentContext: "compaction-medium-effort",
                },
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize the effort scenario." }))?.data
                    .content
            ).toBe("FALLBACK_BUDGET_OK");
            expect(handler.requests).toHaveLength(1);
            expect(handler.requests[0].output_config?.effort).toBe("max");

            const compacted = await session.rpc.history.compact({ trigger: "manual" });
            expect(compacted).toMatchObject({
                success: true,
                summaryContent: "FALLBACK_BUDGET_OK",
            });
            expect(handler.requests).toHaveLength(2);
            const summaryRequest = handler.requests[1];
            expect(summaryRequest.output_config?.effort).toBe("max");
            expect(
                summaryRequest.messages.flatMap((message) =>
                    message.output_config?.effort ? [message.output_config.effort] : []
                )
            ).toEqual([]);
            expect((await session.rpc.model.getCurrent()).reasoningEffort).toBe("max");

            expect(
                (await session.sendAndWait({ prompt: "Continue after the summary." }))?.data.content
            ).toBe("FALLBACK_BUDGET_OK");
            expect(handler.requests).toHaveLength(3);
            const nextRequest = handler.requests[2];
            expect(nextRequest.output_config?.effort).toBe("max");
            expect(nextRequest.messages.filter((message) => message.output_config)).toEqual([]);
        } finally {
            await effortClient.stop();
        }
    });

    it("isolates compaction effort from concurrent sampling and selected effort changes", async ({
        expect,
        onTestFinished,
    }) => {
        const handler = new CompactionEffortReplayHandler();
        const gate = {
            entered: Promise.withResolvers<void>(),
            release: Promise.withResolvers<void>(),
        };
        handler.summaryGate = gate;
        const effortClient = createClient({ requestHandler: handler });
        const stopClient = async () => {
            gate.release.resolve();
            const errors = await effortClient.stop();
            if (errors.length) {
                throw new AggregateError(errors, "Failed to stop compaction overlap client");
            }
        };
        onTestFinished(stopClient);
        await withTestCleanup(async () => {
            const session = await effortClient.createSession({
                onPermissionRequest: approveAll,
                model: "gpt-6-sol",
                reasoningEffort: "max",
                provider: {
                    type: "openai",
                    wireApi: "responses",
                    baseUrl: "https://compaction-effort.invalid",
                    apiKey: "fake-byok-credential-for-e2e-tests",
                    modelId: "gpt-6-sol",
                },
                streaming: false,
                featureFlags: { COMPACTION_MEDIUM_REASONING_EFFORT: true },
                expAssignments: {
                    Features: [],
                    Flights: {},
                    Configs: [],
                    AssignmentContext: "compaction-overlap",
                },
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize the overlap scenario." }))?.data
                    .content
            ).toBe("COMPACTION_EFFORT_OK");
            const compaction = session.rpc.history.compact({ trigger: "manual" });
            await withTestCleanup(
                async () => {
                    await Promise.race([
                        gate.entered.promise,
                        compaction.then((result) => {
                            throw new Error(
                                `Compaction completed before its summary gate: ${JSON.stringify(result)}`
                            );
                        }),
                    ]);
                    expect(handler.requests).toHaveLength(2);
                    expect(handler.requests[1].input.at(-2)?.reasoning?.effort).toBe("medium");
                    expect((await session.rpc.model.getCurrent()).reasoningEffort).toBe("max");

                    expect(
                        await session.rpc.mcp.executeSampling({
                            requestId: "compaction-overlap-sampling",
                            serverName: "compaction-overlap-server",
                            mcpRequestId: "compaction-overlap-mcp",
                            request: {
                                messages: [
                                    {
                                        role: "user",
                                        content: {
                                            type: "text",
                                            text: "Compute a sampling result.",
                                        },
                                    },
                                ],
                                maxTokens: 4096,
                            },
                        })
                    ).toMatchObject({
                        action: "success",
                        result: { content: { type: "text", text: "COMPACTION_EFFORT_OK" } },
                    });
                    expect(handler.requests).toHaveLength(3);
                    expect(handler.requests[2].reasoning?.effort).toBe("max");
                    expect(
                        handler.requests[2].input.filter(
                            (item) => item.type === "configuration_update"
                        )
                    ).toEqual([]);

                    await session.rpc.model.setReasoningEffort({ reasoningEffort: "high" });
                    expect((await session.rpc.model.getCurrent()).reasoningEffort).toBe("high");
                },
                () => gate.release.resolve(),
                async () => {
                    expect(await compaction).toMatchObject({
                        success: true,
                        summaryContent: expect.stringContaining("COMPACTION_EFFORT_OK"),
                    });
                }
            );
            expect(handler.requests).toHaveLength(4);
            const continuation = handler.requests[3];
            expect(continuation.reasoning?.effort).toBe("max");
            expect(
                continuation.input.filter((item) => item.type === "configuration_update")
            ).toEqual([{ type: "configuration_update", reasoning: { effort: "medium" } }]);
            expect((await session.rpc.model.getCurrent()).reasoningEffort).toBe("high");
            expect(
                (await session.sendAndWait({ prompt: "Continue after the held summary." }))?.data
                    .content
            ).toBe("COMPACTION_EFFORT_OK");
            expect(handler.requests).toHaveLength(5);
            // The cache baseline stays pinned; the durable user boundary selects high.
            expect(handler.requests[4].reasoning?.effort).toBe("max");
            expect(
                handler.requests[4].input.filter((item) => item.type === "configuration_update")
            ).toEqual([{ type: "configuration_update", reasoning: { effort: "high" } }]);
            expect(handler.requests[4].input.at(-2)?.reasoning?.effort).toBe("high");
            expect((await session.rpc.model.getCurrent()).reasoningEffort).toBe("high");
            await session.disconnect();
        }, stopClient);
    });
});

describe("Refusal fallback output budget", async () => {
    const { createClient } = await createSdkTestContext();

    it("should clamp fallback output before admission and retain its effective budget", async () => {
        const handler = new RefusalBudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            await budgetClient.start();
            expect(
                (await budgetClient.listModels()).find((model) => model.id === "claude-sonnet-5")
            ).toMatchObject({
                capabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 64_000,
                    },
                },
            });
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "claude-sonnet-5.5",
                // Refusal fallback is a first-party contract, not a BYOK switch.
                providers: [],
                infiniteSessions: { enabled: false },
            });
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            expect(
                (await session.sendAndWait({ prompt: "Exercise refusal fallback admission." }))
                    ?.data.content
            ).toBe("FALLBACK_BUDGET_OK");
            expect(
                handler.requests.map(({ model, max_tokens }) => ({ model, max_tokens }))
            ).toEqual([
                { model: "claude-sonnet-5.5", max_tokens: 128_000 },
                { model: "claude-sonnet-5", max_tokens: 64_000 },
            ]);
            expect(events.filter((event) => event.type === "session.error")).toEqual([]);
            // Recorded model changes can arrive after the directly forwarded idle event.
            await expect
                .poll(() => events.filter((event) => event.type === "session.model_change"))
                .toEqual([
                    expect.objectContaining({
                        data: expect.objectContaining({
                            newModel: "claude-sonnet-5",
                            previousModel: "claude-sonnet-5.5",
                            cause: "refusal_fallback",
                            source: "automatic",
                        }),
                    }),
                ]);
            expect((await session.rpc.model.getCurrent()).modelId).toBe("claude-sonnet-5");
            const usage = events.filter((event) => event.type === "assistant.usage");
            expect(
                usage.map(({ data: { model, maxPromptTokens, maxOutputTokens } }) => ({
                    model,
                    maxPromptTokens,
                    maxOutputTokens,
                }))
            ).toEqual([
                { model: "claude-sonnet-5.5", maxPromptTokens: 250_000, maxOutputTokens: 128_000 },
                { model: "claude-sonnet-5", maxPromptTokens: 64_000, maxOutputTokens: 64_000 },
            ]);
            expect(
                (
                    await session.rpc.metadata.contextInfo({
                        promptTokenLimit: 0,
                        outputTokenLimit: 64_000,
                    })
                ).contextInfo
            ).toMatchObject({
                modelName: "claude-sonnet-5",
                limit: 112_000,
                promptTokenLimit: 64_000,
            });
            // The next turn uses Sonnet 5's normal 32k cap, not the one-shot retry's 64k cap.
            expect(
                (
                    await session.rpc.metadata.contextInfo({
                        promptTokenLimit: 0,
                        outputTokenLimit: 0,
                    })
                ).contextInfo
            ).toMatchObject({ limit: 112_000, promptTokenLimit: 96_000 });
            expect(
                (await session.sendAndWait({ prompt: "Check the retained fallback budget." }))?.data
                    .content
            ).toBe("FALLBACK_BUDGET_OK");
            expect(handler.requests).toHaveLength(3);
            expect(handler.requests[2]).toMatchObject({
                model: "claude-sonnet-5",
                max_tokens: 32_000,
            });
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });
});

function getNextSessionEvent<TEventType extends SessionEvent["type"]>(
    session: CopilotSession,
    eventType: TEventType,
    description: string,
    predicate: (event: Extract<SessionEvent, { type: TEventType }>) => boolean = () => true
): Promise<Extract<SessionEvent, { type: TEventType }>> {
    return new Promise((resolve, reject) => {
        let unsubscribe: () => void = () => {};
        const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Timed out waiting for ${description}`));
        }, compactionTimeoutMs);

        unsubscribe = session.on((event) => {
            if (event.type === eventType) {
                const typedEvent = event as Extract<SessionEvent, { type: TEventType }>;
                if (predicate(typedEvent)) {
                    clearTimeout(timeout);
                    unsubscribe();
                    resolve(typedEvent);
                }
            } else if (event.type === "session.error") {
                clearTimeout(timeout);
                unsubscribe();
                reject(new Error(`${event.data.message}\n${event.data.stack}`));
            }
        });
    });
}

describe("Compaction", async () => {
    const githubTelemetry: GitHubTelemetryNotification[] = [];
    const recordGitHubTelemetry = (notification: GitHubTelemetryNotification) => {
        githubTelemetry.push(notification);
    };
    const {
        copilotClient: client,
        openAiEndpoint,
        createClient,
        workDir,
    } = await createSdkTestContext({
        copilotClientOptions: {
            onGitHubTelemetry: recordGitHubTelemetry,
        },
    });

    // Paused-clock Rust tests pin the cancellation/timeout budgets; this covers
    // cancellation across the real SDK filesystem callback boundary.
    it("should retain aborted attempt attribution when replacement compaction starts", async () => {
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        let releaseStorage!: () => void;
        const release = new Promise<void>((resolve) => {
            releaseStorage = resolve;
        });
        const database = new DatabaseSync(":memory:");
        class ReplacementCompactionReplayHandler extends BudgetReplayHandler {
            private compactionCount = 0;

            protected override responseContent(request: BudgetReplayRequest): string {
                if (request.tool_choice !== "none") return "BUDGET_CONTROL_OK";
                this.compactionCount++;
                return this.compactionCount === 1
                    ? "FIRST_CANCELLED_SUMMARY"
                    : "SECOND_APPLIED_SUMMARY";
            }
        }
        const handler = new ReplacementCompactionReplayHandler();
        const compactionClient = createClient({
            requestHandler: handler,
            onGitHubTelemetry: recordGitHubTelemetry,
            sessionFs: {
                initialCwd: workDir,
                sessionStatePath: join(workDir, "compaction-state"),
                conventions: process.platform === "win32" ? "windows" : "posix",
                capabilities: { sqlite: true },
            },
        });
        let stalled = false;
        let storageRequest: Promise<void> | undefined;
        try {
            await using session = await compactionClient.createSession({
                onPermissionRequest: approveAll,
                streaming: false,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens: 100_000,
                },
                infiniteSessions: { enabled: false },
                createSessionFsProvider: () => ({
                    readFile: (path) => fs.readFile(path, "utf8"),
                    writeFile: (path, content) => fs.writeFile(path, content),
                    appendFile: (path, content) => fs.appendFile(path, content),
                    exists: async (path) => existsSync(path),
                    stat: async (path) => {
                        const info = await fs.stat(path);
                        return {
                            isFile: info.isFile(),
                            isDirectory: info.isDirectory(),
                            size: info.size,
                            mtime: info.mtime.toISOString(),
                            birthtime: info.birthtime.toISOString(),
                        };
                    },
                    mkdir: async (path, recursive, mode) => {
                        await fs.mkdir(path, { recursive, mode });
                    },
                    readdir: (path) => fs.readdir(path),
                    readdirWithTypes: async (path) =>
                        (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
                            name: entry.name,
                            type: entry.isDirectory() ? "directory" : "file",
                        })),
                    rm: (path, recursive, force) => fs.rm(path, { recursive, force }),
                    rename: (from, to) => fs.rename(from, to),
                    sqlite: {
                        exists: async () => true,
                        query: async (queryType, query, params) => {
                            if (stalled && /\b(?:factory|workflow)_runs\b/.test(query)) {
                                markEntered();
                                storageRequest = release;
                                await storageRequest;
                                throw new Error("Controlled workflow storage failure");
                            }
                            if (queryType === "exec") {
                                database.exec(query);
                                return;
                            }
                            const statement = database.prepare(query);
                            if (queryType === "query") {
                                const rows = statement.all(params ?? {}).map((row) => {
                                    const values: Record<string, string | number | null> = {};
                                    for (const [key, value] of Object.entries(row)) {
                                        if (
                                            value !== null &&
                                            typeof value !== "string" &&
                                            typeof value !== "number"
                                        ) {
                                            throw new Error(`Unexpected SQLite value in ${key}`);
                                        }
                                        values[key] = value;
                                    }
                                    return values;
                                });
                                return {
                                    rows,
                                    columns: statement.columns().map((column) => column.name),
                                    rowsAffected: 0,
                                };
                            }
                            const result = statement.run(params ?? {});
                            return {
                                rows: [],
                                columns: [],
                                rowsAffected: Number(result.changes),
                                lastInsertRowid: Number(result.lastInsertRowid),
                            };
                        },
                    },
                }),
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize cancellable compaction." }))?.data
                    .content
            ).toBe("BUDGET_CONTROL_OK");
            const started: Extract<SessionEvent, { type: "session.compaction_start" }>[] = [];
            const completed: Extract<SessionEvent, { type: "session.compaction_complete" }>[] = [];
            session.on((event) => {
                if (event.type === "session.compaction_start") started.push(event);
                if (event.type === "session.compaction_complete") completed.push(event);
            });
            stalled = true;
            const compaction = session.rpc.history.compact().then(
                (result) => ({ result }),
                (error: unknown) => ({ error })
            );
            await Promise.race([
                entered,
                compaction.then((outcome) => {
                    throw new Error(
                        `Compaction settled before workflow storage: ${JSON.stringify(outcome)}`
                    );
                }),
            ]);

            await expect.poll(() => started).toHaveLength(1);
            const firstAttemptId = started[0]!.data.compactionAttemptId;
            expect(await session.rpc.history.abortManualCompaction()).toEqual({ aborted: true });
            stalled = false;
            const replacement = session.rpc.history.compact({ trigger: "manual" });
            await expect.poll(() => started).toHaveLength(2);
            const replacementAttemptId = started[1]!.data.compactionAttemptId;
            expect(replacementAttemptId).not.toBe(firstAttemptId);
            releaseStorage();

            const [outcome, replacementResult] = await Promise.all([compaction, replacement]);
            expect(outcome).toMatchObject({
                error: expect.objectContaining({
                    message: expect.stringContaining("Compaction Cancelled"),
                }),
            });
            expect(replacementResult).toMatchObject({
                success: true,
                summaryContent: "SECOND_APPLIED_SUMMARY",
            });
            await expect.poll(() => completed).toHaveLength(2);
            const completion = completed.find(
                (event) => event.data.compactionAttemptId === firstAttemptId
            );
            expect(completion?.data).toMatchObject({
                success: false,
                error: "Compaction Cancelled",
                outcome: "cancelled",
                outcomeReason: "manual_abort",
                compactionTokensUsed: expect.objectContaining({
                    model: "uncatalogued-budget-model",
                    inputTokens: 100,
                    outputTokens: 10,
                }),
            });
            expect(completion?.data.model).toBeUndefined();
            expect(completion?.data.failureReason).toBeUndefined();
            expect(
                completed.find((event) => event.data.compactionAttemptId === replacementAttemptId)
                    ?.data
            ).toMatchObject({
                success: true,
                outcome: "applied",
                summaryContent: "SECOND_APPLIED_SUMMARY",
            });
            await expect
                .poll(() =>
                    githubTelemetry.find(
                        ({ sessionId, restricted, event }) =>
                            sessionId === session.sessionId &&
                            !restricted &&
                            event.kind === "session_compaction_complete" &&
                            event.properties?.compaction_attempt_id ===
                                completion?.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    event: {
                        properties: {
                            model: uncataloguedModelTelemetryHash,
                            outcome: "cancelled",
                            outcome_reason: "manual_abort",
                        },
                    },
                });
            expect(await session.rpc.history.abortManualCompaction()).toEqual({ aborted: false });
            expect(
                (await session.sendAndWait({ prompt: "Continue after the cancelled compaction." }))
                    ?.data.content
            ).toBe("BUDGET_CONTROL_OK");
            expect(handler.requests.at(-1)).toMatchObject({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        role: "user",
                        content: expect.stringContaining("SECOND_APPLIED_SUMMARY"),
                    }),
                ]),
            });
            expect(JSON.stringify(handler.requests.at(-1)?.messages)).not.toContain(
                "FIRST_CANCELLED_SUMMARY"
            );
        } finally {
            releaseStorage();
            await storageRequest;
            try {
                await compactionClient.stop();
            } finally {
                database.close();
            }
        }
    });

    it("should report manual context growth with one trusted token domain", async () => {
        class ManualGrowthReplayHandler extends BudgetReplayHandler {
            protected override responseContent(
                request: BudgetReplayRequest,
                _requestNumber: number
            ): string {
                if (request.tool_choice === "none") {
                    return "MANUAL_GROWTH_SUMMARY ".repeat(300);
                }
                const messages = JSON.stringify(request.messages);
                return messages.includes("Continue after measured growth.")
                    ? "MANUAL_FOLLOWUP_ONLY"
                    : "MANUAL_OLD_ASSISTANT_ONLY";
            }
        }

        const handler = new ManualGrowthReplayHandler();
        const accountingClient = createClient({
            requestHandler: handler,
            onGitHubTelemetry: recordGitHubTelemetry,
        });
        try {
            await using session = await accountingClient.createSession({
                onPermissionRequest: approveAll,
                streaming: false,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens: 100_000,
                },
                systemMessage: {
                    mode: "replace",
                    content: "Stable accounting policy.",
                },
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize measured manual growth." }))?.data
                    .content
            ).toBe("MANUAL_OLD_ASSISTANT_ONLY");

            const completed = getNextSessionEvent(
                session,
                "session.compaction_complete",
                "manual token accounting completion"
            );
            const result = await session.rpc.history.compact({ trigger: "manual" });
            const completion = await completed;
            expect(Object.keys(result).sort()).toEqual(
                [
                    "contextWindow",
                    "messagesRemoved",
                    "success",
                    "summaryContent",
                    "tokensRemoved",
                ].sort()
            );
            expect(completion.data).toMatchObject({
                success: true,
                tokenAccountingBasis: "local_full_context_estimate",
                tokensRemoved: 0,
            });
            const pre = completion.data.preCompactionTokens;
            const post = completion.data.postCompactionTokens;
            expect(pre).toBeTypeOf("number");
            expect(post).toBeTypeOf("number");
            expect(post!).toBeGreaterThan(pre!);
            expect(completion.data.tokensRemoved).toBe(Math.max(pre! - post!, 0));
            expect(result.tokensRemoved).toBe(completion.data.tokensRemoved);
            expect(result.contextWindow?.currentTokens).toBe(post);
            await expect
                .poll(async () =>
                    (await session.getEvents()).find(
                        (event) =>
                            event.type === "session.compaction_complete" &&
                            event.data.compactionAttemptId === completion.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    data: {
                        preCompactionTokens: pre,
                        postCompactionTokens: post,
                        tokensRemoved: 0,
                        tokenAccountingBasis: "local_full_context_estimate",
                    },
                });

            await expect
                .poll(() =>
                    githubTelemetry.find(
                        ({ sessionId, restricted, event }) =>
                            sessionId === session.sessionId &&
                            !restricted &&
                            event.kind === "session_compaction_complete" &&
                            event.properties?.compaction_attempt_id ===
                                completion.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    event: {
                        properties: {
                            token_accounting_basis: "local_full_context_estimate",
                        },
                        metrics: {
                            pre_compaction_tokens: pre,
                            post_compaction_tokens: post,
                            tokens_removed: 0,
                            context_delta_tokens: post! - pre!,
                        },
                    },
                });

            expect(
                (await session.sendAndWait({ prompt: "Continue after measured growth." }))?.data
                    .content
            ).toBe("MANUAL_FOLLOWUP_ONLY");
            const followup = JSON.stringify(handler.requests.at(-1)?.messages);
            expect(followup).toContain("MANUAL_GROWTH_SUMMARY");
            expect(followup).toContain("Initialize measured manual growth.");
            expect(followup).toContain("Continue after measured growth.");
            expect(followup).not.toContain("MANUAL_OLD_ASSISTANT_ONLY");
        } finally {
            await accountingClient.stop();
        }
    });

    it("should preserve plan context after recording manual compaction completion", async () => {
        const planSentinel = "MANUAL_COMPACTION_PLAN_SENTINEL";
        class ManualPlanReplayHandler extends BudgetReplayHandler {
            protected override responseContent(
                request: BudgetReplayRequest,
                _requestNumber: number
            ): string {
                if (request.tool_choice === "none") return "MANUAL_PLAN_SUMMARY";
                return JSON.stringify(request.messages).includes(planSentinel)
                    ? "MANUAL_PLAN_RETAINED"
                    : "MANUAL_PLAN_DROPPED";
            }
        }

        const handler = new ManualPlanReplayHandler();
        const planClient = createClient({ requestHandler: handler });
        try {
            await using session = await planClient.createSession({
                onPermissionRequest: approveAll,
                streaming: false,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens: 100_000,
                },
                infiniteSessions: {
                    enabled: true,
                    backgroundCompactionThreshold: 1,
                    bufferExhaustionThreshold: 1,
                },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize plan-preserving compaction." }))
                    ?.data.content
            ).toBe("MANUAL_PLAN_DROPPED");
            await session.rpc.plan.update({
                content: `# Active plan\n\n- Preserve ${planSentinel} after compaction.`,
            });
            expect(await session.rpc.plan.read()).toMatchObject({
                content: expect.stringContaining(planSentinel),
            });

            await expect(session.rpc.history.compact({ trigger: "manual" })).resolves.toMatchObject(
                {
                    success: true,
                    summaryContent: "MANUAL_PLAN_SUMMARY",
                }
            );
            expect(
                (await session.sendAndWait({ prompt: "Continue with the active plan." }))?.data
                    .content
            ).toBe("MANUAL_PLAN_RETAINED");
            expect(JSON.stringify(handler.requests.at(-1)?.messages)).toContain(planSentinel);
        } finally {
            await planClient.stop();
        }
    });

    it("should count automatic retained tail in the trusted pre and post context", async () => {
        class AutomaticAccountingReplayHandler extends BudgetReplayHandler {
            readonly summaryEntered = Promise.withResolvers<void>();
            readonly releaseSummary = Promise.withResolvers<void>();

            protected override async beforeResponse(
                request: BudgetReplayRequest,
                _requestNumber: number
            ): Promise<void> {
                if (request.tool_choice === "none") {
                    this.summaryEntered.resolve();
                    await this.releaseSummary.promise;
                }
            }

            protected override responseContent(
                request: BudgetReplayRequest,
                _requestNumber: number
            ): string {
                if (request.tool_choice === "none") return "AUTO_ACCOUNTING_SUMMARY_ONLY";
                const messages = JSON.stringify(request.messages);
                if (messages.includes("Follow the measured automatic summary.")) {
                    return "AUTO_FOLLOWUP_ONLY";
                }
                if (messages.includes("Add the retained automatic tail.")) {
                    return "AUTO_TAIL_ASSISTANT_ONLY";
                }
                return "AUTO_OLD_ASSISTANT_ONLY";
            }
        }

        const handler = new AutomaticAccountingReplayHandler();
        const accountingClient = createClient({
            requestHandler: handler,
            onGitHubTelemetry: recordGitHubTelemetry,
        });
        try {
            await using session = await accountingClient.createSession({
                onPermissionRequest: approveAll,
                streaming: false,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens: 100_000,
                },
                systemMessage: {
                    mode: "replace",
                    content: "Automatic accounting policy. ".repeat(600),
                },
                infiniteSessions: {
                    enabled: true,
                    backgroundCompactionThreshold: 0.005,
                    bufferExhaustionThreshold: 0.01,
                },
            });
            expect(
                (await session.sendAndWait({ prompt: "Start measured automatic accounting." }))
                    ?.data.content
            ).toBe("AUTO_OLD_ASSISTANT_ONLY");

            const completed = getNextSessionEvent(
                session,
                "session.compaction_complete",
                "automatic token accounting completion",
                (event) => event.data.success
            );
            const started = getNextSessionEvent(
                session,
                "session.compaction_start",
                "automatic token accounting start"
            );
            const tailTurn = session.sendAndWait({
                prompt: "Add the retained automatic tail.",
            });
            await handler.summaryEntered.promise;
            expect((await tailTurn)?.data.content).toBe("AUTO_TAIL_ASSISTANT_ONLY");
            handler.releaseSummary.resolve();
            const [start, completion] = await Promise.all([started, completed]);
            expect(completion.data).toMatchObject({
                success: true,
                tokenAccountingBasis: "local_full_context_estimate",
            });
            expect(start.data.toolDefinitionsTokens).toBeGreaterThan(0);
            expect(completion.data.toolDefinitionsTokens).toBe(start.data.toolDefinitionsTokens);
            const pre = completion.data.preCompactionTokens;
            const post = completion.data.postCompactionTokens;
            expect(pre).toBeTypeOf("number");
            expect(post).toBeTypeOf("number");
            expect(completion.data.tokensRemoved).toBe(Math.max(pre! - post!, 0));
            await expect
                .poll(async () =>
                    (await session.getEvents()).find(
                        (event) =>
                            event.type === "session.compaction_complete" &&
                            event.data.compactionAttemptId === completion.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    data: {
                        preCompactionTokens: pre,
                        postCompactionTokens: post,
                        tokensRemoved: Math.max(pre! - post!, 0),
                        tokenAccountingBasis: "local_full_context_estimate",
                    },
                });

            await expect
                .poll(() =>
                    githubTelemetry.find(
                        ({ sessionId, restricted, event }) =>
                            sessionId === session.sessionId &&
                            !restricted &&
                            event.kind === "session_compaction_complete" &&
                            event.properties?.compaction_attempt_id ===
                                completion.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    event: {
                        properties: {
                            token_accounting_basis: "local_full_context_estimate",
                        },
                        metrics: {
                            pre_compaction_tokens: pre,
                            post_compaction_tokens: post,
                            tokens_removed: Math.max(pre! - post!, 0),
                            context_delta_tokens: post! - pre!,
                        },
                    },
                });

            expect(
                (
                    await session.sendAndWait({
                        prompt: "Follow the measured automatic summary.",
                    })
                )?.data.content
            ).toBe("AUTO_FOLLOWUP_ONLY");
            const followup = JSON.stringify(handler.requests.at(-1)?.messages);
            expect(followup).toContain("AUTO_ACCOUNTING_SUMMARY_ONLY");
            expect(followup).toContain("Add the retained automatic tail.");
            expect(followup).toContain("AUTO_TAIL_ASSISTANT_ONLY");
            expect(followup).toContain("Follow the measured automatic summary.");
            expect(followup).not.toContain("AUTO_OLD_ASSISTANT_ONLY");
        } finally {
            handler.releaseSummary.resolve();
            await accountingClient.stop();
        }
    });

    it("should classify manual compaction with empty history as not applicable", async () => {
        const handler = new BudgetReplayHandler();
        const noOpClient = createClient({
            requestHandler: handler,
            onGitHubTelemetry: recordGitHubTelemetry,
        });
        try {
            await using session = await noOpClient.createSession({
                onPermissionRequest: approveAll,
                streaming: false,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens: 100_000,
                },
                infiniteSessions: { enabled: false },
            });
            const started: Extract<SessionEvent, { type: "session.compaction_start" }>[] = [];
            const completed: Extract<SessionEvent, { type: "session.compaction_complete" }>[] = [];
            session.on("session.compaction_start", (event) => started.push(event));
            session.on("session.compaction_complete", (event) => completed.push(event));

            await expect(session.rpc.history.compact({ trigger: "manual" })).rejects.toThrow(
                "Nothing to compact."
            );
            await expect
                .poll(() => completed)
                .toEqual([
                    expect.objectContaining({
                        data: expect.objectContaining({
                            success: false,
                            model: "uncatalogued-budget-model",
                            outcome: "not_applicable",
                            outcomeReason: "nothing_to_compact",
                        }),
                    }),
                ]);
            expect(started).toHaveLength(1);
            expect(started[0]?.data.compactionAttemptId).toEqual(expect.any(String));
            expect(started[0]?.data.tokenLimit).toBeGreaterThan(0);
            expect(completed[0]?.data).toMatchObject({
                compactionAttemptId: started[0]?.data.compactionAttemptId,
                tokenLimit: started[0]?.data.tokenLimit,
            });
            expect(completed[0]?.data.failureReason).toBeUndefined();
            expect(completed[0]?.data.compactionTokensUsed).toBeUndefined();
            expect(handler.requests).toHaveLength(0);

            await expect
                .poll(() =>
                    githubTelemetry.find(
                        ({ sessionId, restricted, event }) =>
                            sessionId === session.sessionId &&
                            !restricted &&
                            event.kind === "session_compaction_complete" &&
                            event.properties?.compaction_attempt_id ===
                                completed[0]?.data.compactionAttemptId
                    )
                )
                .toMatchObject({
                    event: {
                        properties: {
                            model: uncataloguedModelTelemetryHash,
                            outcome: "not_applicable",
                            outcome_reason: "nothing_to_compact",
                        },
                    },
                });
        } finally {
            await noOpClient.stop();
        }
    });

    it.each([
        {
            scenario: "provider rejection",
            status: 400,
            code: "invalid_request",
            reason: "provider_rejected",
            category: "other",
        },
        {
            scenario: "request body timeout",
            status: 408,
            code: "user_request_timeout",
            reason: "transport_timeout",
            category: "network",
        },
    ])(
        "should preserve typed HTTP $scenario attribution without fabricating usage",
        async ({ status, code, reason, category }) => {
            const handler = new FailingCompactionReplayHandler(status, code);
            const failureClient = createClient({
                requestHandler: handler,
                onGitHubTelemetry: recordGitHubTelemetry,
            });
            try {
                await using session = await failureClient.createSession({
                    onPermissionRequest: approveAll,
                    streaming: false,
                    model: "uncatalogued-budget-model",
                    provider: {
                        type: "openai",
                        wireApi: "completions",
                        baseUrl: "https://budget-replay.invalid/v1",
                        bearerToken: "fake-byok-credential-for-e2e-tests",
                        modelId: "uncatalogued-budget-model",
                        maxPromptTokens: 100_000,
                    },
                    infiniteSessions: { enabled: false },
                });
                expect(
                    (await session.sendAndWait({ prompt: "Initialize failed compaction." }))?.data
                        .content
                ).toBe("BUDGET_CONTROL_OK");
                const completed: Extract<SessionEvent, { type: "session.compaction_complete" }>[] =
                    [];
                session.on("session.compaction_complete", (event) => completed.push(event));

                await expect(session.rpc.history.compact({ trigger: "manual" })).rejects.toThrow();
                await expect
                    .poll(() => completed)
                    .toEqual([
                        expect.objectContaining({
                            data: expect.objectContaining({
                                success: false,
                                model: "uncatalogued-budget-model",
                                outcome: "failed",
                                failureReason: reason,
                                statusCode: status,
                            }),
                        }),
                    ]);
                expect(completed[0]?.data.outcomeReason).toBeUndefined();
                expect(completed[0]?.data.compactionTokensUsed).toBeUndefined();

                await expect
                    .poll(() =>
                        githubTelemetry.find(
                            ({ sessionId, restricted, event }) =>
                                sessionId === session.sessionId &&
                                !restricted &&
                                event.kind === "session_compaction_complete" &&
                                event.properties?.compaction_attempt_id ===
                                    completed[0]?.data.compactionAttemptId
                        )
                    )
                    .toMatchObject({
                        event: {
                            properties: {
                                model: uncataloguedModelTelemetryHash,
                                outcome: "failed",
                                failure_reason: reason,
                                failure_category: category,
                            },
                            metrics: { status_code: status },
                        },
                    });
            } finally {
                await failureClient.stop();
            }
        }
    );

    it("should reject an oversized provider prompt before any inference request", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        const createSession = (maxPromptTokens: number) =>
            budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                    maxPromptTokens,
                    maxOutputTokens: 200_000,
                },
                infiniteSessions: { enabled: false },
            });
        try {
            const prompt = "budget-boundary ".repeat(16_384);
            const control = await createSession(250_000);
            expect((await control.sendAndWait({ prompt }))?.data.content).toBe("BUDGET_CONTROL_OK");
            expect(handler.requests).toHaveLength(1);
            await control.disconnect();
            // Leave room for static context so this reaches final request admission.
            const session = await createSession(32_000);
            const errors: Extract<SessionEvent, { type: "session.error" }>[] = [];
            session.on((event) => {
                if (event.type === "session.error") errors.push(event);
            });
            const admissionError =
                /Request exceeds the model's prompt budget after reserving output \(\d+ tokens; limit 32000\)\. Reduce context or compact before continuing\./;
            await expect(session.sendAndWait({ prompt })).rejects.toThrow(admissionError);
            expect(errors).toHaveLength(1);
            expect(errors[0].data.message).toMatch(admissionError);
            expect(handler.requests).toHaveLength(1);
            expect((await session.rpc.model.getCurrent()).modelId).toBe(
                "uncatalogued-budget-model"
            );
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should preserve registered provider selection while attributing its wire model", async () => {
        class ManualAttributionReplayHandler extends BudgetReplayHandler {
            protected override responseContent(
                _request: BudgetReplayRequest,
                requestNumber: number
            ): string {
                if (requestNumber === 1) return "INITIAL_ASSISTANT_ONLY";
                if (requestNumber === 2) return "COMPACTION_SUMMARY_ONLY";
                return "FOLLOWUP_ASSISTANT_ONLY";
            }
        }
        const handler = new ManualAttributionReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "local/selection",
                providers: [
                    {
                        name: "local",
                        type: "openai",
                        wireApi: "completions",
                        baseUrl: "https://registered-budget-replay.invalid/v1",
                        bearerToken: "fake-byok-credential-for-e2e-tests",
                    },
                ],
                models: [
                    {
                        id: "selection",
                        provider: "local",
                        modelId: "uncatalogued-budget-model",
                        wireModel: "deployment-private",
                        maxPromptTokens: 112_000,
                        maxContextWindowTokens: 128_000,
                        maxOutputTokens: 32_000,
                    },
                ],
                modelCapabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 32_000,
                    },
                },
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "Initialize manual compaction." }))?.data
                    .content
            ).toBe("INITIAL_ASSISTANT_ONLY");
            const events: SessionEvent[] = [];
            session.on((event) => {
                if (
                    event.type === "session.compaction_start" ||
                    event.type === "session.compaction_complete"
                ) {
                    events.push(event);
                }
            });
            const result = await session.rpc.history.compact({ trigger: "manual" });
            expect(result).toMatchObject({
                success: true,
                summaryContent: "COMPACTION_SUMMARY_ONLY",
                contextWindow: { tokenLimit: 96_000 },
            });
            expect(events).toHaveLength(2);
            const [start, complete] = events;
            if (
                start?.type !== "session.compaction_start" ||
                complete?.type !== "session.compaction_complete"
            ) {
                throw new Error(`Unexpected compaction event sequence: ${JSON.stringify(events)}`);
            }
            expect(start).toMatchObject({
                type: "session.compaction_start",
                data: {
                    model: "deployment-private",
                    trigger: "manual",
                    tokenLimit: 96_000,
                },
            });
            expect(start.data.compactionAttemptId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
            );
            expect(complete).toMatchObject({
                type: "session.compaction_complete",
                data: {
                    success: true,
                    compactionAttemptId: start.data.compactionAttemptId,
                    trigger: "manual",
                    tokenLimit: 96_000,
                    compactionTokensUsed: { model: "deployment-private" },
                },
            });
            expect(complete.data.model).toBeUndefined();
            expect(complete.data.initialModel).toBeUndefined();
            expect(handler.requests).toHaveLength(2);
            expect(handler.requests[1]?.model).toBe("deployment-private");
            expect(handler.requestUrls[1]).toBe(
                "https://registered-budget-replay.invalid/v1/chat/completions"
            );
            expect(
                (await session.sendAndWait({ prompt: "Continue from the compacted summary." }))
                    ?.data.content
            ).toBe("FOLLOWUP_ASSISTANT_ONLY");
            expect(handler.requests).toHaveLength(3);
            const followupRequest = handler.requests.at(-1);
            expect(followupRequest?.model).toBe("deployment-private");
            expect(handler.requestUrls[2]).toBe(
                "https://registered-budget-replay.invalid/v1/chat/completions"
            );
            const followupMessages = JSON.stringify(followupRequest?.messages);
            expect(followupMessages).toContain("COMPACTION_SUMMARY_ONLY");
            expect(followupMessages).toContain("Initialize manual compaction.");
            expect(followupMessages).toContain("Continue from the compacted summary.");
            expect(followupMessages).not.toContain("INITIAL_ASSISTANT_ONLY");
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should reject capacity-consuming output caps without an inference request", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                },
                modelCapabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 128_000,
                    },
                },
                infiniteSessions: { enabled: false },
            });
            const noCapacity =
                "Output token reservation 128000 leaves no room in the 128000-token context window";
            await expect(
                session.sendAndWait({ prompt: "Initialize an invalid context budget." })
            ).rejects.toThrow(noCapacity);
            for (const outputTokenLimit of [128_000, 0]) {
                await expect(
                    session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit })
                ).rejects.toThrow(noCapacity);
            }
            await expect(session.rpc.history.compact({ trigger: "manual" })).rejects.toThrow(
                noCapacity
            );
            const context = await session.rpc.metadata.contextInfo({
                promptTokenLimit: 0,
                outputTokenLimit: 32_000,
            });
            expect(context.contextInfo).toMatchObject({
                limit: 112_000,
                promptTokenLimit: 96_000,
            });
            expect(handler.requests).toHaveLength(0);
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should resolve model switch budgets after the next request initializes context", async () => {
        const handler = new BudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: "uncatalogued-budget-model",
                provider: {
                    type: "openai",
                    wireApi: "completions",
                    baseUrl: "https://budget-replay.invalid/v1",
                    bearerToken: "fake-byok-credential-for-e2e-tests",
                    modelId: "uncatalogued-budget-model",
                },
                modelCapabilities: {
                    limits: {
                        max_prompt_tokens: 112_000,
                        max_context_window_tokens: 128_000,
                        max_output_tokens: 32_000,
                    },
                },
                infiniteSessions: { enabled: false },
            });
            for (const promptLimit of [112_000, 100_000]) {
                if (promptLimit === 100_000) {
                    await session.setModel("uncatalogued-budget-model", {
                        modelCapabilities: {
                            limits: {
                                max_prompt_tokens: promptLimit,
                                max_context_window_tokens: 128_000,
                                max_output_tokens: 32_000,
                            },
                        },
                    });
                }
                expect(
                    (await session.sendAndWait({ prompt: "Initialize the current budget." }))?.data
                        .content
                ).toBe("BUDGET_CONTROL_OK");
                const context = await session.rpc.metadata.contextInfo({
                    promptTokenLimit: 0,
                    outputTokenLimit: 0,
                });
                expect(context.contextInfo).toMatchObject({
                    modelName: "uncatalogued-budget-model",
                    limit: promptLimit,
                    promptTokenLimit: 96_000,
                });
            }
            expect(handler.requests).toHaveLength(2);
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });

    it("should trigger compaction with low threshold and emit events", async () => {
        // Create session with very low compaction thresholds to trigger compaction quickly
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            modelCapabilities: {
                limits: {
                    max_prompt_tokens: 112_000,
                    max_context_window_tokens: 128_000,
                    max_output_tokens: 32_000,
                },
            },
            infiniteSessions: {
                enabled: true,
                // Trigger background compaction at 0.5% context usage (~1000 tokens)
                backgroundCompactionThreshold: 0.005,
                // Block at 1% to ensure compaction runs
                bufferExhaustionThreshold: 0.01,
            },
        });

        // The first prompt leaves the session below the compaction processor's minimum
        // message count. The second prompt is therefore the first deterministic point
        // at which low thresholds can trigger compaction. Register event waiters before
        // any prompts are sent so we never miss the events.
        const compactionStartedP = getNextSessionEvent(
            session,
            "session.compaction_start",
            "session.compaction_start"
        );
        const usageEvents: Extract<SessionEvent, { type: "session.usage_info" }>[] = [];
        session.on((event) => {
            if (event.type === "session.usage_info") usageEvents.push(event);
        });
        // Wait specifically for a *successful* compaction_complete so that any transient
        // failed compaction event the daemon may emit before a successful retry is ignored
        // (mirrors the dotnet/rust references).
        const compactionCompletedP = getNextSessionEvent(
            session,
            "session.compaction_complete",
            "successful session.compaction_complete",
            (event) => event.data.success
        );

        await session.sendAndWait({
            prompt: "Tell me a story about a dragon. Be detailed.",
        });
        await session.sendAndWait({
            prompt: "Continue the story with more details about the dragon's castle.",
        });

        const [startEvent, completeEvent] = await Promise.all([
            compactionStartedP,
            compactionCompletedP,
        ]);

        expect(startEvent.data.conversationTokens ?? 0).toBeGreaterThan(0);
        expect(startEvent.data.model).toBeTruthy();
        expect(startEvent.data.trigger).toBe("threshold");
        expect(startEvent.data.compactionAttemptId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
        expect(completeEvent.data.success).toBe(true);
        expect(completeEvent.data.compactionAttemptId).toBe(startEvent.data.compactionAttemptId);
        expect(completeEvent.data.compactionTokensUsed?.model ?? completeEvent.data.model).toBe(
            startEvent.data.model
        );
        expect(completeEvent.data.compactionTokensUsed).toBeDefined();
        // Replay has no prompt usage; recording must preserve the provider's value or absence.
        if (isCI) {
            expect(completeEvent.data.compactionTokensUsed?.inputTokens ?? 0).toBe(0);
        } else {
            const exchanges = await openAiEndpoint.getExchanges();
            const compactions = exchanges.filter(
                ({ compactionUsage }) =>
                    compactionUsage && compactionUsage.summary === completeEvent.data.summaryContent
            );
            expect(
                compactions,
                "Expected one provider compaction chain for the completed summary"
            ).toHaveLength(1);
            expect(completeEvent.data.compactionTokensUsed?.inputTokens).toBe(
                compactions[0].compactionUsage?.inputTokens
            );
        }
        const summary = (completeEvent.data.summaryContent ?? "").toLowerCase();
        expect(summary).toContain("<overview>");
        expect(summary).toContain("<history>");
        expect(summary).toContain("<checkpoint_title>");

        await session.sendAndWait({
            prompt: "Now describe the dragon's treasure in great detail.",
        });

        // Verify the session still works after compaction
        const answer = await session.sendAndWait({ prompt: "What was the story about?" });
        const content = (answer?.data.content ?? "").toLowerCase();
        // Should remember it was about a dragon (context preserved via summary)
        expect(content).toContain("kaedrith");
        expect(content).toContain("dragon");

        // OpenAI transports omit the output cap; Anthropic sends its advertised maximum.
        // Both must reserve the same output headroom.
        expect(usageEvents.length).toBeGreaterThan(0);
        for (const event of usageEvents) expect(event.data.tokenLimit).toBe(96_000);
        const context = await session.rpc.metadata.contextInfo({
            promptTokenLimit: 0,
            outputTokenLimit: 0,
        });
        expect(context.contextInfo).toMatchObject({ limit: 112_000, promptTokenLimit: 96_000 });
        const attribution = await session.rpc.metadata.getContextAttribution();
        expect(attribution.contextAttribution).toMatchObject({
            modelId: context.contextInfo?.modelName,
            limit: 112_000,
            promptTokenLimit: 96_000,
            bufferTokens: context.contextInfo?.bufferTokens,
            compactionThreshold: context.contextInfo?.compactionThreshold,
        });
        for (const outputTokenLimit of [-1, 32_001]) {
            await expect(
                session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit })
            ).rejects.toThrow(
                outputTokenLimit < 0
                    ? /Invalid output token limit/
                    : /exceeds the advertised maximum/
            );
        }
        const afterInvalidCaps = await session.rpc.metadata.contextInfo({
            promptTokenLimit: 0,
            outputTokenLimit: 0,
        });
        expect(afterInvalidCaps.contextInfo).toMatchObject({
            limit: 112_000,
            promptTokenLimit: 96_000,
        });
        const endpoint = {
            capi: "/chat/completions",
            "openai-completions": "/chat/completions",
            "openai-responses": "/responses",
            "anthropic-messages": "/v1/messages",
        }[testBackend];
        const requests = (await openAiEndpoint.getRequests()).filter(
            (request) => request.method === "POST" && request.url.endsWith(endpoint)
        );
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
            const body = JSON.parse(request.body);
            if (testBackend === "anthropic-messages") {
                expect(body.max_tokens).toBe(32_000);
            } else {
                expect(body).not.toHaveProperty("max_tokens");
                expect(body).not.toHaveProperty("max_output_tokens");
            }
        }
    }, 120000);

    it("should not emit compaction events when infinite sessions disabled", async () => {
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            infiniteSessions: {
                enabled: false,
            },
        });

        const compactionEvents: SessionEvent[] = [];
        session.on((event) => {
            if (
                event.type === "session.compaction_start" ||
                event.type === "session.compaction_complete"
            ) {
                compactionEvents.push(event);
            }
        });

        await session.sendAndWait({ prompt: "What is 2+2?" });

        // Should not have any compaction events when disabled
        expect(compactionEvents.length).toBe(0);
    });

    it("should return empty handoff summary for fresh session", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const result = await session.rpc.history.summarizeForHandoff();
            expect(result.summary).toBe("");
        } finally {
            await session.disconnect();
        }
    });

    it("should summarize for handoff after non-ephemeral log event", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            await session.log("handoff summary log coverage");
            const result = await session.rpc.history.summarizeForHandoff();
            expect(typeof result.summary).toBe("string");
        } finally {
            await session.disconnect();
        }
    });

    it("should report no-op when cancelling compaction without in-flight work", async () => {
        const session = await client.createSession({ onPermissionRequest: approveAll });
        try {
            const backgroundResult = await session.rpc.history.cancelBackgroundCompaction();
            const manualResult = await session.rpc.history.abortManualCompaction();

            expect(backgroundResult.cancelled).toBe(false);
            expect(manualResult.aborted).toBe(false);
        } finally {
            await session.disconnect();
        }
    });
});

describe("selected-tier model catalog", async () => {
    const { createClient } = await createSdkTestContext();
    it("should resolve selected-tier defaults and confirm a smaller-tier switch", async () => {
        const modelId = "gpt-5.4-mini";
        const targetModelId = "gpt-5.4-mini-target";
        class TierBudgetReplayHandler extends BudgetReplayHandler {
            protected override responseContent(
                _request: BudgetReplayRequest,
                requestNumber: number
            ): string {
                if (requestNumber === 1) return "TIER_INITIAL_ASSISTANT_ONLY";
                if (requestNumber === 2) return "TIER_COMPACTION_SUMMARY_ONLY";
                return "TIER_FOLLOWUP_ASSISTANT_ONLY";
            }

            protected override async sendRequest(request: Request): Promise<Response> {
                const path = new URL(request.url).pathname;
                if (path === "/models") {
                    return Response.json({
                        data: [
                            {
                                id: modelId,
                                name: "Tier budget fixture",
                                object: "model",
                                vendor: "OpenAI",
                                version: "1",
                                model_picker_enabled: true,
                                supported_endpoints: ["/chat/completions"],
                                capabilities: {
                                    type: "chat",
                                    family: modelId,
                                    tokenizer: "o200k_base",
                                    supports: { vision: false, streaming: true, tool_calls: true },
                                    limits: {
                                        max_prompt_tokens: 112_000,
                                        max_context_window_tokens: 128_000,
                                        max_output_tokens: 32_000,
                                    },
                                },
                                billing: {
                                    token_prices: {
                                        default: { max_prompt_tokens: 88_000 },
                                        long_context: { max_prompt_tokens: 112_000 },
                                    },
                                },
                            },
                            {
                                id: targetModelId,
                                name: "Tier budget target fixture",
                                object: "model",
                                vendor: "OpenAI",
                                version: "1",
                                model_picker_enabled: true,
                                supported_endpoints: ["/chat/completions"],
                                capabilities: {
                                    type: "chat",
                                    family: targetModelId,
                                    tokenizer: "o200k_base",
                                    supports: { vision: false, streaming: true, tool_calls: true },
                                    limits: {
                                        max_prompt_tokens: 112_000,
                                        max_context_window_tokens: 128_000,
                                        max_output_tokens: 64_000,
                                    },
                                },
                            },
                        ],
                    });
                }
                if (path.endsWith("/models/session")) return Response.json({});
                if (path.includes("/policy")) return Response.json({ state: "enabled" });
                return super.sendRequest(request);
            }
        }
        const handler = new TierBudgetReplayHandler();
        const budgetClient = createClient({ requestHandler: handler });
        try {
            await budgetClient.start();
            expect(
                (await budgetClient.listModels()).find((model) => model.id === modelId)
            ).toMatchObject({
                capabilities: {
                    limits: { max_prompt_tokens: 112_000 },
                },
            });
            const session = await budgetClient.createSession({
                onPermissionRequest: approveAll,
                model: modelId,
                // Exercise CAPI pricing tiers even in the provider transport matrix.
                providers: [],
                contextTier: "long_context",
                infiniteSessions: { enabled: false },
            });
            expect(
                (await session.sendAndWait({ prompt: "tier-budget-boundary ".repeat(16_384) }))
                    ?.data.content
            ).toBe("TIER_INITIAL_ASSISTANT_ONLY");
            const longContext = await session.rpc.metadata.contextInfo({
                promptTokenLimit: 0,
                outputTokenLimit: 0,
            });
            expect(longContext.contextInfo).toMatchObject({
                modelName: modelId,
                limit: 112_000,
                promptTokenLimit: 96_000,
            });
            const attribution = await session.rpc.metadata.getContextAttribution();
            expect(attribution.contextAttribution).toMatchObject({
                modelId,
                limit: 112_000,
                promptTokenLimit: 96_000,
                bufferTokens: longContext.contextInfo?.bufferTokens,
            });
            expect((await session.rpc.model.getCurrent()).contextTier).toBe("long_context");
            const target = {
                modelId: targetModelId,
                contextTier: "default",
                modelCapabilities: { limits: { max_output_tokens: 64_000 } },
                runCompactionPreflight: true,
            } as const;
            const preflight = await session.rpc.model.switchTo(target);
            expect(preflight).toMatchObject({
                status: "confirmation_required",
                modelState: { contextTier: "long_context" },
                confirmation: {
                    targetModelDisplayName: targetModelId,
                    targetLimit: 64_000,
                },
            });
            expect(preflight.confirmation?.currentTokens).toBeGreaterThan(64_000);
            expect(preflight.confirmation?.currentTokens).toBeLessThanOrEqual(88_000);
            expect(handler.requests).toHaveLength(1);
            expect(
                await session.rpc.model.switchTo({ ...target, compactionDecision: "cancel" })
            ).toMatchObject({
                status: "cancelled",
                modelState: { contextTier: "long_context" },
            });
            expect(handler.requests).toHaveLength(1);
            const compactionEvents: SessionEvent[] = [];
            session.on((event) => {
                if (
                    event.type === "session.compaction_start" ||
                    event.type === "session.compaction_complete"
                ) {
                    compactionEvents.push(event);
                }
            });
            expect(
                await session.rpc.model.switchTo({ ...target, compactionDecision: "compact" })
            ).toMatchObject({
                status: "applied",
                modelState: { modelId: targetModelId, contextTier: "default" },
            });
            expect(compactionEvents).toHaveLength(2);
            const [start, complete] = compactionEvents;
            if (
                start?.type !== "session.compaction_start" ||
                complete?.type !== "session.compaction_complete"
            ) {
                throw new Error(
                    `Unexpected model-switch compaction events: ${JSON.stringify(compactionEvents)}`
                );
            }
            expect(start).toMatchObject({
                type: "session.compaction_start",
                data: {
                    model: modelId,
                    trigger: "model_switch",
                    tokenLimit: 64_000,
                    switchTargetModel: targetModelId,
                },
            });
            expect(start.data.compactionAttemptId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
            );
            expect(complete).toMatchObject({
                type: "session.compaction_complete",
                data: {
                    success: true,
                    compactionAttemptId: start.data.compactionAttemptId,
                    trigger: "model_switch",
                    tokenLimit: 64_000,
                    switchTargetModel: targetModelId,
                    compactionTokensUsed: { model: modelId },
                    summaryContent: "TIER_COMPACTION_SUMMARY_ONLY",
                },
            });
            expect(handler.requests).toHaveLength(2);
            expect(handler.requests[1]?.model).toBe(modelId);
            expect(
                (await session.sendAndWait({ prompt: "Check the compacted default tier." }))?.data
                    .content
            ).toBe("TIER_FOLLOWUP_ASSISTANT_ONLY");
            const defaultContext = await session.rpc.metadata.contextInfo({
                promptTokenLimit: 0,
                outputTokenLimit: 0,
            });
            expect(defaultContext.contextInfo).toMatchObject({
                modelName: targetModelId,
                limit: 112_000,
                promptTokenLimit: 64_000,
            });
            expect(handler.requests).toHaveLength(3);
            const followupRequest = handler.requests[2];
            expect(followupRequest?.model).toBe(targetModelId);
            const followupMessages = JSON.stringify(followupRequest?.messages);
            expect(followupMessages).toContain("TIER_COMPACTION_SUMMARY_ONLY");
            expect(followupMessages).toContain("tier-budget-boundary");
            expect(followupMessages).toContain("Check the compacted default tier.");
            expect(followupMessages).not.toContain("TIER_INITIAL_ASSISTANT_ONLY");
            await session.disconnect();
        } finally {
            await budgetClient.stop();
        }
    });
});

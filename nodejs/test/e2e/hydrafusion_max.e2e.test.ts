/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    approveAll,
    defineTool,
    CopilotRequestHandler,
    RuntimeConnection,
    type SessionEvent,
} from "../../src/index.js";
import {
    createSdkTestContext,
    DEFAULT_GITHUB_TOKEN,
    getLegacyCliPathForTests,
} from "./harness/sdkTestContext.js";
import { isByokBackend } from "./harness/testBackend.js";

const MODEL = "gpt-5.6-sol";
const REPLY = "SDK_HYDRAFUSION_MAX_DONE: Au";

interface ChatToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

interface ChatMessage {
    role: string;
    content?: unknown;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
}

interface ChatRequest {
    model?: string;
    stream?: boolean;
    messages: ChatMessage[];
}

class FusionRequestHandler extends CopilotRequestHandler {
    readonly plans: unknown[] = [];
    readonly inference: ChatRequest[] = [];

    constructor(
        private readonly reply: (request: ChatRequest) => ChatMessage = () => ({
            role: "assistant",
            content: REPLY,
        })
    ) {
        super();
    }

    protected override async sendRequest(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/models") {
            return Response.json({
                data: [
                    {
                        id: MODEL,
                        name: MODEL,
                        model_picker_enabled: true,
                        policy: { state: "enabled" },
                        supported_endpoints: ["/chat/completions"],
                        capabilities: {
                            supports: { streaming: true, tool_calls: true, vision: true },
                            limits: {
                                max_prompt_tokens: 128000,
                                max_output_tokens: 16384,
                                max_context_window_tokens: 144384,
                            },
                        },
                    },
                ],
            });
        }
        if (path === "/model/fusion") {
            this.plans.push(await request.json());
            return Response.json({
                fusion_mode: "hydrafusion-max",
                fusion_pattern: "solo",
                plan_version: "2",
                steps: [{ role: "generation", model_id: MODEL }],
                session: { token: "jwt.fake.sdk.max.plan", expires_at: 0 },
            });
        }
        if (path === "/chat/completions") {
            const body = (await request.json()) as ChatRequest;
            this.inference.push(body);
            if (body.model !== MODEL) {
                throw new Error(`Expected concrete Fusion constituent, received ${body.model}`);
            }
            const message = this.reply(body);
            const finishReason = message.tool_calls ? "tool_calls" : "stop";
            const completion = {
                id: "chatcmpl-sdk-max",
                object: "chat.completion",
                created: 0,
                model: MODEL,
                choices: [{ index: 0, message, finish_reason: finishReason }],
                usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            };
            if (!body.stream) return Response.json(completion);
            return new Response(
                `data: ${JSON.stringify({
                    ...completion,
                    object: "chat.completion.chunk",
                    choices: [
                        {
                            index: 0,
                            delta: {
                                ...message,
                                ...(message.tool_calls
                                    ? {
                                          tool_calls: message.tool_calls.map((call, index) => ({
                                              index,
                                              ...call,
                                          })),
                                      }
                                    : {}),
                            },
                            finish_reason: finishReason,
                        },
                    ],
                })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } }
            );
        }
        if (path === "/models/session/intent") {
            return Response.json({ error: "Intent unavailable in this fixture" }, { status: 404 });
        }
        if (path === "/models/session") {
            return Response.json({
                available_models: [MODEL],
                selected_model: MODEL,
                session_token: "jwt.fake.sdk.max.routing",
                expires_at: 0,
            });
        }
        throw new Error(`Unexpected model request: ${request.method} ${path}`);
    }
}

describe.skipIf(isByokBackend).each([false, true])(
    "HydraFusion Max plan-v2 gate: %s",
    async (enabled) => {
        const handler = new FusionRequestHandler();
        const { copilotClient: client, workDir } = await createSdkTestContext({
            copilotClientOptions: {
                gitHubToken: DEFAULT_GITHUB_TOKEN,
                requestHandler: handler,
                env: {
                    HYDRAFUSION: "true",
                    HYDRAFUSION_ROLLOUT: "true",
                    HYDRAFUSION_PLAN_V2: String(enabled),
                    COPILOT_EXP_COPILOT_CLI_HYDRAFUSION_PLAN_V2: String(enabled),
                },
            },
        });

        if (!enabled) {
            it.each([false, true])(
                "rejects public SDK creation before inference (provider=%s)",
                async (providerPresent) => {
                    await expect(
                        client.createSession({
                            model: "hydrafusion-max",
                            enableExperimentalMode: true,
                            workingDirectory: workDir,
                            onPermissionRequest: approveAll,
                            ...(providerPresent
                                ? {
                                      provider: {
                                          baseUrl: "https://provider.example.invalid",
                                          apiKey: "fixture-key",
                                      },
                                  }
                                : {}),
                        })
                    ).rejects.toThrow('Model "hydrafusion-max" is not available.');
                    expect(handler.plans).toEqual([]);
                    expect(handler.inference).toEqual([]);
                }
            );

            describe.skipIf(isByokBackend).each(["native", "legacy"] as const)(
                "HydraFusion Max session flags (%s)",
                async (transport) => {
                    const handler = new FusionRequestHandler();
                    const { copilotClient: client, workDir } = await createSdkTestContext({
                        copilotClientOptions: {
                            connection: RuntimeConnection.forStdio({
                                path:
                                    transport === "legacy"
                                        ? await getLegacyCliPathForTests()
                                        : process.env.COPILOT_CLI_PATH,
                            }),
                            gitHubToken: DEFAULT_GITHUB_TOKEN,
                            requestHandler: handler,
                            env: {
                                HYDRAFUSION: "true",
                                HYDRAFUSION_ROLLOUT: "true",
                                HYDRAFUSION_PLAN_V2: "false",
                                COPILOT_EXP_COPILOT_CLI_HYDRAFUSION_PLAN_V2: "false",
                            },
                        },
                    });

                    it("enables Max for one session without enabling it for the host", async () => {
                        const options = {
                            model: "hydrafusion-max",
                            enableExperimentalMode: true,
                            workingDirectory: workDir,
                            onPermissionRequest: approveAll,
                        };
                        const session = await client.createSession({
                            ...options,
                            featureFlags: {
                                HYDRAFUSION: true,
                                HYDRAFUSION_ROLLOUT: true,
                                HYDRAFUSION_PLAN_V2: true,
                            },
                        });
                        const events: SessionEvent[] = [];
                        const unsubscribe = session.on((event) => events.push(event));
                        try {
                            const reply = await session.sendAndWait({
                                prompt: "What is the chemical symbol for gold? Do not use tools.",
                            });
                            expect(reply?.data.content).toBe(REPLY);
                            expect(handler.plans).toEqual([
                                expect.objectContaining({
                                    fusion_mode: "hydrafusion-max",
                                    plan_version: "2",
                                }),
                            ]);
                            expect(events).toEqual(
                                expect.arrayContaining([
                                    expect.objectContaining({
                                        type: "session.fusion_resolved",
                                        data: expect.objectContaining({
                                            syntheticModel: "hydrafusion-max",
                                            policy: "max",
                                            planVersion: "2",
                                        }),
                                    }),
                                ])
                            );
                            await expect(client.createSession(options)).rejects.toThrow(
                                'Model "hydrafusion-max" is not available.'
                            );
                        } finally {
                            unsubscribe();
                            await session.disconnect();
                        }
                    });
                }
            );
        } else {
            it("creates Max through the public SDK and executes a concrete v2 plan", async () => {
                const session = await client.createSession({
                    model: "hydrafusion-max",
                    enableExperimentalMode: true,
                    workingDirectory: workDir,
                    onPermissionRequest: approveAll,
                });
                const events: SessionEvent[] = [];
                const unsubscribe = session.on((event) => events.push(event));
                try {
                    const reply = await session.sendAndWait({
                        prompt: "What is the chemical symbol for gold? Do not use tools.",
                    });
                    expect(reply?.data.content).toBe(REPLY);
                    expect(handler.plans).toEqual([
                        expect.objectContaining({
                            fusion_mode: "hydrafusion-max",
                            plan_version: "2",
                        }),
                    ]);
                    expect(handler.inference.length).toBeGreaterThan(0);
                    expect(events).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                type: "session.fusion_resolved",
                                data: expect.objectContaining({
                                    syntheticModel: "hydrafusion-max",
                                    policy: "max",
                                    planVersion: "2",
                                }),
                            }),
                        ])
                    );
                } finally {
                    unsubscribe();
                    await session.disconnect();
                }
            });
        }
    }
);

const DRAFT_NOTE = "FUSION_DRAFT_NOTE_BEFORE_STOP";
const RECORD_CALL_ID = "call_fusion_record_progress";
const RECORD_RESULT = "FUSION_PROGRESS_RECORDED";
const WAIT_CALL_ID = "call_fusion_wait_for_stop";
const FOLLOW_UP_PROMPT = "FUSION_FOLLOW_UP_AFTER_STOP: continue where you left off.";
const FOLLOW_UP_REPLY = "FUSION_FOLLOW_UP_DONE";

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part?.text === "string" ? (part.text as string) : ""))
            .join("");
    }
    return "";
}

// The draft writes a note and finishes one tool call, then blocks in a second one until the
// user stops the turn. The follow-up turn answers once it sees the user's next prompt.
function interruptedDraftReply(request: ChatRequest): ChatMessage {
    if (
        request.messages.some((message) => messageText(message.content).includes(FOLLOW_UP_PROMPT))
    ) {
        return { role: "assistant", content: FOLLOW_UP_REPLY };
    }
    const recorded = request.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === RECORD_CALL_ID
    );
    const call = (id: string, name: string, args: object): ChatToolCall => ({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
    });
    return recorded
        ? { role: "assistant", content: "", tool_calls: [call(WAIT_CALL_ID, "wait_for_stop", {})] }
        : {
              role: "assistant",
              content: DRAFT_NOTE,
              tool_calls: [call(RECORD_CALL_ID, "record_progress", { note: "alpha" })],
          };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

describe.skipIf(isByokBackend)("HydraFusion interrupted turn", async () => {
    const handler = new FusionRequestHandler(interruptedDraftReply);
    const { copilotClient: client, workDir } = await createSdkTestContext({
        copilotClientOptions: {
            gitHubToken: DEFAULT_GITHUB_TOKEN,
            requestHandler: handler,
            env: {
                HYDRAFUSION: "true",
                HYDRAFUSION_ROLLOUT: "true",
                HYDRAFUSION_PLAN_V2: "true",
                COPILOT_EXP_COPILOT_CLI_HYDRAFUSION_PLAN_V2: "true",
                HYDRAFUSION_INTERRUPTED_COMMIT: "true",
            },
        },
    });

    it("keeps the stopped draft's work in history and in the next turn", async () => {
        let markWaitStarted!: () => void;
        const waitStarted = new Promise<void>((resolve) => {
            markWaitStarted = resolve;
        });
        let releaseWait!: () => void;
        const waitReleased = new Promise<void>((resolve) => {
            releaseWait = resolve;
        });
        const session = await client.createSession({
            model: "hydrafusion-max",
            enableExperimentalMode: true,
            workingDirectory: workDir,
            onPermissionRequest: approveAll,
            tools: [
                defineTool("record_progress", {
                    description: "Records a progress note.",
                    parameters: z.object({ note: z.string() }),
                    handler: async () => RECORD_RESULT,
                }),
                defineTool("wait_for_stop", {
                    description: "Blocks until released.",
                    parameters: z.object({}),
                    handler: async (_args, invocation) => {
                        markWaitStarted();
                        await new Promise<void>((resolve) => {
                            void waitReleased.then(resolve);
                            invocation.signal?.addEventListener("abort", () => resolve(), {
                                once: true,
                            });
                        });
                        return "RELEASED_AFTER_STOP";
                    },
                }),
            ],
        });
        let stopRequested = false;
        let markStoppedIdle!: () => void;
        const stoppedIdle = new Promise<void>((resolve) => {
            markStoppedIdle = resolve;
        });
        const unsubscribe = session.on((event) => {
            if (stopRequested && event.type === "session.idle") markStoppedIdle();
        });
        try {
            void session.send({ prompt: "Record progress, then wait for the stop signal." });
            await withTimeout(waitStarted, 60_000, "wait_for_stop start");
            stopRequested = true;
            await session.abort();
            releaseWait();
            await withTimeout(stoppedIdle, 60_000, "idle after stop");

            const history = await session.getEvents();
            const commit = history.find((event) => event.type === "session.fusion_commit_started");
            expect(commit?.data).toMatchObject({
                commitId: expect.stringMatching(/:commit:interrupted:0$/),
            });
            const commitId = (commit?.data as { commitId: string }).commitId;
            const committed = history.filter(
                (event) =>
                    (event.data as { fusion?: { commitId?: string } }).fusion?.commitId === commitId
            );
            expect(committed).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "assistant.message",
                        data: expect.objectContaining({ content: DRAFT_NOTE }),
                    }),
                    expect.objectContaining({
                        type: "tool.execution_complete",
                        data: expect.objectContaining({
                            toolCallId: RECORD_CALL_ID,
                            success: true,
                        }),
                    }),
                ])
            );
            expect(history.some((event) => event.type === "session.fusion_completed")).toBe(false);

            const reply = await session.sendAndWait({ prompt: FOLLOW_UP_PROMPT });
            expect(reply?.data.content).toBe(FOLLOW_UP_REPLY);
            const followUp = handler.inference.find((request) =>
                request.messages.some((message) =>
                    messageText(message.content).includes(FOLLOW_UP_PROMPT)
                )
            );
            const messages = followUp?.messages ?? [];
            const followUpIndex = messages.findIndex((message) =>
                messageText(message.content).includes(FOLLOW_UP_PROMPT)
            );
            const earlier = messages.slice(0, followUpIndex);
            expect(
                earlier.some(
                    (message) =>
                        message.role === "assistant" &&
                        messageText(message.content).includes(DRAFT_NOTE)
                )
            ).toBe(true);
            expect(
                earlier.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? [])
            ).toEqual(expect.arrayContaining([RECORD_CALL_ID, WAIT_CALL_ID]));
            const results = new Map(
                earlier
                    .filter((message) => message.role === "tool")
                    .map((message) => [message.tool_call_id, messageText(message.content)])
            );
            expect(results.get(RECORD_CALL_ID)).toContain(RECORD_RESULT);
            expect(results.has(WAIT_CALL_ID)).toBe(true);
        } finally {
            releaseWait();
            unsubscribe();
            await session.disconnect();
        }
    });
});

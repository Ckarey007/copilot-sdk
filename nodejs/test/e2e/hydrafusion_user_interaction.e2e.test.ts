/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, onTestFinished } from "vitest";
import {
    approveAll,
    CopilotRequestHandler,
    type CopilotSession,
    type PermissionHandler,
    type SessionEvent,
} from "../../src/index.js";
import { createSdkTestContext, DEFAULT_GITHUB_TOKEN } from "./harness/sdkTestContext.js";
import { isByokBackend } from "./harness/testBackend.js";

const WEAK = "gpt-5.6-luna";
const STRONG = "gpt-5.6-sol";
const JUDGE_MARKER = "read-only judge in a HydraFusion Cascade";
const REPAIR_MARKER = "HydraFusion Cascade strong-repair handoff.";
const USER_ANSWER = "SDK_HYDRAFUSION_USER_ANSWER_TEAL";
const PRIMARY_REPLY = "SDK_HYDRAFUSION_PRIMARY_REPLY";
const REPAIR_REPLY = "SDK_HYDRAFUSION_REPAIR_REPLY";
const FUSION_COMPLETED_TIMEOUT_MS = 60_000;

type ChatMessage = { role?: string; content?: unknown };
type ChatRequest = {
    model?: string;
    stream?: boolean;
    messages?: ChatMessage[];
    tools?: Array<{ function?: { name?: string } }>;
};
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type AssistantMessage = { role: "assistant"; content: string; tool_calls?: ToolCall[] };

/**
 * Serves one Cascade turn. The primary makes `firstCall` (built from the
 * request's tool list), then replies with text; the judge always rejects so
 * any review that runs escalates to the repair.
 */
class CascadeHandler extends CopilotRequestHandler {
    primary: ChatRequest[] = [];
    judge: ChatRequest[] = [];
    repair: ChatRequest[] = [];
    private firstCall: (request: ChatRequest) => ToolCall = () => {
        throw new Error("No primary tool call scripted");
    };

    script(firstCall: (request: ChatRequest) => ToolCall): void {
        this.firstCall = firstCall;
        this.primary = [];
        this.judge = [];
        this.repair = [];
    }

    protected override async sendRequest(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/models") {
            return Response.json({ data: [WEAK, STRONG].map(modelInfo) });
        }
        if (path === "/model/fusion") {
            return Response.json({
                fusion_mode: "hydrafusion-max",
                fusion_pattern: "cascade",
                plan_version: "2",
                steps: [
                    { role: "draft", model_id: WEAK },
                    { role: "escalation", model_id: STRONG },
                    { role: "repair", model_id: STRONG },
                ],
                session: { token: "jwt.fake.sdk.user-interaction.plan", expires_at: 0 },
            });
        }
        if (path === "/models/session/intent") {
            return Response.json({ error: "Intent unavailable in this fixture" }, { status: 404 });
        }
        if (path === "/models/session") {
            return Response.json({
                available_models: [WEAK, STRONG],
                selected_model: WEAK,
                session_token: "jwt.fake.sdk.user-interaction.routing",
                expires_at: 0,
            });
        }
        if (path === "/chat/completions") {
            const body = (await request.json()) as ChatRequest;
            return reply(body, this.answer(body));
        }
        throw new Error(`Unexpected model request: ${request.method} ${path}`);
    }

    private answer(body: ChatRequest): AssistantMessage {
        const transcript = JSON.stringify(body.messages ?? []);
        if (transcript.includes(JUDGE_MARKER)) {
            this.judge.push(body);
            return {
                role: "assistant",
                content: JSON.stringify({
                    score: 1,
                    rationale: "The solver did not finish the task. Escalate it.",
                }),
            };
        }
        if (transcript.includes(REPAIR_MARKER)) {
            this.repair.push(body);
            return { role: "assistant", content: REPAIR_REPLY };
        }
        if (body.model !== WEAK) {
            throw new Error(`Expected the primary on ${WEAK}, received ${body.model}`);
        }
        this.primary.push(body);
        if (body.messages?.some((message) => message.role === "tool")) {
            return { role: "assistant", content: PRIMARY_REPLY };
        }
        return { role: "assistant", content: "", tool_calls: [this.firstCall(body)] };
    }
}

function modelInfo(id: string) {
    return {
        id,
        name: id,
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
    };
}

function reply(body: ChatRequest, message: AssistantMessage): Response {
    const finishReason = message.tool_calls ? "tool_calls" : "stop";
    const completion = {
        id: "chatcmpl-sdk-hydrafusion-user-interaction",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };
    if (!body.stream) return Response.json(completion);
    const delta = {
        ...message,
        ...(message.tool_calls
            ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
            : {}),
    };
    const chunk = {
        ...completion,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
    });
}

function call(id: string, name: string, args: object): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function shellCall(request: ChatRequest): ToolCall {
    const names = request.tools?.map((tool) => tool.function?.name) ?? [];
    const shell = names.find((name) => name === "bash" || name === "powershell");
    if (!shell) throw new Error(`No shell tool offered to the primary: ${names.join(", ")}`);
    return call("sdk-hydrafusion-denied-shell", shell, {
        command: "echo SDK_HYDRAFUSION_DENIED",
        description: "Print a marker",
    });
}

function waitForFusionCompleted(session: CopilotSession): Promise<SessionEvent> {
    return new Promise<SessionEvent>((resolve, reject) => {
        let unsubscribe: () => void = () => {};
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("Timed out waiting for session.fusion_completed"));
        }, FUSION_COMPLETED_TIMEOUT_MS);
        unsubscribe = session.on((event) => {
            if (event.type === "session.fusion_completed") {
                clearTimeout(timer);
                unsubscribe();
                resolve(event);
            } else if (event.type === "session.error") {
                clearTimeout(timer);
                unsubscribe();
                reject(new Error(`${event.data.message}\n${event.data.stack ?? ""}`));
            }
        });
    });
}

describe.skipIf(isByokBackend)("HydraFusion user interaction during a phase", async () => {
    const handler = new CascadeHandler();
    const { copilotClient: client, workDir } = await createSdkTestContext({
        copilotClientOptions: {
            gitHubToken: DEFAULT_GITHUB_TOKEN,
            requestHandler: handler,
            env: {
                HYDRAFUSION: "true",
                HYDRAFUSION_ROLLOUT: "true",
                HYDRAFUSION_PLAN_V2: "true",
                COPILOT_EXP_COPILOT_CLI_HYDRAFUSION_PLAN_V2: "true",
            },
        },
    });

    async function runCascadeTurn(
        onPermissionRequest: PermissionHandler,
        prompt: string
    ): Promise<SessionEvent[]> {
        const session = await client.createSession({
            model: "hydrafusion-max",
            enableExperimentalMode: true,
            workingDirectory: workDir,
            onPermissionRequest,
            onUserInputRequest: async () => ({ answer: USER_ANSWER, wasFreeform: true }),
        });
        onTestFinished(async () => {
            await session.disconnect();
        });
        const completed = waitForFusionCompleted(session);
        await session.send({ prompt });
        await completed;
        return session.getEvents();
    }

    it("ends the turn when the user rejects the primary's tool call", async () => {
        handler.script(shellCall);
        const events = await runCascadeTurn(
            (request, invocation) =>
                request.kind === "shell" ? { kind: "reject" } : approveAll(request, invocation),
            "Print a marker with the shell."
        );

        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "tool.execution_complete",
                    data: expect.objectContaining({
                        toolCallId: "sdk-hydrafusion-denied-shell",
                        success: false,
                        error: expect.objectContaining({ code: "rejected" }),
                    }),
                }),
            ])
        );
        // The rejection stops the primary, as it stops a non-Fusion turn. No
        // review or repair may restart the work the user just stopped.
        expect(handler.primary).toHaveLength(1);
        expect(handler.judge).toHaveLength(0);
        expect(handler.repair).toHaveLength(0);
    });

    it("gives the judge and the repair the answer the user gave the primary", async () => {
        handler.script(() =>
            call("sdk-hydrafusion-ask-user", "ask_user", { question: "Which color?" })
        );
        await runCascadeTurn(approveAll, "Ask me for a color, then finish.");

        expect(handler.primary).toHaveLength(2);
        expect(handler.judge).toHaveLength(1);
        expect(handler.repair).toHaveLength(1);
        expect(JSON.stringify(handler.judge[0].messages)).toContain(USER_ANSWER);
        expect(JSON.stringify(handler.repair[0].messages)).toContain(USER_ANSWER);
    });
});

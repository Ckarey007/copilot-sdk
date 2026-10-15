/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
    approveAll,
    CopilotRequestHandler,
    type CopilotRequestContext,
    defineTool,
} from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const responsesFixture = new URL(
    "../../../test/snapshots/context_tool_budget/native_responses.json",
    import.meta.url
);

// The CAPI replay proxy supports Chat Completions, not native client tool search.
// Retain actual Responses outputs rather than converting away native tool items.
class NativeBudgetResponses extends CopilotRequestHandler {
    readonly requests: Array<{
        model: string;
        input?: Array<{ type?: string; tools?: unknown[] }>;
        tools?: unknown[];
    }> = [];
    readonly responses: string[] = [];
    readonly recording = process.env.COPILOT_SDK_RECORD_NATIVE_RESPONSES === "true";

    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext
    ): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/responses" && request.method === "POST") {
            const requestBody = (await request.clone().json()) as (typeof this.requests)[number];
            const index = this.requests.push(requestBody) - 1;
            let body: string;
            if (this.recording) {
                const upstream = new Request(
                    new URL(url.pathname, "https://api.githubcopilot.com"),
                    request
                );
                upstream.headers.delete("host");
                const response = await super.sendRequest(upstream, context);
                if (!response.ok) return response;
                const captured = (await response.json()) as Record<string, unknown>;
                // Account attribution and echoed request tools are not replay inputs.
                delete captured.safety_identifier;
                delete captured.copilot_usage;
                delete captured.tools;
                body = JSON.stringify(captured);
                this.responses[index] = body;
            } else {
                const recorded: unknown[] = JSON.parse(await readFile(responsesFixture, "utf8"));
                const recordedBody = recorded[index];
                if (typeof recordedBody !== "string") {
                    throw new Error("No recorded native budget response.");
                }
                body = recordedBody;
                this.responses[index] = body;
            }
            return new Response(body, { headers: { "content-type": "application/json" } });
        }

        const response = await super.sendRequest(request, context);
        if (!response.ok || url.pathname !== "/models") return response;
        const catalog = (await response.json()) as {
            data: Array<{ id: string; supported_endpoints?: string[] }>;
        };
        for (const model of catalog.data) {
            if (model.id === "gpt-6.1-sol") model.supported_endpoints = ["/responses"];
        }
        return Response.json(catalog);
    }
}

describe("Context-management tool budgeting", async () => {
    const nativeResponses = new NativeBudgetResponses();
    const { copilotClient: client } = await createSdkTestContext({
        backend: "capi",
        replayOnly: true,
        copilotClientOptions: { requestHandler: nativeResponses },
    });

    it("keeps deferred request definitions out of the recovery budget", async () => {
        const conversationGrowth: number[] = [];
        for (const descriptionSize of [1, 512]) {
            const requestStart = nativeResponses.requests.length;
            const description = "Deferred schema budget fixture. ".repeat(descriptionSize);
            let fixtureCalls = 0;
            const session = await client.createSession({
                model: "gpt-6.1-sol",
                featureFlags: { CONTEXT_MANAGEMENT_TOOLS: true },
                toolSearch: { enabled: true, deferThreshold: 0 },
                onPermissionRequest: approveAll,
                tools: [
                    defineTool<{ pattern: string }>("tool_search_tool", {
                        description: "Find registered tools by a regular-expression pattern.",
                        parameters: {
                            type: "object",
                            properties: { pattern: { type: "string" } },
                            required: ["pattern"],
                        },
                        overridesBuiltInTool: true,
                        handler: ({ pattern }) => ({
                            resultType: "success",
                            textResultForLlm: "",
                            toolReferences: ["context_budget_fixture"].filter((name) =>
                                new RegExp(pattern, "i").test(name)
                            ),
                        }),
                    }),
                    defineTool("context_budget_fixture", {
                        description,
                        parameters: { type: "object", properties: {} },
                        defer: "auto",
                        handler: () => {
                            fixtureCalls++;
                            return "UNUSED_BUDGET_FIXTURE";
                        },
                    }),
                ],
            });
            const toolCalls: string[] = [];
            session.on("tool.execution_start", (event) => toolCalls.push(event.data.toolName));
            try {
                const response = await session.sendAndWait({
                    prompt: "Reply with only CONTEXT_BUDGET_READY. Do not call tools.",
                });
                expect(response?.data.content).toContain("CONTEXT_BUDGET_READY");
                const request = await session.rpc.metadata.contextInfo({
                    promptTokenLimit: 0,
                    outputTokenLimit: 0,
                });
                expect(request.contextInfo?.modelName).toBe("gpt-6.1-sol");
                const result = await session.rpc.tools.execute({
                    name: "get_context_remaining",
                    arguments: {},
                });
                expect(result, JSON.stringify(result)).toMatchObject({ resultType: "success" });
                if (typeof result === "string") throw new Error("Expected a structured result.");
                const status = JSON.parse(result.textResultForLlm);
                expect(status.context_info.toolDefinitionsTokens).toBe(
                    request.contextInfo?.toolDefinitionsTokens
                );
                expect(status.new_context_frees_space).toBe(true);
                expect(status.tokens_left).toBeGreaterThan(
                    status.context_info.promptTokenLimit / 2
                );
                expect(nativeResponses.requests[requestStart].tools).toContainEqual(
                    expect.objectContaining({ type: "tool_search", execution: "client" })
                );

                const searched = await session.sendAndWait({
                    prompt: "Use the client tool_search to retrieve the full definition of context_budget_fixture. Wait for the search result before replying. Do not invoke context_budget_fixture. After searching, reply with only CONTEXT_BUDGET_LOADED.",
                });
                expect(searched?.data.content).toContain("CONTEXT_BUDGET_LOADED");
                expect(toolCalls).toContain("tool_search_tool");
                const loaded = await session.rpc.tools.execute({
                    name: "get_context_remaining",
                    arguments: {},
                });
                expect(loaded, JSON.stringify(loaded)).toMatchObject({ resultType: "success" });
                if (typeof loaded === "string") throw new Error("Expected a structured result.");
                const loadedStatus = JSON.parse(loaded.textResultForLlm);
                expect(loadedStatus.context_info.conversationTokens).toBeGreaterThan(
                    status.context_info.conversationTokens
                );
                conversationGrowth.push(
                    loadedStatus.context_info.conversationTokens -
                        status.context_info.conversationTokens
                );
                const modelRequests = nativeResponses.requests.slice(requestStart);
                expect(modelRequests.length).toBeGreaterThan(0);
                expect(modelRequests.every((body) => body.model === "gpt-6.1-sol")).toBe(true);
                expect(
                    modelRequests.some(
                        (body) =>
                            Array.isArray(body.input) &&
                            body.input.some(
                                (item: { type?: string }) => item.type === "tool_search_output"
                            )
                    )
                ).toBe(true);
                const searchOutputs = modelRequests.flatMap((body) =>
                    (body.input ?? []).filter((item) => item.type === "tool_search_output")
                );
                expect(searchOutputs.flatMap((item) => item.tools ?? [])).toContainEqual(
                    expect.objectContaining({
                        name: "context_budget_fixture",
                        description,
                        parameters: { type: "object", properties: {} },
                    })
                );
                expect(fixtureCalls).toBe(0);
            } finally {
                await session.disconnect();
            }
        }
        // Prompt/result text alone must not satisfy loaded-schema accounting.
        expect(conversationGrowth[1] - conversationGrowth[0]).toBeGreaterThan(1024);
        if (nativeResponses.recording) {
            for (const index of nativeResponses.requests.keys()) {
                expect(nativeResponses.responses[index]).toBeTypeOf("string");
            }
            await writeFile(
                responsesFixture,
                JSON.stringify(nativeResponses.responses, null, 2) + "\n"
            );
        }
    });
});

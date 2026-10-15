/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
    approveAll,
    CopilotRequestHandler,
    type CopilotClient,
    type CopilotRequestContext,
    type SessionEvent,
    type UserPromptTransformedHookInput,
} from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { withFinalAssistantMessage } from "./harness/sdkTestHelper.js";

const MODEL = "gpt-image-2.5-sunburst";
const FINAL = "IMAGE_EDIT_SDK_FINISHED";
const GENERATION_NANO_AIU = 598_500_000;
const EDIT_NANO_AIU = 854_000_000;

function imageServiceUsage(edit: boolean) {
    const textTokens = edit ? 20 : 21;
    const imageTokens = edit ? 320 : 0;
    return {
        usage: {
            input_tokens: textTokens + imageTokens,
            output_tokens: 196,
            total_tokens: textTokens + imageTokens + 196,
            input_tokens_details: { text_tokens: textTokens, image_tokens: imageTokens },
            output_tokens_details: { text_tokens: 0, image_tokens: 196 },
        },
        copilot_usage: {
            total_nano_aiu: edit ? EDIT_NANO_AIU : GENERATION_NANO_AIU,
            token_details: [
                {
                    token_type: "input",
                    token_count: textTokens,
                    batch_size: 1_000_000,
                    cost_per_batch: 500_000_000_000,
                    model: MODEL,
                },
                ...(edit
                    ? [
                          {
                              token_type: "image_input",
                              token_count: imageTokens,
                              batch_size: 1_000_000,
                              cost_per_batch: 800_000_000_000,
                              model: MODEL,
                          },
                      ]
                    : []),
                {
                    token_type: "image_output",
                    token_count: 196,
                    batch_size: 1_000_000,
                    cost_per_batch: 3_000_000_000_000,
                    model: MODEL,
                },
            ],
        },
    };
}

function png(red: number, width = 1): string {
    function chunk(name: string, data: Buffer): Buffer {
        const payload = Buffer.concat([Buffer.from(name), data]);
        let crc = 0xffffffff;
        for (const byte of payload) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
            }
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([length, payload, checksum]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 2;
    const pixels = Buffer.alloc(1 + width * 3);
    for (let column = 0; column < width; column++) {
        pixels[1 + column * 3] = red;
    }
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64");
}

function imageId(data: string): string {
    return `sha256:${createHash("sha256").update(Buffer.from(data, "base64")).digest("hex")}`;
}

const SOURCE = png(20);
const EDITED = png(200);

class ImageHandler extends CopilotRequestHandler {
    readonly edits: Array<Record<string, unknown>> = [];
    readonly generations: Array<Record<string, unknown>> = [];
    readonly chats: Array<Record<string, unknown>> = [];
    outputImage = EDITED;
    supportedEndpoints = ["/v1/images/generations", "/v1/images/edits"];
    nextArguments: Record<string, unknown> | undefined;
    imageResultOverrides: Record<string, unknown> = {};
    private calls = 0;

    protected override async sendRequest(
        request: Request,
        _context: CopilotRequestContext
    ): Promise<Response> {
        const path = new URL(request.url).pathname;
        const body: Record<string, unknown> = request.body ? await request.json() : {};
        if (path.endsWith("/models")) {
            return Response.json({
                data: [
                    {
                        id: MODEL,
                        name: "Image test",
                        capabilities: { type: "image" },
                        supported_endpoints: this.supportedEndpoints,
                        model_picker_enabled: false,
                        policy: { state: "enabled" },
                    },
                ],
            });
        }
        if (path.endsWith("/models/session") || path.includes("/policy")) {
            return Response.json({ state: "enabled" });
        }
        if (path === "/v1/images/edits" || path === "/v1/images/generations") {
            (path.endsWith("/edits") ? this.edits : this.generations).push(body);
            return Response.json({
                created: 1,
                data: [{ b64_json: this.outputImage }],
                output_format: "png",
                ...imageServiceUsage(path.endsWith("/edits")),
                ...this.imageResultOverrides,
            });
        }
        if (path.endsWith("/chat/completions")) {
            this.chats.push(body);
            const args = this.nextArguments;
            this.nextArguments = undefined;
            const toolCalls = args
                ? [
                      {
                          id: `image-edit-${++this.calls}`,
                          type: "function",
                          function: { name: "image_generation", arguments: JSON.stringify(args) },
                      },
                  ]
                : undefined;
            const message = {
                role: "assistant",
                content: args ? null : FINAL,
                tool_calls: toolCalls,
            };
            const finish = args ? "tool_calls" : "stop";
            if (body.stream === true) {
                const delta = {
                    ...message,
                    tool_calls: toolCalls?.map((call, index) => ({ index, ...call })),
                };
                return new Response(
                    [
                        `data: ${JSON.stringify({ id: "image-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
                        `data: ${JSON.stringify({ id: "image-chat", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
                        "data: [DONE]\n\n",
                    ].join(""),
                    { headers: { "content-type": "text/event-stream" } }
                );
            }
            return Response.json({
                id: "image-chat",
                object: "chat.completion",
                model: "image-edit-chat",
                choices: [{ index: 0, message, finish_reason: finish }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
        }
        throw new Error(`Unexpected image test request: ${request.method} ${path}`);
    }
}

describe("Native image editing", async () => {
    const { createClient, env, openAiEndpoint } = await createSdkTestContext({
        copilotClientOptions: { env: { IMAGE_GENERATION_TOOL: "true" } },
    });
    async function readPersistedAssets(client: CopilotClient, sessionId: string) {
        // Binary assets are internal persistence records, not public SDK events.
        await client.rpc.sessions.save({ sessionId });
        const log = await readFile(
            join(env.COPILOT_HOME, "session-state", sessionId, "events.jsonl"),
            "utf8"
        );
        return log
            .trim()
            .split("\n")
            .map((line): SessionEvent => JSON.parse(line))
            .filter((event) => event.type === "session.binary_asset");
    }
    const options = {
        model: "image-edit-chat",
        imageGeneration: { enabled: true },
        provider: {
            type: "openai" as const,
            wireApi: "completions" as const,
            baseUrl: "https://image-edit-test.invalid/v1",
            apiKey: "synthetic-image-test",
        },
        onPermissionRequest: approveAll,
    };

    it("edits an explicit attachment and can reuse the generated result after resume", async ({
        onTestFailed,
    }) => {
        let phase = "starting";
        onTestFailed(() => {
            console.error(`Image edit diagnostic phase: ${phase}`);
        });
        const handler = new ImageHandler();
        const client = createClient({ requestHandler: handler });
        try {
            await client.start();
            const session = await client.createSession(options);
            phase = "first edit";
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            handler.nextArguments = {
                prompt: "Use this reference",
                input_images: [{ image_id: imageId(SOURCE) }],
            };
            const reply = await session.sendAndWait({
                prompt: "Use the attached image as a reference for a new image.",
                attachments: [{ type: "blob", mimeType: "image/png", data: SOURCE }],
            });
            expect(reply?.data.content).toBe(FINAL);
            phase = "disabling";
            const completion = events.find((event) => event.type === "tool.execution_complete");
            expect(completion?.data.error).toBeUndefined();
            expect(completion?.data.success).toBe(true);
            expect(handler.generations).toHaveLength(0);
            expect(handler.edits).toEqual([
                {
                    model: MODEL,
                    prompt: "Use this reference",
                    images: [{ image_url: `data:image/png;base64,${SOURCE}` }],
                    n: 1,
                    output_format: "png",
                    stream: false,
                },
            ]);
            expect(completion?.data.toolUsage).toMatchObject({
                requestId: expect.any(String),
                model: MODEL,
                provider: { id: "copilot", kind: "copilot" },
                accounting: { sourceSessionId: session.sessionId, sequence: expect.any(Number) },
                inputTokens: 340,
                outputTokens: 196,
                totalTokens: 536,
                inputTokensDetails: { textTokens: 20, imageTokens: 320 },
                outputTokensDetails: { textTokens: 0, imageTokens: 196 },
                copilotUsage: {
                    totalNanoAiu: EDIT_NANO_AIU,
                    tokenDetails: expect.arrayContaining([
                        expect.objectContaining({ tokenType: "image_input", tokenCount: 320 }),
                        expect.objectContaining({ tokenType: "image_output", tokenCount: 196 }),
                    ]),
                },
            });
            expect(completion?.data.toolUsage?.accounting?.usageId).toBe(
                completion?.data.toolUsage?.requestId
            );
            expect(completion?.data.result?.structuredContent).toMatchObject({
                imageGeneration: {
                    usage: imageServiceUsage(true).usage,
                    copilotUsage: imageServiceUsage(true).copilot_usage,
                },
            });
            expect(completion?.data.result).not.toHaveProperty("toolUsage");
            expect(await session.rpc.usage.getMetrics()).toMatchObject({
                totalNanoAiu: EDIT_NANO_AIU,
                providerModelMetrics: expect.arrayContaining([
                    expect.objectContaining({
                        provider: expect.objectContaining({ id: "copilot", kind: "copilot" }),
                        modelId: MODEL,
                        metrics: expect.objectContaining({
                            totalNanoAiu: EDIT_NANO_AIU,
                            aiCreditsStatus: "complete",
                        }),
                    }),
                ]),
                modelMetrics: {
                    [MODEL]: {
                        requests: { count: 1 },
                        usage: { inputTokens: 340, outputTokens: 196 },
                        totalNanoAiu: EDIT_NANO_AIU,
                    },
                },
            });
            expect(
                await session.rpc.options.update({ imageGeneration: { enabled: false } })
            ).toMatchObject({ success: true });
            expect(await session.rpc.usage.getMetrics()).toMatchObject({
                totalNanoAiu: EDIT_NANO_AIU,
                modelMetrics: {
                    [MODEL]: {
                        requests: { count: 1 },
                        usage: { inputTokens: 340, outputTokens: 196 },
                        totalNanoAiu: EDIT_NANO_AIU,
                    },
                },
            });
            const sessionId = session.sessionId;
            phase = "disconnecting";
            await session.disconnect();
            phase = "stopping";
            await client.stop();
            phase = "restarting";
            await client.start();
            phase = "resuming";
            const resumed = await client.resumeSession(sessionId, options);
            phase = "reading restored history";
            const history = await resumed.getEvents();
            const replayed = history
                .filter((event) => event.type === "tool.execution_complete")
                .at(-1);
            expect(replayed?.data.toolUsage).toEqual(completion?.data.toolUsage);
            expect(replayed?.data.result?.structuredContent).toEqual(
                completion?.data.result?.structuredContent
            );
            expect((await resumed.rpc.usage.getMetrics()).totalNanoAiu).toBe(EDIT_NANO_AIU);
            handler.nextArguments = {
                prompt: "Make the result brighter",
                input_images: [{ image_id: imageId(EDITED) }],
            };
            phase = "second edit";
            expect(
                (await resumed.sendAndWait({ prompt: "Make the generated image brighter." }))?.data
                    .content
            ).toBe(FINAL);
            expect(handler.edits).toHaveLength(2);
            expect(handler.edits[1].images).toEqual([
                { image_url: `data:image/png;base64,${EDITED}` },
            ]);
            expect(handler.generations).toHaveLength(0);
            expect(await resumed.rpc.usage.getMetrics()).toMatchObject({
                totalNanoAiu: EDIT_NANO_AIU * 2,
                modelMetrics: {
                    [MODEL]: {
                        requests: { count: 2 },
                        usage: { inputTokens: 680, outputTokens: 392 },
                        totalNanoAiu: EDIT_NANO_AIU * 2,
                    },
                },
            });
            await resumed.disconnect();
            phase = "done";
        } finally {
            await client.stop();
        }
    });

    it.each([
        { name: "fresh approval succeeds", approveOnResume: true, success: true },
        { name: "fresh approval returns a billed failure", approveOnResume: true, success: false },
        {
            name: "recorded approval is interrupted without replay",
            approveOnResume: false,
            success: false,
        },
    ])("preserves image accounting on resume when $name", async ({ approveOnResume, success }) => {
        const handler = new ImageHandler();
        const client = createClient({ requestHandler: handler });
        const toolCallId = "approved-image-resume";
        try {
            await client.start();
            const session = await client.createSession(options);
            const sessionId = session.sessionId;
            handler.nextArguments = { prompt: "A green circle" };
            expect(
                (await session.sendAndWait({ prompt: "Generate a green circle." }))?.data.content
            ).toBe(FINAL);
            await client.rpc.sessions.save({ sessionId });
            await session.disconnect();
            await client.stop();
            const logPath = join(env.COPILOT_HOME, "session-state", sessionId, "events.jsonl");
            const log = await readFile(logPath, "utf8");
            const history = log
                .trim()
                .split("\n")
                .map((line): SessionEvent => JSON.parse(line));
            let parentId = history.at(-1)?.id ?? null;
            const args = { prompt: "A blue circle" };
            // Recorded approval cannot prove an image POST was never dispatched.
            // Fresh approval after resume is the boundary that permits new execution.
            const pending = [
                {
                    type: "user.message" as const,
                    data: { content: "Generate a blue circle." },
                },
                {
                    type: "assistant.message" as const,
                    data: {
                        messageId: randomUUID(),
                        content: "",
                        model: options.model,
                        toolRequests: [{ toolCallId, name: "image_generation", arguments: args }],
                    },
                },
                {
                    type: "permission.requested" as const,
                    data: {
                        requestId: "approved-image-permission",
                        permissionRequest: {
                            kind: "custom-tool" as const,
                            toolCallId,
                            toolName: "image_generation",
                            toolDescription: "Generate image",
                            args,
                        },
                    },
                },
                {
                    type: "permission.completed" as const,
                    data: {
                        requestId: "approved-image-permission",
                        result: { kind: "approved" as const },
                        decisionSource: "human_response" as const,
                        toolCallId,
                    },
                },
            ];
            const events: SessionEvent[] = pending
                .filter((event) => !approveOnResume || event.type !== "permission.completed")
                .map((event) => {
                    const envelope = {
                        ...event,
                        id: randomUUID(),
                        timestamp: new Date().toISOString(),
                        parentId,
                    };
                    parentId = envelope.id;
                    return envelope;
                });
            await appendFile(
                logPath,
                `${log.endsWith("\n") ? "" : "\n"}${events.map((event) => JSON.stringify(event)).join("\n")}\n`
            );
            if (approveOnResume && !success) {
                handler.imageResultOverrides = {
                    data: [{ b64_json: Buffer.from("not a PNG").toString("base64") }],
                };
            }
            await client.start();
            const resumed = await client.resumeSession(sessionId, {
                ...options,
                continuePendingWork: true,
                onPermissionRequest: () => ({ kind: "no-result" }),
            });
            if (approveOnResume) {
                await expect
                    .poll(
                        async () =>
                            (await resumed.rpc.permissions.pendingRequests()).items.map(
                                (request) => request.requestId
                            ),
                        { timeout: 20_000 }
                    )
                    .toContain("approved-image-permission");
                // Fresh approval starts a background continuation. Observe its final
                // reply and idle before a follow-up sendAndWait can capture that idle.
                const continuation = await withFinalAssistantMessage(resumed, async () => {
                    expect(
                        await resumed.rpc.permissions.handlePendingPermissionRequest({
                            requestId: "approved-image-permission",
                            result: { kind: "approve-once" },
                        })
                    ).toMatchObject({ success: true });
                });
                expect(continuation.data.content).toBe(FINAL);
            }
            await expect
                .poll(
                    async () =>
                        (await resumed.getEvents()).find(
                            (event) =>
                                event.type === "tool.execution_complete" &&
                                event.data.toolCallId === toolCallId
                        ),
                    { timeout: 20_000 }
                )
                .toBeDefined();
            const completions = (await resumed.getEvents()).filter(
                (event) =>
                    event.type === "tool.execution_complete" && event.data.toolCallId === toolCallId
            );
            expect(completions).toHaveLength(1);
            expect(completions[0].data.success, JSON.stringify(completions[0].data)).toBe(success);
            const expectedGenerations = approveOnResume ? 2 : 1;
            expect(handler.generations, JSON.stringify(completions[0].data)).toHaveLength(
                expectedGenerations
            );
            // Validate the final assistant response arrived (guards against truncated captures).
            expect(
                (await resumed.sendAndWait({ prompt: "Confirm the image work is complete." }))?.data
                    .content
            ).toBe(FINAL);
            expect((await resumed.rpc.usage.getMetrics()).totalNanoAiu).toBe(
                GENERATION_NANO_AIU * expectedGenerations
            );
            if (approveOnResume) {
                expect(completions[0].data.toolUsage).toMatchObject({
                    model: MODEL,
                    inputTokens: 21,
                    outputTokens: 196,
                    copilotUsage: { totalNanoAiu: GENERATION_NANO_AIU },
                });
            } else {
                expect(completions[0].data.error).toMatchObject({ code: "interrupted" });
                expect(completions[0].data.toolUsage).toBeUndefined();
            }
            await resumed.disconnect();
        } finally {
            await client.stop();
        }
    });

    it("does not upload an unrelated attachment when the tool selects text-only generation", async () => {
        const handler = new ImageHandler();
        const client = createClient({ requestHandler: handler });
        try {
            await client.start();
            const session = await client.createSession(options);
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            handler.nextArguments = { prompt: "A fresh landscape" };
            expect(
                (
                    await session.sendAndWait({
                        prompt: "Ignore the attachment and generate a fresh landscape.",
                        attachments: [{ type: "blob", mimeType: "image/png", data: SOURCE }],
                    })
                )?.data.content
            ).toBe(FINAL);
            expect(handler.edits).toHaveLength(0);
            expect(handler.generations).toHaveLength(1);
            expect(handler.generations[0]).not.toHaveProperty("images");
            const completed = events
                .filter((event) => event.type === "tool.execution_complete")
                .at(-1);
            expect(completed?.data.toolUsage).toMatchObject({
                model: MODEL,
                inputTokens: 21,
                outputTokens: 196,
                inputTokensDetails: { textTokens: 21, imageTokens: 0 },
                copilotUsage: { totalNanoAiu: GENERATION_NANO_AIU },
            });
            expect(completed?.data.result?.structuredContent).toMatchObject({
                imageGeneration: {
                    usage: imageServiceUsage(false).usage,
                    copilotUsage: imageServiceUsage(false).copilot_usage,
                },
            });
            expect((await session.rpc.usage.getMetrics()).totalNanoAiu).toBe(GENERATION_NANO_AIU);
            await session.disconnect();
        } finally {
            await client.stop();
        }
    });

    it("rejects image references outside the session instead of generating a substitute", async () => {
        const handler = new ImageHandler();
        const client = createClient({ requestHandler: handler });
        try {
            await client.start();
            const session = await client.createSession(options);
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            handler.nextArguments = {
                prompt: "Edit",
                input_images: [{ image_id: imageId(SOURCE) }],
            };
            expect(
                (await session.sendAndWait({ prompt: "Edit the selected image." }))?.data.content
            ).toBe(FINAL);
            expect(handler.edits).toHaveLength(0);
            expect(handler.generations).toHaveLength(0);
            const completion = events.find((event) => event.type === "tool.execution_complete");
            expect(completion?.data.error?.message).toMatch(/^image_generation_input_unavailable:/);
            expect(completion?.data.success).toBe(false);
            expect(completion?.data.toolUsage).toBeUndefined();
            expect((await session.rpc.usage.getMetrics()).totalNanoAiu).toBe(0);
            await session.disconnect();
        } finally {
            await client.stop();
        }
    });

    it.each([
        {
            name: "missing billing",
            overrides: { copilot_usage: undefined },
            inputTokens: 21,
            nanoAiu: undefined,
        },
        {
            name: "missing tokens",
            overrides: { usage: undefined },
            inputTokens: undefined,
            nanoAiu: GENERATION_NANO_AIU,
        },
        {
            name: "reported zero",
            overrides: { copilot_usage: { total_nano_aiu: 0 } },
            inputTokens: 21,
            nanoAiu: 0,
        },
        {
            name: "both unavailable",
            overrides: { usage: undefined, copilot_usage: undefined },
            inputTokens: undefined,
            nanoAiu: undefined,
        },
    ])(
        "keeps $name distinct in the SDK tool event",
        async ({ overrides, inputTokens, nanoAiu }) => {
            const handler = new ImageHandler();
            handler.imageResultOverrides = overrides;
            handler.nextArguments = { prompt: "A blue circle" };
            const client = createClient({ requestHandler: handler });
            try {
                await client.start();
                const session = await client.createSession(options);
                const events: SessionEvent[] = [];
                session.on((event) => events.push(event));
                expect(
                    (await session.sendAndWait({ prompt: "Generate a blue circle." }))?.data.content
                ).toBe(FINAL);
                const completed = events
                    .filter((event) => event.type === "tool.execution_complete")
                    .at(-1);
                expect(completed?.data.success).toBe(true);
                expect(completed?.data.toolUsage).toMatchObject({
                    requestId: expect.any(String),
                    model: MODEL,
                    provider: { id: "copilot", kind: "copilot" },
                });
                expect(completed?.data.toolUsage?.inputTokens).toBe(inputTokens);
                expect(completed?.data.toolUsage?.copilotUsage?.totalNanoAiu).toBe(nanoAiu);
                if (inputTokens === undefined) {
                    expect(completed?.data.toolUsage).not.toHaveProperty("outputTokens");
                    expect(completed?.data.toolUsage).not.toHaveProperty("totalTokens");
                }
                const metrics = await session.rpc.usage.getMetrics();
                expect(metrics.totalNanoAiu).toBe(nanoAiu ?? 0);
                expect(metrics.modelMetrics[MODEL]?.aiCreditsStatus).toBe(
                    nanoAiu === undefined ? "unavailable" : "complete"
                );
                if (nanoAiu === undefined) {
                    expect(completed?.data.toolUsage).not.toHaveProperty("copilotUsage");
                    expect(metrics.aiCreditsStatus).toBe("unavailable");
                }
                await session.disconnect();
            } finally {
                await client.stop();
            }
        }
    );

    it("reports the known charge when local image decoding fails", async () => {
        const handler = new ImageHandler();
        handler.imageResultOverrides = {
            data: [{ b64_json: Buffer.from("not a PNG").toString("base64") }],
        };
        handler.nextArguments = { prompt: "A blue circle" };
        const client = createClient({ requestHandler: handler });
        try {
            await client.start();
            const session = await client.createSession(options);
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            expect(
                (await session.sendAndWait({ prompt: "Generate a blue circle." }))?.data.content
            ).toBe(FINAL);
            const completed = events
                .filter((event) => event.type === "tool.execution_complete")
                .at(-1);
            expect(completed?.data.success).toBe(false);
            expect(completed?.data.toolUsage).toMatchObject({
                model: MODEL,
                inputTokens: 21,
                outputTokens: 196,
                copilotUsage: { totalNanoAiu: GENERATION_NANO_AIU },
            });
            expect(completed?.data.result).toBeUndefined();
            expect((await session.rpc.usage.getMetrics()).totalNanoAiu).toBe(GENERATION_NANO_AIU);
            await session.disconnect();
        } finally {
            await client.stop();
        }
    });

    it("keeps the transformed hook final for batched image attachments", async () => {
        const handler = new ImageHandler();
        const client = createClient({ requestHandler: handler });
        const preceding = "Inspect the first batch image.";
        const replacement = "IMAGE_BATCH_HOOK_REPLACEMENT";
        const inputs: UserPromptTransformedHookInput[] = [];
        try {
            await client.start();
            const session = await client.createSession({
                ...options,
                hooks: {
                    onUserPromptTransformed: async (input) => {
                        inputs.push(input);
                        return { modifiedTransformedPrompt: replacement };
                    },
                },
            });
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            await session.rpc.sendMessages({
                messages: [
                    {
                        prompt: preceding,
                        attachments: [{ type: "blob", mimeType: "image/png", data: SOURCE }],
                    },
                    { prompt: "Finish the batch." },
                ],
                wait: true,
            });
            expect(inputs.find((input) => input.prompt === preceding)?.transformedPrompt).toContain(
                imageId(SOURCE)
            );
            const messages = events.filter((event) => event.type === "user.message");
            expect(messages).toHaveLength(2);
            for (const message of messages) {
                expect(message.data.transformedContent).toBe(replacement);
            }
            expect(JSON.stringify(handler.chats.at(-1)?.messages)).not.toContain(
                "Image input references"
            );
            // Validate the final assistant response arrived (guards against truncated captures).
            expect(
                events.findLast((event) => event.type === "assistant.message")?.data.content
            ).toBe(FINAL);
            await session.disconnect();
        } finally {
            await client.stop();
        }
    });

    it("emits the preceding image message when its transformed hook throws", async () => {
        const handler = new ImageHandler();
        const client = createClient({ requestHandler: handler });
        const preceding = "Inspect the first batch image.";
        const hooked: string[] = [];
        try {
            await client.start();
            const session = await client.createSession({
                ...options,
                hooks: {
                    onUserPromptTransformed: async (input) => {
                        hooked.push(input.prompt);
                        if (input.prompt === preceding) {
                            throw new Error("IMAGE_TRANSFORM_EXPECTED_FAILURE");
                        }
                    },
                },
            });
            const events: SessionEvent[] = [];
            session.on((event) => events.push(event));
            await session.rpc.sendMessages({
                messages: [
                    {
                        prompt: preceding,
                        attachments: [{ type: "blob", mimeType: "image/png", data: SOURCE }],
                    },
                    { prompt: "Finish the batch." },
                ],
                wait: true,
            });
            expect(hooked).toEqual([preceding, "Finish the batch."]);
            const messages = events.filter((event) => event.type === "user.message");
            expect(messages.map((message) => message.data.content)).toEqual(hooked);
            expect(messages[0].data.attachments).toContainEqual(
                expect.objectContaining({ type: "blob", mimeType: "image/png", data: SOURCE })
            );
            expect(
                (await readPersistedAssets(client, session.sessionId)).map(
                    (asset) => asset.data.assetId
                )
            ).toEqual([imageId(SOURCE)]);
            // Validate the final assistant response arrived (guards against truncated captures).
            expect(
                events.findLast((event) => event.type === "assistant.message")?.data.content
            ).toBe(FINAL);
            await session.disconnect();
        } finally {
            await client.stop();
        }
    });

    it("adds a persisted preview when reattaching a generated image", async () => {
        const handler = new ImageHandler();
        handler.outputImage = png(200, 2200);
        const client = createClient({ requestHandler: handler });
        try {
            await client.start();
            const session = await client.createSession(options);
            handler.nextArguments = { prompt: "Generate a wide image." };
            expect(
                (await session.sendAndWait({ prompt: "Generate a wide image." }))?.data.content
            ).toBe(FINAL);
            expect(handler.generations).toHaveLength(1);
            expect(
                (
                    await session.sendAndWait({
                        prompt: "Inspect the reattached image.",
                        attachments: [
                            { type: "blob", mimeType: "image/png", data: handler.outputImage },
                        ],
                    })
                )?.data.content
            ).toBe(FINAL);
            const assets = await readPersistedAssets(client, session.sessionId);
            const update = assets.findLast(
                (event) => event.data.assetId === `image-edit:${imageId(handler.outputImage)}`
            );
            expect(update?.data.metadata?.imageEditSource).toEqual({
                data: handler.outputImage,
                mimeType: "image/png",
            });
            const preview = update?.data.data;
            if (typeof preview !== "string") {
                throw new Error("The reattached image has no persisted chat preview");
            }
            expect(preview).not.toBe(handler.outputImage);
            expect(Buffer.from(preview, "base64").length).toBeLessThanOrEqual(3 * 1024 * 1024);
            const imageMessage = expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([
                    expect.objectContaining({
                        type: "image_url",
                        image_url: expect.objectContaining({
                            url: `data:image/png;base64,${preview}`,
                        }),
                    }),
                ]),
            });
            expect(handler.chats.at(-1)?.messages).toContainEqual(imageMessage);

            const sessionId = session.sessionId;
            await session.disconnect();
            await client.stop();
            await client.start();
            const resumed = await client.resumeSession(sessionId, options);
            expect((await resumed.sendAndWait({ prompt: "Inspect it again." }))?.data.content).toBe(
                FINAL
            );
            expect(handler.chats.at(-1)?.messages).toContainEqual(imageMessage);
            handler.nextArguments = {
                prompt: "Edit the original wide image.",
                input_images: [{ image_id: imageId(handler.outputImage) }],
            };
            // Validate the final assistant response arrived (guards against truncated captures).
            expect(
                (await resumed.sendAndWait({ prompt: "Edit the reattached image." }))?.data.content
            ).toBe(FINAL);
            expect(handler.edits.at(-1)?.images).toEqual([
                { image_url: `data:image/png;base64,${handler.outputImage}` },
            ]);
            await resumed.disconnect();
        } finally {
            await client.stop();
        }
    });

    it.each(["generations-only", "filtered-out"] as const)(
        "does not retain originals or advertise image inputs when %s",
        async (availability) => {
            const handler = new ImageHandler();
            if (availability === "generations-only") {
                handler.supportedEndpoints = ["/v1/images/generations"];
            }
            // In-process clients share the model catalog cache, keyed by endpoint and auth.
            const token = `image-input-${randomUUID()}`;
            await openAiEndpoint.setCopilotUserByToken(token, {
                login: "image-input-test",
                copilot_plan: "individual_pro",
                endpoints: { api: env.COPILOT_API_URL },
                analytics_tracking_id: token,
            });
            const client = createClient({ requestHandler: handler, gitHubToken: token });
            const inputs: UserPromptTransformedHookInput[] = [];
            try {
                await client.start();
                const session = await client.createSession({
                    ...options,
                    excludedTools: availability === "filtered-out" ? ["image_generation"] : [],
                    hooks: {
                        onUserPromptTransformed: async (input) => {
                            inputs.push(input);
                        },
                    },
                });
                const original = png(20, 2200);
                // Validate the final assistant response arrived (guards against truncated captures).
                expect(
                    (
                        await session.sendAndWait({
                            prompt: "Inspect this attachment.",
                            attachments: [{ type: "blob", mimeType: "image/png", data: original }],
                        })
                    )?.data.content
                ).toBe(FINAL);
                expect(inputs).toHaveLength(1);
                expect(inputs[0].transformedPrompt).not.toContain("Image input references");
                const assets = await readPersistedAssets(client, session.sessionId);
                expect(assets).toHaveLength(1);
                expect(assets[0].data.data).not.toBe(original);
                expect(assets[0].data.metadata?.imageEditSource).toBeUndefined();
                await session.disconnect();
            } finally {
                await client.stop();
            }
        }
    );
});

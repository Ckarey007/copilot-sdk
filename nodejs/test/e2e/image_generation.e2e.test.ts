/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
    approveAll,
    CopilotClient,
    CopilotRequestHandler,
    RuntimeConnection,
    type CopilotRequestContext,
    type CopilotSession,
    type SessionEvent,
} from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { getNextEventOfType, waitForCondition } from "./harness/sdkTestHelper.js";
import { withTestBackend } from "./harness/testBackend.js";

const IMAGE_MODEL = "gpt-image-2.5-sunburst";
const IMAGE_ENDPOINT = "/v1/images/generations";
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC";

class ImageService extends CopilotRequestHandler {
    readonly imageRequests: unknown[] = [];
    readonly chatToolNames: string[][] = [];
    imageModelOverrides: Record<string, unknown> = {};
    imageResultOverrides: Record<string, unknown> = {};

    constructor(private readonly modelAvailable = true) {
        super();
    }

    protected override async sendRequest(
        request: Request,
        context: CopilotRequestContext
    ): Promise<Response> {
        const pathname = new URL(request.url).pathname;
        if (pathname.endsWith("/chat/completions") && request.method === "POST") {
            const body = (await request.json()) as {
                model: string;
                stream?: boolean;
                tools?: Array<{ function: { name: string } }>;
            };
            this.chatToolNames.push(body.tools?.map((tool) => tool.function.name) ?? []);
            const message = { role: "assistant", content: "IMAGE_CONSENT_TURN_COMPLETE" };
            const response = {
                id: "image-consent-turn",
                created: 123,
                model: body.model,
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            };
            if (!body.stream) {
                return Response.json({
                    ...response,
                    object: "chat.completion",
                    choices: [{ index: 0, message, finish_reason: "stop" }],
                });
            }
            return new Response(
                `data: ${JSON.stringify({
                    ...response,
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: message, finish_reason: "stop" }],
                })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } }
            );
        }
        if (pathname === IMAGE_ENDPOINT) {
            this.imageRequests.push(await request.json());
            return Response.json({
                created: 123,
                data: [{ b64_json: PNG }],
                output_format: "png",
                ...this.imageResultOverrides,
            });
        }
        const response = await super.sendRequest(request, context);
        if (pathname !== "/models" || !response.ok) {
            return response;
        }
        const catalog = (await response.json()) as { data: unknown[] };
        if (this.modelAvailable) {
            catalog.data.push({
                id: IMAGE_MODEL,
                name: "SDK test image model",
                capabilities: { type: "image" },
                supported_endpoints: [IMAGE_ENDPOINT],
                model_picker_enabled: false,
                policy: { state: "enabled" },
                billing: {
                    token_prices: {
                        batch_size: 100_000,
                        default: { input_price: 50, output_price: 0 },
                    },
                },
                ...this.imageModelOverrides,
            });
        }
        return Response.json(catalog);
    }
}

async function imageToolOffered(session: CopilotSession): Promise<boolean> {
    await session.rpc.tools.initializeAndValidate();
    const { tools } = await session.rpc.tools.getCurrentMetadata();
    return tools.some((tool) => tool.name === "image_generation");
}

describe("Native image generation consent", async () => {
    // Native image inference is CAPI-only, independent of the chat-provider CI matrix.
    const { createClient, openAiEndpoint, env, workDir } = await createSdkTestContext({
        replayOnly: true,
        backend: "capi",
    });

    it("lists the runtime default with image-token prices separately from chat models", async () => {
        const service = new ImageService();
        service.imageModelOverrides = {
            billing: {
                token_prices: {
                    batch_size: 100_000,
                    default: {
                        input_price: 50,
                        output_price: 0,
                        image_input_price: 80.125,
                        image_output_price: 300.001,
                    },
                },
            },
        };
        await using client = createClient({ requestHandler: service });
        await client.start();
        const catalog = await client.rpc.models.list();
        expect(catalog.imageModels).toContainEqual({
            id: IMAGE_MODEL,
            name: "SDK test image model",
            supportedOperations: ["generate"],
            isDefault: true,
            availability: "available",
            pricing: {
                batchSize: 100_000,
                textInputPrice: 50,
                textOutputPrice: 0,
                imageInputPrice: 80.125,
                imageOutputPrice: 300.001,
            },
        });
        expect(catalog.models.some((model) => model.id === IMAGE_MODEL)).toBe(false);
        expect(service.imageRequests).toEqual([]);
    });

    it.each(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"])(
        "lists models without Copilot authentication when only %s is configured",
        async (apiKey) => {
            const requests: string[] = [];
            const service = new (class extends CopilotRequestHandler {
                protected override async sendRequest(request: Request): Promise<Response> {
                    requests.push(new URL(request.url).pathname);
                    throw new Error("API-key-only discovery must not contact Copilot");
                }
            })();
            await using client = new CopilotClient({
                connection: RuntimeConnection.forStdio(),
                workingDirectory: workDir,
                requestHandler: service,
                useLoggedInUser: true,
                env: {
                    ...env,
                    CAPI_HMAC_KEY: "",
                    COPILOT_HMAC_KEY: "",
                    GH_TOKEN: "",
                    GITHUB_TOKEN: "",
                    COPILOT_GITHUB_TOKEN: "",
                    COPILOT_SDK_AUTH_TOKEN: "",
                    GITHUB_COPILOT_API_TOKEN: "",
                    ANTHROPIC_API_KEY: "",
                    OPENAI_API_KEY: "",
                    AZURE_OPENAI_API_KEY: "",
                    COPILOT_ENABLE_ALT_PROVIDERS: "true",
                    IMAGE_GENERATION_TOOL: "false",
                    [apiKey]: "test-api-key",
                },
            });
            await client.start();
            expect(await client.getAuthStatus()).toMatchObject({
                isAuthenticated: true,
                authType: "api-key",
            });
            expect(await client.listModels()).toEqual([]);
            expect(await client.rpc.models.list()).toMatchObject({
                models: [],
                imageModels: [
                    {
                        id: IMAGE_MODEL,
                        name: "GPT Image 2.5 Sunburst",
                        isDefault: true,
                        availability: "unavailable",
                        supportedOperations: [],
                    },
                ],
            });
            expect(requests).toEqual([]);
        }
    );

    it.each([
        {
            name: "OAuth with alternate providers",
            hmac: false,
            alternateProviders: true,
            available: true,
        },
        {
            name: "HMAC without a user subscription",
            hmac: true,
            alternateProviders: false,
            available: true,
        },
        {
            name: "HMAC with an alternate chat provider",
            hmac: true,
            alternateProviders: true,
            available: true,
        },
        {
            name: "free OAuth with alternate providers",
            hmac: false,
            alternateProviders: true,
            available: false,
        },
        {
            name: "HMAC with disabled image policy",
            hmac: true,
            alternateProviders: true,
            available: false,
        },
    ])(
        "discovers authorized image models for $name",
        async ({ hmac, alternateProviders, available }) => {
            const token = `image-discovery-${randomUUID()}`;
            await openAiEndpoint.setCopilotUserByToken(token, {
                login: "image-discovery-user",
                copilot_plan: "individual",
                access_type_sku: !hmac && !available ? "free_limited_copilot" : undefined,
                is_staff: false,
                endpoints: { api: env.COPILOT_API_URL },
                analytics_tracking_id: token,
            });
            const service = new ImageService();
            service.imageModelOverrides = {
                policy: { state: hmac && !available ? "disabled" : "enabled" },
                billing: {
                    restricted_to: ["pro", "enterprise"],
                    token_prices: {
                        batch_size: 1_000_000,
                        default: { image_input_price: 800, image_output_price: 3_000 },
                    },
                },
            };
            await using client = new CopilotClient({
                connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
                workingDirectory: workDir,
                requestHandler: service,
                gitHubToken: hmac ? undefined : token,
                useLoggedInUser: hmac,
                env: {
                    ...env,
                    CAPI_HMAC_KEY: hmac ? token : "",
                    COPILOT_HMAC_KEY: "",
                    GH_TOKEN: "",
                    GITHUB_TOKEN: "",
                    COPILOT_GITHUB_TOKEN: "",
                    COPILOT_SDK_AUTH_TOKEN: "",
                    GITHUB_COPILOT_API_TOKEN: "",
                    GITHUB_USER_ID: "12345",
                    GITHUB_ORG_ID: "",
                    COPILOT_ENABLE_ALT_PROVIDERS: String(alternateProviders),
                    COPILOT_AGENT_MODEL: "sweagent-openai:gpt-5.4",
                },
            });
            await client.start();
            const auth = await client.getAuthStatus();
            expect(auth.isAuthenticated).toBe(true);
            if (hmac) {
                expect(auth.authType).toBe("hmac");
            }
            const catalog = await client.rpc.models.list(hmac ? {} : { gitHubToken: token });
            expect(catalog.imageModels).toEqual(
                available
                    ? [
                          {
                              id: IMAGE_MODEL,
                              name: "SDK test image model",
                              isDefault: true,
                              availability: "available",
                              supportedOperations: ["generate"],
                              pricing: {
                                  batchSize: 1_000_000,
                                  imageInputPrice: 800,
                                  imageOutputPrice: 3_000,
                              },
                          },
                      ]
                    : [
                          {
                              id: IMAGE_MODEL,
                              name: "GPT Image 2.5 Sunburst",
                              isDefault: true,
                              availability: "unavailable",
                              supportedOperations: [],
                          },
                      ]
            );
            expect(catalog.models.some((model) => model.id === IMAGE_MODEL)).toBe(false);
            if (alternateProviders) {
                expect(catalog.models).toEqual([]);
            }
            expect(service.imageRequests).toEqual([]);
        }
    );

    it.each([
        {
            name: "entitled user",
            sku: undefined,
            plan: "individual",
            policy: "enabled",
            available: true,
        },
        {
            name: "free user",
            sku: "free_limited_copilot",
            plan: "individual",
            policy: "enabled",
            available: false,
        },
        {
            name: "unknown entitlement",
            sku: undefined,
            plan: "unknown",
            policy: "enabled",
            available: false,
        },
        {
            name: "disabled model policy",
            sku: undefined,
            plan: "individual",
            policy: "disabled",
            available: false,
        },
        {
            name: "unconfigured model policy",
            sku: undefined,
            plan: "individual",
            policy: "unconfigured",
            available: false,
        },
    ])(
        "reports default image model availability for the $name",
        async ({ sku, plan, policy, available }) => {
            const token = `image-catalog-${randomUUID()}`;
            await openAiEndpoint.setCopilotUserByToken(token, {
                login: "image-catalog-user",
                access_type_sku: sku,
                copilot_plan: plan,
                is_staff: false,
                endpoints: { api: env.COPILOT_API_URL },
                analytics_tracking_id: token,
            });
            const service = new ImageService();
            service.imageModelOverrides = {
                billing: { restricted_to: ["pro", "enterprise"] },
                policy: { state: policy },
            };
            await using client = createClient({ requestHandler: service, gitHubToken: token });
            await client.start();
            const catalog = await client.rpc.models.list({ gitHubToken: token });
            expect(catalog.imageModels).toHaveLength(1);
            expect(catalog.imageModels?.[0]).toMatchObject({
                id: IMAGE_MODEL,
                isDefault: true,
                availability: available ? "available" : "unavailable",
            });
            if (!available) {
                expect(catalog.imageModels?.[0].supportedOperations).toEqual([]);
                expect(catalog.imageModels?.[0].pricing).toBeUndefined();
            }
            expect(catalog.models.some((model) => model.id === IMAGE_MODEL)).toBe(false);
            expect(service.imageRequests).toEqual([]);
        }
    );

    it("requires SDK consent and CAPI access regardless of the CLI rollout flag", async () => {
        for (const flag of [false, true]) {
            for (const enabled of [undefined, false, true]) {
                const service = new ImageService();
                await using client = createClient({ requestHandler: service });
                await using session = await client.createSession({
                    onPermissionRequest: approveAll,
                    featureFlags: { IMAGE_GENERATION_TOOL: flag },
                    imageGeneration: enabled === undefined ? undefined : { enabled },
                });
                expect(await imageToolOffered(session)).toBe(enabled === true);
                expect(service.imageRequests).toEqual([]);
            }
        }
    });

    it("executes an opted-in CAPI image tool while the rollout flag is off", async () => {
        const service = new ImageService();
        await using client = createClient({ requestHandler: service });
        await using session = await client.createSession({
            onPermissionRequest: approveAll,
            featureFlags: { IMAGE_GENERATION_TOOL: false },
            imageGeneration: { enabled: true },
        });
        expect(await imageToolOffered(session)).toBe(true);
        const result = await session.rpc.tools.execute({
            name: "image_generation",
            arguments: { prompt: "A watercolor fox" },
            toolCallId: "sdk-image",
        });
        expect(result).toMatchObject({
            resultType: "success",
            contents: [{ type: "image", mimeType: "image/png", data: PNG }],
        });
        expect(service.imageRequests).toEqual([
            {
                model: IMAGE_MODEL,
                prompt: "A watercolor fox",
                n: 1,
                output_format: "png",
                stream: false,
            },
        ]);
    });

    it.each([
        {
            name: "reported charge",
            nanoAiu: 598_500_000,
            data: [{ b64_json: PNG }],
            resultType: "success",
        },
        { name: "reported zero", nanoAiu: 0, data: [{ b64_json: PNG }], resultType: "success" },
        {
            name: "charged decoding failure",
            nanoAiu: 598_500_000,
            data: [{ b64_json: Buffer.from("not a PNG").toString("base64") }],
            resultType: "failure",
        },
        {
            name: "charged invalid image count",
            nanoAiu: 598_500_000,
            data: [],
            resultType: "failure",
        },
        {
            name: "charged malformed image envelope",
            nanoAiu: 598_500_000,
            data: "not an image list",
            resultType: "failure",
        },
    ])(
        "accounts for direct image execution and cold resume: $name",
        async ({ nanoAiu, data, resultType }) => {
            const service = new ImageService();
            service.imageResultOverrides = {
                data,
                usage: { input_tokens: 21, output_tokens: 196, total_tokens: 217 },
                copilot_usage: { total_nano_aiu: nanoAiu },
            };
            await using client = createClient({ requestHandler: service });
            const options = {
                model: "claude-sonnet-5",
                onPermissionRequest: approveAll,
                imageGeneration: { enabled: true },
            };
            await using session = await client.createSession(options);
            await session.sendAndWait({ prompt: "Acknowledge this message without using tools." });
            const before = await session.rpc.usage.getMetrics();
            const historyBefore = await session.getEvents();
            const completion = getNextEventOfType(session, "tool.execution_complete");
            const result = await session.rpc.tools.execute({
                name: "image_generation",
                arguments: { prompt: "A watercolor fox" },
                toolCallId: "direct-image-usage",
            });
            expect(result).toMatchObject({ resultType });
            expect(result).not.toHaveProperty("toolUsage");
            if (resultType === "success") {
                expect(result).toMatchObject({
                    structuredContent: {
                        imageGeneration: { copilotUsage: { total_nano_aiu: nanoAiu } },
                    },
                });
            }
            const metrics = await session.rpc.usage.getMetrics();
            expect(metrics).toMatchObject({
                totalNanoAiu: nanoAiu,
                modelMetrics: {
                    [IMAGE_MODEL]: {
                        requests: { count: 1 },
                        usage: { inputTokens: 21, outputTokens: 196 },
                        totalNanoAiu: nanoAiu,
                        aiCreditsStatus: "complete",
                    },
                },
            });
            expect(metrics.modelMetrics["claude-sonnet-5"]).toEqual(
                before.modelMetrics["claude-sonnet-5"]
            );
            expect(await completion).toMatchObject({
                ephemeral: true,
                data: {
                    toolCallId: "direct-image-usage",
                    success: resultType === "success",
                    toolUsage: {
                        model: IMAGE_MODEL,
                        copilotUsage: { totalNanoAiu: nanoAiu },
                        accounting: { sourceSessionId: session.sessionId },
                    },
                },
            });
            const history = await session.getEvents();
            expect(history.filter((event) => event.type === "tool.execution_complete")).toEqual(
                historyBefore.filter((event) => event.type === "tool.execution_complete")
            );
            expect(history.some((event) => event.type === "session.usage_checkpoint")).toBe(true);

            await session.disconnect();
            await client.stop();
            await client.start();
            await using resumed = await client.resumeSession(session.sessionId, options);
            expect(await resumed.rpc.usage.getMetrics()).toMatchObject({
                totalNanoAiu: nanoAiu,
                modelMetrics: { [IMAGE_MODEL]: metrics.modelMetrics[IMAGE_MODEL] },
            });
            expect(service.imageRequests).toHaveLength(1);
        }
    );

    it("gives concurrent direct image receipts unique default IDs and preserves caller IDs", async () => {
        const service = new ImageService();
        service.imageResultOverrides = { copilot_usage: { total_nano_aiu: 123 } };
        await using client = createClient({ requestHandler: service });
        await using session = await client.createSession({
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: true },
        });
        expect(await imageToolOffered(session)).toBe(true);
        const receipts: Extract<SessionEvent, { type: "tool.execution_complete" }>[] = [];
        const unsubscribe = session.on((event) => {
            if (event.type === "tool.execution_complete") {
                receipts.push(event);
            }
        });
        try {
            const results = await Promise.all(
                ["first", "second"].map((prompt) =>
                    session.rpc.tools.execute({
                        name: "image_generation",
                        arguments: { prompt },
                    })
                )
            );
            results.forEach((result) => expect(result).toMatchObject({ resultType: "success" }));
            expect(
                await session.rpc.tools.execute({
                    name: "image_generation",
                    arguments: { prompt: "third" },
                    toolCallId: "caller-image",
                })
            ).toMatchObject({ resultType: "success" });
            await waitForCondition(() => receipts.length === 3, {
                timeoutMessage: "Expected one usage receipt for each direct image call",
            });
            expect(new Set(receipts.map((event) => event.data.toolCallId)).size).toBe(3);
            expect(receipts.map((event) => event.data.toolCallId)).toContain("caller-image");
            expect(new Set(receipts.map((event) => event.data.toolUsage?.requestId)).size).toBe(3);
            expect(await session.rpc.usage.getMetrics()).toMatchObject({
                totalNanoAiu: 369,
                modelMetrics: { [IMAGE_MODEL]: { requests: { count: 3 } } },
            });
            expect(service.imageRequests).toHaveLength(3);
        } finally {
            unsubscribe();
        }
    });

    it("preserves resident consent but applies an explicit opt-out", async () => {
        await using client = createClient({ requestHandler: new ImageService() });
        await using session = await client.createSession({
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: true },
            featureFlags: { IMAGE_GENERATION_TOOL: false },
        });
        expect(await imageToolOffered(session)).toBe(true);
        await using resumed = await client.resumeSession(session.sessionId, {
            onPermissionRequest: approveAll,
        });
        expect(await imageToolOffered(resumed)).toBe(true);
        await using disabled = await client.resumeSession(session.sessionId, {
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: false },
            featureFlags: { IMAGE_GENERATION_TOOL: true },
        });
        expect(await imageToolOffered(disabled)).toBe(false);
    });

    it("toggles the native image tool live without changing catalog availability", async () => {
        const service = new ImageService();
        await using client = createClient({ requestHandler: service });
        await using session = await client.createSession({
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: true },
            featureFlags: { IMAGE_GENERATION_TOOL: true },
        });
        const catalog = await client.rpc.models.list();
        for (const enabled of [false, true, false]) {
            expect(
                await session.rpc.options.update({ imageGeneration: { enabled } })
            ).toMatchObject({ success: true });
            expect(await imageToolOffered(session)).toBe(enabled);
            expect((await client.rpc.models.list()).imageModels).toEqual(catalog.imageModels);
        }
        await expect(
            session.rpc.options.update({
                imageGeneration: {
                    // @ts-expect-error Invalid wire inputs must be rejected rather than changing consent.
                    enabled: "false",
                },
            })
        ).rejects.toThrow("Invalid imageGeneration options");
        expect(await imageToolOffered(session)).toBe(false);
        const result = await session.rpc.tools.execute({
            name: "image_generation",
            arguments: { prompt: "Must not execute while Off" },
            toolCallId: "disabled-image",
        });
        expect(result.resultType).not.toBe("success");
        expect(service.imageRequests).toEqual([]);
    });

    it("requires renewed consent after a runtime restart", async () => {
        // Separate stdio runtimes prove that consent is not restored from disk.
        const firstService = new ImageService();
        await using first = createClient({
            requestHandler: firstService,
            connection: RuntimeConnection.forStdio(),
        });
        const original = await first.createSession({
            model: "claude-sonnet-5",
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: true },
        });
        expect(await imageToolOffered(original)).toBe(true);
        // A session with no user activity is deliberately not persisted.
        const response = await original.sendAndWait({
            prompt: "Acknowledge this message without using tools.",
        });
        expect(response?.data.content).toBe("IMAGE_CONSENT_TURN_COMPLETE");
        expect(firstService.chatToolNames.some((names) => names.includes("image_generation"))).toBe(
            true
        );
        const sessionId = original.sessionId;
        await first.rpc.sessions.save({ sessionId });
        await original.disconnect();
        await first.stop();

        const secondService = new ImageService();
        await using second = createClient({
            requestHandler: secondService,
            connection: RuntimeConnection.forStdio(),
        });
        await using resumed = await second.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            featureFlags: { IMAGE_GENERATION_TOOL: true },
        });
        expect(await imageToolOffered(resumed)).toBe(false);
        const resumedResponse = await resumed.sendAndWait({
            prompt: "Acknowledge again without using tools.",
        });
        expect(resumedResponse?.data.content).toBe("IMAGE_CONSENT_TURN_COMPLETE");
        expect(secondService.chatToolNames.length).toBeGreaterThan(0);
        expect(
            secondService.chatToolNames.every((names) => !names.includes("image_generation"))
        ).toBe(true);
        await using optedIn = await second.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: true },
            featureFlags: { IMAGE_GENERATION_TOOL: false },
        });
        expect(await imageToolOffered(optedIn)).toBe(true);
    });
});

describe("Native image generation without a CAPI image model", async () => {
    const { createClient, openAiEndpoint } = await createSdkTestContext({
        replayOnly: true,
        backend: "capi",
    });

    it("still requires an image model from CAPI", async () => {
        const service = new ImageService(false);
        await using client = createClient({ requestHandler: service });
        await using session = await client.createSession({
            onPermissionRequest: approveAll,
            imageGeneration: { enabled: true },
            featureFlags: { IMAGE_GENERATION_TOOL: true },
        });
        expect(await imageToolOffered(session)).toBe(false);
        expect(service.imageRequests).toEqual([]);
    });

    it.each(["anthropic-messages", "openai-responses", "openai-completions"] as const)(
        "does not expose image generation for %s without CAPI image-model access",
        async (backend) => {
            const service = new ImageService(false);
            await using client = createClient({ requestHandler: service });
            await using session = await client.createSession(
                withTestBackend(
                    {
                        model: "claude-sonnet-5",
                        onPermissionRequest: approveAll,
                        imageGeneration: { enabled: true },
                        featureFlags: { IMAGE_GENERATION_TOOL: true },
                    },
                    backend,
                    openAiEndpoint.url
                )
            );
            expect(await imageToolOffered(session)).toBe(false);
            expect(service.imageRequests).toEqual([]);
        }
    );
});

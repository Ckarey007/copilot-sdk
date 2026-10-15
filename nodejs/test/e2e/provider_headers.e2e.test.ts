/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionEvent } from "../../src/index.js";
import { approveAll, defineTool } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const backends = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

describe.each(backends)("BYOK provider headers (%s)", async (backend) => {
    const {
        copilotClient: client,
        openAiEndpoint,
        workDir,
    } = await createSdkTestContext({
        backend,
        replayOnly: true,
    });

    it.each<{ name: string; headers: Record<string, string> }>([
        { name: "a single-character routing value", headers: { "x-agent-loop": "1" } },
        { name: "an ordinary text routing value", headers: { "x-client-name": "Passos" } },
    ])("preserves custom tool results with $name", async ({ headers }) => {
        // Replay the existing database-tool capture unchanged through each provider protocol.
        await openAiEndpoint.updateConfig({
            filePath: fileURLToPath(
                new URL(
                    "../../../test/snapshots/tools/can_receive_and_return_complex_types.yaml",
                    import.meta.url
                )
            ),
            workDir,
            backend,
            replayOnly: true,
        });

        const toolResult = [
            { countryId: 19, cityName: "Passos", population: 135460 },
            { countryId: 12, cityName: "San Lorenzo", population: 204356 },
        ];
        const expectedResult = JSON.stringify(toolResult);
        const handler = vi.fn(() => toolResult);
        const events: SessionEvent[] = [];
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            model: backend === "anthropic-messages" ? "claude-sonnet-5" : "gpt-4.1",
            provider: {
                type: backend === "anthropic-messages" ? "anthropic" : "openai",
                wireApi:
                    backend === "openai-responses"
                        ? "responses"
                        : backend === "openai-completions"
                          ? "completions"
                          : undefined,
                baseUrl: openAiEndpoint.url,
                bearerToken: "fake-byok-credential-for-e2e-tests",
                headers,
            },
            tools: [
                defineTool("db_query", {
                    description: "Performs a database query",
                    parameters: z.object({
                        query: z.object({
                            table: z.string(),
                            ids: z.array(z.number()),
                            sortAscending: z.boolean(),
                        }),
                    }),
                    handler,
                }),
            ],
            onEvent: (event) => events.push(event),
        });

        try {
            const reply = await session.sendAndWait({
                prompt:
                    "Perform a DB query for the 'cities' table using IDs 12 and 19, sorting ascending. " +
                    "Reply only with lines of the form: [cityname] [population]",
            });
            expect(reply?.data.content).toContain("Passos 135460");
            expect(handler).toHaveBeenCalledTimes(1);

            const completions = events.filter((event) => event.type === "tool.execution_complete");
            expect(completions).toHaveLength(1);
            expect(completions[0].data).toMatchObject({
                success: true,
                result: { content: expectedResult },
            });

            const exchanges = await openAiEndpoint.getExchanges();
            expect(exchanges).toHaveLength(2);
            const toolMessages = exchanges[1].request.messages.filter(
                (message) => message.role === "tool"
            );
            expect(toolMessages).toHaveLength(1);
            expect(toolMessages[0].content).toBe(expectedResult);

            for (const exchange of exchanges) {
                const sentHeaders = Object.fromEntries(
                    Object.entries(exchange.requestHeaders ?? {}).map(([name, value]) => [
                        name.toLowerCase(),
                        value,
                    ])
                );
                expect(sentHeaders).toMatchObject(headers);
            }
        } finally {
            await session.disconnect();
        }
    });
});

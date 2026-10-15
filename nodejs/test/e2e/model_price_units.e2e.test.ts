/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { CopilotRequestHandler } from "../../src/index.js";
import { formatModelTokenPrices } from "../../examples/model-token-prices.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Model price units account selection", async () => {
    const { createClient, env, openAiEndpoint } = await createSdkTestContext({
        useStdio: true,
        copilotClientOptions: {
            gitHubToken: undefined,
            useLoggedInUser: true,
            env: {
                COPILOT_GITHUB_TOKEN: "",
                GH_TOKEN: "",
                GITHUB_TOKEN: "",
                GITHUB_ASKPASS: "",
                COPILOT_GH_HOST: "github.com",
                GH_HOST: "github.com",
                COPILOT_HMAC_KEY: "",
                CAPI_HMAC_KEY: "",
                GITHUB_COPILOT_API_TOKEN: "",
                COPILOT_ENABLE_ALT_PROVIDERS: "false",
                COPILOT_DISABLE_KEYTAR: "1",
            },
        },
    });

    it("keeps selected-account units separate from the current account", async () => {
        const suffix = randomUUID();
        const currentToken = `price-units-current-${suffix}`;
        const selectedToken = `price-units-selected-${suffix}`;
        const modelId = `price-units-model-${suffix}`;
        const configPath = join(env.COPILOT_HOME, "config.json");
        const profile = {
            storeTokenPlaintext: true,
            loggedInUsers: [
                { host: "https://github.com", login: "current", kind: "githubDotCom" },
                { host: "https://github.com", login: "selected", kind: "githubDotCom" },
            ],
            lastLoggedInUser: { host: "https://github.com", login: "current" },
            authTokens: {
                "https://github.com:current:github": { token: currentToken },
                "https://github.com:selected:github": { token: selectedToken },
            },
        };
        await writeFile(configPath, JSON.stringify(profile));
        for (const [token, login] of [
            [currentToken, "current"],
            [selectedToken, "selected"],
        ]) {
            await openAiEndpoint.setCopilotUserByToken(token, {
                login,
                copilot_plan: "individual_pro",
                endpoints: { api: env.COPILOT_API_URL },
                analytics_tracking_id: `${login}-${suffix}`,
            });
        }

        class CatalogHandler extends CopilotRequestHandler {
            protected override async sendRequest(request: Request): Promise<Response> {
                expect(new URL(request.url).pathname).toBe("/models");
                const authorization = request.headers.get("authorization");
                expect([`Bearer ${currentToken}`, `Bearer ${selectedToken}`]).toContain(
                    authorization
                );
                const prices = { input_price: 10, output_price: 20 };
                return Response.json({
                    data: [
                        {
                            id: modelId,
                            name: "Account-specific prices",
                            capabilities: { type: "chat", supports: { tool_calls: true } },
                            billing: {
                                token_prices: {
                                    batch_size: 1_000_000,
                                    ...(authorization === `Bearer ${selectedToken}`
                                        ? { default: prices }
                                        : prices),
                                },
                            },
                        },
                    ],
                });
            }
        }

        const client = createClient({
            gitHubToken: undefined,
            useLoggedInUser: true,
            requestHandler: new CatalogHandler(),
        });
        onTestFinished(async () => {
            const errors = await client.stop();
            if (errors.length > 0) {
                throw new AggregateError(errors, "Price-unit client cleanup failed");
            }
        });
        await client.start();
        const accounts = await client.rpc.account.getAllUsers();
        const selected = accounts.find(
            ({ authInfo }) => authInfo.type === "user" && authInfo.login === "selected"
        );
        if (!selected?.selectionId) {
            throw new Error("The saved alternate account has no selection ID");
        }
        const selection = Object.freeze({ selectionId: selected.selectionId });
        const selectedModels = await client.rpc.models.list(selection);
        expect(
            selectedModels.models.find(({ id }) => id === modelId)?.billing?.tokenPrices
        ).toMatchObject({ inputPrice: 10, outputPrice: 20 });

        const currentUnits = { units: [{ modelId, unit: "nano_aiu" }] };
        const selectedUnits = { units: [{ modelId, unit: "ai_credits" }] };
        expect(await client.rpc.models.listTokenPriceUnits()).toEqual(currentUnits);
        expect(await client.rpc.models.listTokenPriceUnits(selection)).toEqual(selectedUnits);
        expect(await client.rpc.models.listTokenPriceUnits({ gitHubToken: selectedToken })).toEqual(
            selectedUnits
        );
        expect(await client.rpc.models.listTokenPriceUnits({})).toEqual(currentUnits);
        expect(JSON.parse(await formatModelTokenPrices(client, selection))).toEqual([
            {
                modelId,
                unit: "ai_credits",
                prices: expect.objectContaining({ inputPrice: 10, outputPrice: 20 }),
            },
        ]);
        expect(selection).toEqual({ selectionId: selected.selectionId });
        const saved = JSON.parse((await readFile(configPath, "utf8")).replace(/^\/\/.*$/gm, ""));
        expect(saved.lastLoggedInUser).toEqual(profile.lastLoggedInUser);
        expect(saved.authTokens).toEqual(profile.authTokens);
    });
});

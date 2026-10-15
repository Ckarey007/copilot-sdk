/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { approveAll, CopilotClient, RuntimeConnection } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

const { openAiEndpoint, env, workDir } = await createSdkTestContext({
    useStdio: true,
    copilotClientOptions: { gitHubToken: undefined, useLoggedInUser: false },
});
let loginEnv: NodeJS.ProcessEnv;
const githubToken = "ghu_sdk_entra_login";
beforeAll(async () => {
    loginEnv = {
        ...env,
        COPILOT_ENTRA_ONEAUTH: "0",
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        COPILOT_GITHUB_TOKEN: "",
        COPILOT_SDK_AUTH_TOKEN: "",
        GITHUB_COPILOT_API_TOKEN: "",
        COPILOT_HMAC_KEY: "",
        CAPI_HMAC_KEY: "",
        COPILOT_DISABLE_KEYTAR: "1",
        COPILOT_DEBUG_ENTRA_BROKER_URL: `${env.COPILOT_API_URL}/entra-broker`,
    };
    await openAiEndpoint.setEntraLogin("sdk-entra-subject", githubToken);
    await openAiEndpoint.setCopilotUserByToken(githubToken, {
        login: "sdk_entra_user",
        copilot_plan: "business",
        is_staff: false,
        is_mcp_enabled: true,
        endpoints: { api: env.COPILOT_API_URL, telemetry: "https://localhost:1/telemetry" },
    });
});

function clientForTest(overrides: Record<string, string> = {}): CopilotClient {
    const client = new CopilotClient({
        workingDirectory: workDir,
        env: { ...loginEnv, ...overrides },
        useLoggedInUser: false,
        connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
    });
    onTestFinished(() => client.stop());
    return client;
}

describe.skipIf(process.platform === "linux")("Shared Entra login", () => {
    it("reports an unavailable opted-in native backend without starting the web fallback", async () => {
        const client = clientForTest({
            COPILOT_ENTRA_ONEAUTH: "1",
            COPILOT_ENTRA_DISABLE_ONEAUTH: "1",
            COPILOT_DEBUG_ENTRA_BROKER_URL: "",
        });
        await using session = await client.createSession({ onPermissionRequest: approveAll });
        const providers = await session.rpc.accounts.enumerate({ query: { kind: "providers" } });
        expect(providers).toMatchObject({
            kind: "providers",
            items: expect.arrayContaining([
                expect.objectContaining({ kind: "entra", available: false }),
            ]),
        });
        const { flowId } = await session.rpc.accounts.login.begin({ kind: "entra" });
        await expect(session.rpc.accounts.login.advance({ flowId })).rejects.toThrow(
            "ENTRA_UNAVAILABLE"
        );
        expect(await session.rpc.accounts.get({ query: { kind: "activeAccount" } })).toEqual({
            kind: "activeAccount",
            account: null,
        });
    });

    it("returns a cancellable flow before discovery and preserves session ownership", async () => {
        const client = clientForTest();
        await using session = await client.createSession({ onPermissionRequest: approveAll });
        await using other = await client.createSession({ onPermissionRequest: approveAll });
        const providers = await session.rpc.accounts.enumerate({ query: { kind: "providers" } });
        expect(providers.kind).toBe("providers");
        if (providers.kind !== "providers") throw new Error("Expected provider descriptors");
        expect(providers.items).toContainEqual(
            expect.objectContaining({ kind: "entra", available: true })
        );
        const begun = await session.rpc.accounts.login.begin({ kind: "entra" });
        expect(begun.step).toEqual({ kind: "awaiting" });
        await expect(other.rpc.accounts.login.cancel({ flowId: begun.flowId })).rejects.toThrow(
            "different session"
        );
        await session.rpc.accounts.login.cancel({ flowId: begun.flowId });
        await expect(session.rpc.accounts.login.advance({ flowId: begun.flowId })).rejects.toThrow(
            "Unknown or completed"
        );
    });

    it("completes Entra sign-in through the public API and applies the live session", async () => {
        const client = clientForTest();
        await using session = await client.createSession({ onPermissionRequest: approveAll });
        const begun = await session.rpc.accounts.login.begin({ kind: "entra" });
        const request = { flowId: begun.flowId };
        expect(await session.rpc.accounts.login.advance(request)).toEqual({
            kind: "needs-interaction",
        });
        expect(await session.rpc.accounts.login.advance(request)).toEqual({
            kind: "completed",
            result: { status: "needs-plaintext-consent" },
        });
        const completed = await session.rpc.accounts.login.advance({ ...request, input: "allow" });
        expect(completed).toEqual({
            kind: "completed",
            result: {
                status: "completed",
                host: "https://github.com",
                login: "sdk_entra_user",
            },
        });
        expect(await session.rpc.gitHubAuth.getStatus()).toMatchObject({
            isAuthenticated: true,
            login: "sdk_entra_user",
        });
        const active = await session.rpc.accounts.get({ query: { kind: "activeAccount" } });
        expect(active).toMatchObject({
            kind: "activeAccount",
            account: { login: "sdk_entra_user", kind: "entraEmu", active: true },
            authInfo: { host: "https://github.com", login: "sdk_entra_user" },
        });
        expect(JSON.stringify(active)).not.toContain(githubToken);
        expect(JSON.stringify(active)).not.toContain("sdk-entra-subject");
        const identities = await session.rpc.accounts.enumerate({
            query: { kind: "loginAccounts", provider: "entra" },
        });
        expect(identities).toEqual({
            kind: "loginAccounts",
            items: [
                {
                    accountId: "entra:entra-sdk-account",
                    label: "entra-sdk@example.test",
                    active: true,
                },
            ],
        });
        if (identities.kind !== "loginAccounts")
            throw new Error("Expected cached login identities");
        const cached = await session.rpc.accounts.login.begin({
            kind: "entra",
            accountId: identities.items[0].accountId,
        });
        await session.rpc.accounts.login.cancel({ flowId: cached.flowId });
        const selectAccount = await session.rpc.accounts.login.begin({
            kind: "entra",
            mode: "selectAccount",
        });
        await session.rpc.accounts.login.cancel({ flowId: selectAccount.flowId });
        await expect(session.rpc.accounts.login.advance(request)).rejects.toThrow(
            "Unknown or completed"
        );
    });

    it("declines storage consent without activating an account", async () => {
        const client = clientForTest();
        await using session = await client.createSession({ onPermissionRequest: approveAll });
        const { flowId } = await session.rpc.accounts.login.begin({ kind: "entra" });
        await session.rpc.accounts.login.advance({ flowId });
        await session.rpc.accounts.login.advance({ flowId });
        expect(await session.rpc.accounts.login.advance({ flowId, input: "decline" })).toEqual({
            kind: "completed",
            result: { status: "declined" },
        });
        expect(await session.rpc.accounts.get({ query: { kind: "activeAccount" } })).toEqual({
            kind: "activeAccount",
            account: null,
        });
    });
});

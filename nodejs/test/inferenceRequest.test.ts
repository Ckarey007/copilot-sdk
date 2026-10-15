/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";
import { inferenceModelOptions, userMessageText } from "./e2e/harness/inferenceRequest";

describe("inference request model options", () => {
    it.each([
        ["/chat/completions", { reasoning_effort: "high" }],
        ["/responses", { reasoning: { effort: "high" } }],
        ["/v1/messages", { output_config: { effort: "high" } }],
        ["/messages", { output_config: { effort: "high" } }],
    ])("reads model and effort from %s without consuming the request", async (path, effort) => {
        const body = { model: "custom-wire-model", ...effort };
        const request = new Request(`https://provider.test${path}?api-version=test`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        expect(await inferenceModelOptions(request)).toEqual({
            model: "custom-wire-model",
            reasoning_effort: "high",
        });
        expect(await request.json()).toEqual(body);
    });

    it.each(["/models", "/user"])("ignores a non-inference request: %s", async (path) => {
        expect(
            await inferenceModelOptions(new Request(`https://provider.test${path}`))
        ).toBeUndefined();
    });

    it("retains absent optional model options", async () => {
        const request = new Request("https://provider.test/responses", {
            method: "POST",
            body: "{}",
        });
        expect(await inferenceModelOptions(request)).toEqual({
            model: undefined,
            reasoning_effort: undefined,
        });
    });

    it("retains arbitrary model IDs and effort strings", async () => {
        const request = new Request("https://provider.test/chat/completions", {
            method: "POST",
            body: JSON.stringify({ model: "User Model Name", reasoning_effort: "custom-effort" }),
        });
        expect(await inferenceModelOptions(request)).toEqual({
            model: "User Model Name",
            reasoning_effort: "custom-effort",
        });
    });

    it("treats null optional effort fields as absent", async () => {
        const request = new Request("https://provider.test/responses", {
            method: "POST",
            body: JSON.stringify({ model: "literal", reasoning: null }),
        });
        expect(await inferenceModelOptions(request)).toEqual({
            model: "literal",
            reasoning_effort: undefined,
        });
    });

    it("rejects malformed inference model fields", async () => {
        const request = new Request("https://provider.test/responses", {
            method: "POST",
            body: JSON.stringify({ model: 123 }),
        });
        await expect(inferenceModelOptions(request)).rejects.toThrow();
    });
});

describe("inference request user text", () => {
    const context = "Hook context\n\nRead the requested file.";

    it.each(["text", "input_text"])("reads %s content without assistant or tool text", (type) => {
        const messages = [
            { role: "system", content: "Not user text" },
            { role: "user", content: [{ type, text: context }] },
            { role: "assistant", content: context },
            { type: "function_call_output", output: context },
        ];
        const body = type === "input_text" ? { input: messages } : { messages };
        expect(userMessageText(body)).toEqual([context]);
    });

    it("reads string input used by Responses", () => {
        expect(userMessageText({ input: context })).toEqual([context]);
    });

    it("reads string user messages used by Chat Completions", () => {
        expect(userMessageText({ messages: [{ role: "user", content: context }] })).toEqual([
            context,
        ]);
    });

    it.each([{}, { input: [] }, { messages: [] }])("handles empty requests: %j", (body) => {
        expect(userMessageText(body)).toEqual([]);
    });

    it("ignores non-text and malformed content parts", () => {
        expect(
            userMessageText({
                input: [
                    { role: "user", content: [null, {}, { type: "input_image", text: context }] },
                    { role: "user", content: null },
                ],
            })
        ).toEqual([]);
    });
});

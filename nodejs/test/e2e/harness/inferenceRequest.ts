/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { z } from "zod";

export async function inferenceModelOptions(
    request: Request
): Promise<{ model?: string; reasoning_effort?: string } | undefined> {
    const path = new URL(request.url).pathname;
    if (!["/chat/completions", "/responses", "/v1/messages", "/messages"].includes(path)) {
        return undefined;
    }
    const options = z
        .object({
            model: z.string().optional(),
            reasoning_effort: z.string().nullish(),
            reasoning: z.object({ effort: z.string().nullish() }).nullish(),
            output_config: z.object({ effort: z.string().nullish() }).nullish(),
        })
        .parse(await request.clone().json());
    const effort =
        path === "/responses"
            ? options.reasoning?.effort
            : path === "/chat/completions"
              ? options.reasoning_effort
              : options.output_config?.effort;
    return { model: options.model, reasoning_effort: effort ?? undefined };
}

export function userMessageText(body: {
    messages?: { role?: string; content?: unknown }[];
    input?: string | { role?: string; content?: unknown }[];
}): string[] {
    if (typeof body.input === "string") {
        return [body.input];
    }
    return (body.messages ?? body.input ?? []).flatMap((message) => {
        if (message.role !== "user") {
            return [];
        }
        if (typeof message.content === "string") {
            return [message.content];
        }
        if (!Array.isArray(message.content)) {
            return [];
        }
        return message.content
            .filter(
                (part): part is { type: string; text: string } =>
                    (part?.type === "text" || part?.type === "input_text") &&
                    typeof part.text === "string"
            )
            .map((part) => part.text);
    });
}

// Copyright (c) Microsoft Corporation. All rights reserved.

import { describe, expect, it } from "vitest";
import type { MessageConnection } from "vscode-jsonrpc/node.js";
import { CopilotSession } from "../src/session.js";
import type { BaseHookInput, SessionHooks } from "../src/types.js";

const hooks = [
    ["preToolUse", "onPreToolUse"],
    ["preMcpToolCall", "onPreMcpToolCall"],
    ["postToolUse", "onPostToolUse"],
    ["postToolUseFailure", "onPostToolUseFailure"],
    ["userPromptSubmitted", "onUserPromptSubmitted"],
    ["userPromptTransformed", "onUserPromptTransformed"],
    ["sessionStart", "onSessionStart"],
    ["sessionEnd", "onSessionEnd"],
    ["errorOccurred", "onErrorOccurred"],
    ["agentStop", "onAgentStop"],
    ["subagentStart", "onSubagentStart"],
    ["subagentStop", "onSubagentStop"],
] as const;

describe("typed hook identity", () => {
    for (const [hook, handler] of hooks) {
        for (const enriched of [true, false]) {
            it(`${hook} preserves ${enriched ? "child identity" : "old root input"}`, async () => {
                const session = new CopilotSession("callback-owner", {} as MessageConnection);
                const captured: BaseHookInput[] = [];
                session.registerHooks({
                    [handler]: (input: BaseHookInput, invocation: { sessionId: string }) => {
                        expect(invocation.sessionId).toBe("callback-owner");
                        captured.push(input);
                    },
                } as SessionHooks);
                const identity = {
                    agentId: "child-actor",
                    agentType: "explore",
                    parentAgentId: "parent-actor",
                };
                await session._handleHooksInvoke(hook, {
                    sessionId: "reported-session",
                    timestamp: 1,
                    cwd: "work",
                    ...(enriched ? identity : {}),
                });
                expect(captured).toHaveLength(1);
                const input = captured[0];
                if (input === undefined) {
                    throw new Error("Hook callback was not dispatched");
                }
                expect(input.sessionId).toBe("reported-session");
                expect(input.timestamp).toEqual(new Date(1));
                expect([input.agentId, input.agentType, input.parentAgentId]).toEqual(
                    enriched
                        ? ["child-actor", "explore", "parent-actor"]
                        : [undefined, undefined, undefined]
                );
                const oldRoot: BaseHookInput = {
                    sessionId: "root",
                    timestamp: new Date(1),
                    workingDirectory: "work",
                };
                expect(oldRoot.agentId).toBeUndefined();
            });
        }
    }
});

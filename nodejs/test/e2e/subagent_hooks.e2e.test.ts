/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { copyFile, mkdir, readFile, readdir, writeFile } from "fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "path";
import { describe, expect, it } from "vitest";
import type {
    CopilotRequestContext,
    PreToolUseHookInput,
    PreToolUseHookOutput,
    PostToolUseHookInput,
    PostToolUseHookOutput,
    SubagentStartHookInput,
    SubagentStopHookInput,
} from "../../src/index.js";
import { approveAll, CopilotRequestHandler } from "../../src/index.js";
import { createSdkTestContext, isCI } from "./harness/sdkTestContext.js";
import { childUserPrompts } from "./harness/childUserPrompts.js";

const CHILD_CONTEXT = "Subagent start hook verified: read the requested file.";
const CHILD_CONTEXT_PREFIX = `${CHILD_CONTEXT}\n\n`;
const STOP_RESPONSE_PREFIX = "Subagent stop hook verified: ";
const SUBAGENT_TEST_TIMEOUT_MS = 120_000;

interface RequestRecord {
    url: string;
    agentId?: string;
    parentAgentId?: string;
    interactionType?: string;
}

class RecordingRequestHandler extends CopilotRequestHandler {
    readonly records: RequestRecord[] = [];
    readonly childPromptsWithHookContext: string[] = [];
    readonly parentRequestsWithModifiedResponse: string[] = [];

    protected override async sendRequest(
        request: Request,
        ctx: CopilotRequestContext
    ): Promise<Response> {
        this.records.push({
            url: request.url,
            agentId: ctx.agentId,
            parentAgentId: ctx.parentAgentId,
            interactionType: ctx.interactionType,
        });
        if (isInferenceUrl(request.url)) {
            const body = await request.clone().text();
            if (ctx.parentAgentId) {
                this.childPromptsWithHookContext.push(
                    ...childUserPrompts(request.url, body, ctx).filter((part) =>
                        part.includes(CHILD_CONTEXT_PREFIX)
                    )
                );
            } else if (body.includes(STOP_RESPONSE_PREFIX)) {
                this.parentRequestsWithModifiedResponse.push(body);
            }
        }
        return super.sendRequest(request, ctx);
    }
}

function isInferenceUrl(url: string): boolean {
    const u = url.toLowerCase();
    return (
        u.endsWith("/chat/completions") ||
        u.endsWith("/responses") ||
        u.endsWith("/v1/messages") ||
        u.endsWith("/messages")
    );
}

function expectSubagentRequestMetadata(records: RequestRecord[]): void {
    const inference = records.filter((r) => isInferenceUrl(r.url));
    expect(inference.length, "request handler should observe inference requests").toBeGreaterThan(
        0
    );

    const subagentRequest = inference.find((r) => r.parentAgentId);
    expect(
        subagentRequest,
        "sub-agent inference request should carry a parentAgentId"
    ).toBeDefined();
    expect(
        subagentRequest!.agentId,
        "sub-agent inference request should carry an agentId"
    ).toBeTruthy();
    expect(
        subagentRequest!.interactionType,
        "sub-agent inference request should carry an interactionType"
    ).toBeTruthy();
    expect(subagentRequest!.parentAgentId).not.toBe(subagentRequest!.agentId);
}

describe("Subagent hooks", async () => {
    // For snapshot recording (non-CI), use RECORD_GH_TOKEN if available
    const recordToken = !isCI ? process.env.RECORD_GH_TOKEN : undefined;
    const requestHandler = new RecordingRequestHandler();
    const {
        copilotClient: client,
        workDir,
        env,
    } = await createSdkTestContext({
        copilotClientOptions: {
            ...(recordToken ? { gitHubToken: recordToken } : {}),
            requestHandler,
            env: { COPILOT_EXP_COPILOT_CLI_SESSION_BASED_SUBAGENTS: "true" },
        },
    });

    it(
        "should apply subagent lifecycle hook outputs",
        async () => {
            const hookLog: {
                kind: "pre" | "post";
                toolName: string;
                sessionId: string;
                input: PreToolUseHookInput | PostToolUseHookInput;
            }[] = [];
            const startInputs: { input: SubagentStartHookInput; invocationSessionId: string }[] =
                [];
            const stopInputs: { input: SubagentStopHookInput; invocationSessionId: string }[] = [];
            const waitingText =
                "I've launched an explore agent to read subagent-test.txt. Waiting for it to complete...";
            const finalText =
                "The explore agent successfully read the file. The contents of **subagent-test.txt** are:\n\n```\nHello from subagent test!\n```";
            const parentSessionId = randomUUID();
            const capturesDir = join(workDir, "hook-inputs");
            const hooksDir = join(workDir, ".github", "hooks");
            await mkdir(capturesDir);
            await mkdir(hooksDir, { recursive: true });
            await mkdir(env.COPILOT_HOME, { recursive: true });
            await writeFile(
                join(env.COPILOT_HOME, "config.json"),
                JSON.stringify({ trustedFolders: [workDir] })
            );
            await copyFile(
                new URL("./fixtures/hook-identity-recorder.cjs", import.meta.url),
                join(workDir, "hook-recorder.cjs")
            );
            const repositoryHooks: Record<string, object[]> = {};
            for (const [native, claude] of [
                ["preToolUse", "PreToolUse"],
                ["postToolUse", "PostToolUse"],
                ["subagentStart", "SubagentStart"],
                ["subagentStop", "SubagentStop"],
            ]) {
                for (const [event, dialect] of [
                    [native, "native"],
                    [claude, "claude"],
                ]) {
                    repositoryHooks[event] = [
                        {
                            type: "command",
                            exec: process.execPath,
                            args: ["hook-recorder.cjs", `${native}.${dialect}`, capturesDir],
                        },
                    ];
                }
            }
            await writeFile(
                join(hooksDir, "identity.json"),
                JSON.stringify({ version: 1, hooks: repositoryHooks })
            );
            let releaseView!: () => void;
            const parentWaiting = new Promise<void>((resolve) => {
                releaseView = resolve;
            });

            const session = await client.createSession({
                sessionId: parentSessionId,
                onPermissionRequest: approveAll,
                hooks: {
                    onPreToolUse: async (input: PreToolUseHookInput) => {
                        hookLog.push({
                            kind: "pre",
                            toolName: input.toolName,
                            sessionId: input.sessionId,
                            input,
                        });
                        return { permissionDecision: "allow" } as PreToolUseHookOutput;
                    },
                    onPostToolUse: async (input: PostToolUseHookInput) => {
                        hookLog.push({
                            kind: "post",
                            toolName: input.toolName,
                            sessionId: input.sessionId,
                            input,
                        });
                        // A fast child can inject its result before the parent ever asks for the fixture's waiting reply.
                        if (input.toolName === "view" && input.sessionId !== parentSessionId)
                            await parentWaiting;
                        return null as PostToolUseHookOutput;
                    },
                    onSubagentStart: (input, invocation) => {
                        startInputs.push({ input, invocationSessionId: invocation.sessionId });
                        return { additionalContext: CHILD_CONTEXT };
                    },
                    onSubagentStop: (input, invocation) => {
                        stopInputs.push({ input, invocationSessionId: invocation.sessionId });
                        return { modifiedResponse: `${STOP_RESPONSE_PREFIX}${input.response}` };
                    },
                },
            });
            // Create a file for the sub-agent to read
            await writeFile(join(workDir, "subagent-test.txt"), "Hello from subagent test!");

            const unsubscribe = session.on((event) => {
                if (
                    !event.agentId &&
                    event.type === "assistant.message" &&
                    event.data.content === waitingText
                ) {
                    releaseView();
                }
            });
            try {
                const response = await session.sendAndWait({
                    prompt: "Use the task tool to spawn an explore agent that reads the file subagent-test.txt in the current directory and reports its contents. You must use the task tool.",
                });
                expect(response?.agentId ?? "").toBe("");
                expect(response?.data.content).toBe(finalText);
                expect(
                    (await session.getEvents())
                        .filter((event) => !event.agentId && event.type === "assistant.message")
                        .map((event) => event.data.content)
                        .filter((content) => content === waitingText || content === finalText)
                ).toEqual([waitingText, finalText]);
            } finally {
                releaseView();
                unsubscribe();
            }

            // Parent tool hooks fire for "task"
            const taskPre = hookLog.find((h) => h.kind === "pre" && h.toolName === "task");
            expect(
                taskPre,
                "preToolUse should fire for the parent's 'task' tool call"
            ).toBeDefined();

            // Sub-agent tool hooks fire for "view"
            const viewPre = hookLog.filter((h) => h.kind === "pre" && h.toolName === "view");
            const viewPost = hookLog.filter((h) => h.kind === "post" && h.toolName === "view");
            expect(
                viewPre.length,
                "preToolUse should fire for the sub-agent's 'view' tool call"
            ).toBeGreaterThan(0);
            expect(
                viewPost.length,
                "postToolUse should fire for the sub-agent's 'view' tool call"
            ).toBeGreaterThan(0);

            // input.sessionId distinguishes parent from sub-agent: parent tools and
            // sub-agent tools carry different sessionIds
            expect(viewPre[0].sessionId).not.toBe(taskPre!.sessionId);
            expectSubagentRequestMetadata(requestHandler.records);

            await expect
                .poll(() => stopInputs.length, { timeout: SUBAGENT_TEST_TIMEOUT_MS })
                .toBeGreaterThan(0);

            const start = startInputs.find(({ input }) => input.agentName === "explore");
            const stop = stopInputs.find(({ input }) => input.agentType === "explore");
            expect(start, "subagentStart should fire for the explore agent").toBeDefined();
            expect(stop, "subagentStop should fire for the explore agent").toBeDefined();
            expect(start!.invocationSessionId).toBe(session.sessionId);
            expect(start!.input.sessionId).toBe(session.sessionId);
            expect(start!.input.timestamp).toBeInstanceOf(Date);
            expect(start!.input.workingDirectory).toBe(workDir);
            expect(typeof start!.input.transcriptPath).toBe("string");
            expect(start!.input.agentDisplayName).toBeUndefined();
            expect(start!.input.agentDescription).toBeUndefined();

            expect(stop!.invocationSessionId).toBe(session.sessionId);
            expect(stop!.input.sessionId).toBe(session.sessionId);
            expect(stop!.input.timestamp).toBeInstanceOf(Date);
            expect(stop!.input.timestamp.getTime()).toBeGreaterThanOrEqual(
                start!.input.timestamp.getTime()
            );
            expect(stop!.input.workingDirectory).toBe(workDir);
            expect(stop!.input.transcriptPath).toBe(start!.input.transcriptPath);
            expect(stop!.input.agentName).toBe(start!.input.agentName);
            expect(stop!.input.agentDisplayName).toBe(start!.input.agentDisplayName);
            expect(stop!.input.agentDescription).toBe(start!.input.agentDescription);
            expect(stop!.input.agentId).toBeTruthy();
            expect(stop!.input.agentType).toBe("explore");
            expect(start!.input).toMatchObject({
                agentId: stop!.input.agentId,
                agentType: "explore",
                parentAgentId: session.sessionId,
            });
            for (const { input } of [...viewPre, ...viewPost]) {
                expect(input).toMatchObject({
                    agentId: stop!.input.agentId,
                    agentType: "explore",
                    parentAgentId: session.sessionId,
                });
            }
            for (const { input } of hookLog.filter((hook) => hook.sessionId === parentSessionId)) {
                expect(input).not.toHaveProperty("agentId");
                expect(input).not.toHaveProperty("agentType");
                expect(input).not.toHaveProperty("parentAgentId");
            }
            expect(stop!.input.stopReason).toBe("end_turn");
            expect(stop!.input.response).toContain("Hello from subagent test!");

            expect(
                requestHandler.childPromptsWithHookContext.some((prompt) =>
                    prompt.includes(`${CHILD_CONTEXT_PREFIX}Read the file "subagent-test.txt"`)
                ),
                "the start hook's additionalContext should be prepended to the child's model prompt"
            ).toBe(true);
            await expect
                .poll(() => requestHandler.parentRequestsWithModifiedResponse.length, {
                    timeout: SUBAGENT_TEST_TIMEOUT_MS,
                })
                .toBeGreaterThan(0);
            const capturedInputs = await Promise.all(
                (await readdir(capturesDir)).map(async (name) => {
                    return JSON.parse(await readFile(join(capturesDir, name), "utf8")) as {
                        hook: string;
                        input: Record<string, unknown>;
                    };
                })
            );
            for (const dialect of ["native", "claude"]) {
                const [idKey, typeKey, parentKey, toolKey, childTool, parentTool] =
                    dialect === "native"
                        ? ["agentId", "agentType", "parentAgentId", "toolName", "view", "task"]
                        : [
                              "agent_id",
                              "agent_type",
                              "parent_agent_id",
                              "tool_name",
                              "Read",
                              "Agent",
                          ];
                for (const event of ["preToolUse", "postToolUse"]) {
                    const inputs = capturedInputs.filter(
                        (record) => record.hook === `${event}.${dialect}`
                    );
                    const childInputs = inputs.filter(
                        (record) => record.input[toolKey] === childTool
                    );
                    const parentInputs = inputs.filter(
                        (record) => record.input[toolKey] === parentTool
                    );
                    expect(
                        childInputs,
                        `${event}/${dialect} must run in the child`
                    ).not.toHaveLength(0);
                    expect(
                        parentInputs,
                        `${event}/${dialect} must run in the parent`
                    ).not.toHaveLength(0);
                    for (const { input } of childInputs) {
                        expect(input).toMatchObject({
                            [idKey]: stop!.input.agentId,
                            [typeKey]: "explore",
                            [parentKey]: parentSessionId,
                        });
                    }
                    for (const { input } of parentInputs) {
                        expect(input).not.toHaveProperty(idKey);
                        expect(input).not.toHaveProperty(typeKey);
                        expect(input).not.toHaveProperty(parentKey);
                    }
                }
                for (const event of ["subagentStart", "subagentStop"]) {
                    const inputs = capturedInputs.filter(
                        (record) => record.hook === `${event}.${dialect}`
                    );
                    expect(inputs, `${event}/${dialect} must describe the one child`).toHaveLength(
                        1
                    );
                    expect(inputs[0].input).toMatchObject({
                        [idKey]: stop!.input.agentId,
                        [typeKey]: "explore",
                        [parentKey]: parentSessionId,
                    });
                    expect(inputs[0].input.sessionId ?? inputs[0].input.session_id).toBe(
                        parentSessionId
                    );
                }
            }
            const transcript = await session.getEvents();
            const hookStarts = transcript.filter(
                (event) =>
                    event.type === "hook.start" &&
                    ["preToolUse", "postToolUse", "subagentStart", "subagentStop"].includes(
                        event.data.hookType
                    )
            );
            expect(
                hookStarts.some(
                    (event) =>
                        event.agentId === stop!.input.agentId &&
                        event.data.hookType === "preToolUse"
                ),
                "the transcript must attribute child hooks to the same stable identity"
            ).toBe(true);
            for (const start of hookStarts) {
                const end = transcript.find(
                    (event) =>
                        event.type === "hook.end" &&
                        event.data.hookInvocationId === start.data.hookInvocationId
                );
                expect(
                    end,
                    `hook ${start.data.hookInvocationId} must have completed`
                ).toMatchObject({
                    data: { success: true },
                });
            }
            await session.disconnect();
        },
        SUBAGENT_TEST_TIMEOUT_MS
    );
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, rename, writeFile } from "node:fs/promises";
import { joinSession } from "@github/copilot-sdk/extension";
import { CopilotClient } from "@github/copilot-sdk";

const url = process.env.EXTENSION_HTTP_MCP_URL;
const statusPath = process.env.EXTENSION_HTTP_MCP_STATUS;
const callsPath = process.env.EXTENSION_HTTP_MCP_CALLS;
if (!url || !statusPath || !callsPath) {
    throw new Error("HTTP MCP extension fixture requires its URL, status path, and calls path");
}

async function recordStatus(status) {
    const pendingPath = `${statusPath}.pending`;
    await writeFile(pendingPath, JSON.stringify(status));
    await rename(pendingPath, statusPath);
}

const serverName = process.env.EXTENSION_HTTP_MCP_SERVER_NAME ?? "extensionprobe";
const directToolName = process.env.EXTENSION_DIRECT_TOOL_NAME ?? "extension_direct_probe";
const declaredServers = {
    [serverName]: { type: "http", url, tools: ["http_probe"], timeout: 5000 },
};
const mcpServers =
    process.env.EXTENSION_HTTP_MCP_OMIT_MAP === "1"
        ? undefined
        : process.env.EXTENSION_HTTP_MCP_EMPTY_MAP === "1"
          ? {}
          : declaredServers;

const tools = [
    {
        name: directToolName,
        description: "Record a marker in the extension process and return it.",
        parameters: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
            additionalProperties: false,
        },
        handler: async ({ marker }) => {
            if (typeof marker !== "string") {
                throw new Error("Direct probe requires a string marker");
            }
            await appendFile(callsPath, `${JSON.stringify({ marker })}\n`);
            return `EXTENSION_DIRECT_REPLY_${marker}`;
        },
    },
];

async function publishJoin(config, join = joinSession) {
    const session = await join(config);
    await recordStatus({
        state: "joined",
        sessionId: session.sessionId,
        sdkPath: process.env.COPILOT_SDK_PATH,
        mcpServers: mcpServers ?? {},
    });
}

async function recordFailure(error) {
    await recordStatus({
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
    });
    throw error;
}

try {
    const gateUrl = process.env.EXTENSION_JOIN_GATE_URL;
    if (gateUrl) {
        // Both resumes share one stdin reader and one routable session per ID.
        const client = new CopilotClient({ _internalConnection: { kind: "parent-process" } });
        const join = (config) =>
            client.resumeSessionForExtension(process.env.SESSION_ID, {
                ...config,
                onPermissionRequest: () => ({ kind: "no-result" }),
                suppressResumeEvent: true,
            });
        await join({ tools });
        void (async () => {
            const response = await fetch(gateUrl);
            if (!response.ok)
                throw new Error(`Extension join gate failed: HTTP ${response.status}`);
            await publishJoin({ tools, ...(mcpServers ? { mcpServers } : {}) }, join);
        })().catch(recordFailure);
    } else {
        await publishJoin({ tools, ...(mcpServers ? { mcpServers } : {}) });
    }
} catch (error) {
    await recordFailure(error);
}

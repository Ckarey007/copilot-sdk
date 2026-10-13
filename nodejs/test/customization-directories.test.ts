// Copyright (c) Microsoft Corporation. All rights reserved.

import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { CopilotClient, RuntimeConnection, approveAll } from "../src/index.js";
import { getSdkProtocolVersion } from "../src/sdkProtocolVersion.js";

describe("customization directory adapters", () => {
    it.each([
        { name: "omitted", roots: undefined },
        { name: "empty", roots: [] },
        { name: "relative", roots: ["relative-root", "other-root"] },
    ])("preserves supplied roots on create and resume: $name", async ({ roots }) => {
        const requests = new Map<string, Record<string, unknown>>();
        const peers: { connection: MessageConnection; socket: Socket }[] = [];
        let client: CopilotClient | undefined;
        const server = createServer((socket) => {
            const connection = createMessageConnection(
                new StreamMessageReader(socket),
                new StreamMessageWriter(socket)
            );
            peers.push({ connection, socket });
            connection.onRequest("connect", () => ({
                ok: true,
                protocolVersion: getSdkProtocolVersion(),
                version: "adapter-test",
            }));
            for (const method of ["session.create", "session.resume"]) {
                connection.onRequest(method, (params: Record<string, unknown>) => {
                    requests.set(method, params);
                    return { sessionId: params.sessionId };
                });
            }
            connection.onRequest("session.options.update", () => ({}));
            connection.onRequest("session.detach", () => ({ success: true }));
            connection.onRequest("session.skills.reload", () => ({}));
            connection.listen();
        });
        onTestFinished(async () => {
            try {
                await client?.forceStop();
            } finally {
                for (const peer of peers) {
                    peer.connection.dispose();
                    peer.socket.destroy();
                }
                if (server.listening) {
                    await new Promise<void>((resolve, reject) =>
                        server.close((error) => (error ? reject(error) : resolve()))
                    );
                }
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test listener");
        client = new CopilotClient({
            connection: RuntimeConnection.forUri(`127.0.0.1:${address.port}`),
        });
        const directories = {
            skillDirectories: roots?.map((root) => `${root}-skills`),
            agentDirectories: roots?.map((root) => `${root}-agents`),
            instructionDirectories: roots?.map((root) => `${root}-instructions`),
            hookDirectories: roots?.map((root) => `${root}-hooks`),
        };
        const config = {
            workingDirectory: "request-cwd",
            enableConfigDiscovery: false,
            enableFileHooks: false,
            ...directories,
            onPermissionRequest: approveAll,
        };
        const session = await client.createSession(config);
        await client.resumeSession(session.sessionId, config);
        for (const method of ["session.create", "session.resume"]) {
            const request = requests.get(method);
            expect(request).toBeDefined();
            for (const [key, expected] of Object.entries(directories)) {
                if (expected === undefined) {
                    expect(request).not.toHaveProperty(key);
                } else {
                    expect(request).toHaveProperty(key, expected);
                }
            }
            expect(request).toHaveProperty("enableConfigDiscovery", false);
            expect(request).toHaveProperty("enableFileHooks", false);
            expect(request).not.toHaveProperty("additionalDirectories");
            expect(request).not.toHaveProperty("customAgents");
            expect(request).toHaveProperty("hooks", false);
        }
    });
});

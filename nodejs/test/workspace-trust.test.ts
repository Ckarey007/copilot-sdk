/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import {
    createMessageConnection,
    ResponseError,
    StreamMessageReader,
    StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import {
    CopilotClient,
    RuntimeConnection,
    type ResumeSessionConfig,
    type SessionConfig,
} from "../src/index.js";
import { getSdkProtocolVersion } from "../src/sdkProtocolVersion.js";

async function createTestClient(
    handleRequest: (method: string, params: Record<string, unknown>) => unknown
) {
    const server = createServer((socket) => {
        const connection = createMessageConnection(
            new StreamMessageReader(socket),
            new StreamMessageWriter(socket)
        );
        connection.onRequest("connect", () => ({ protocolVersion: getSdkProtocolVersion() }));
        for (const method of ["session.create", "session.resume"]) {
            connection.onRequest(method, (params: Record<string, unknown>) =>
                handleRequest(method, params)
            );
        }
        connection.listen();
        onTestFinished(() => {
            connection.dispose();
            socket.destroy();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Expected a TCP listener");
    }
    const client = new CopilotClient({
        connection: RuntimeConnection.forUri(`127.0.0.1:${address.port}`),
    });
    onTestFinished(() => client.forceStop());
    await client.start();
    return client;
}

describe("workspace trust", () => {
    it("is typed and available only on the create config", () => {
        expectTypeOf<SessionConfig["trustWorkingDirectory"]>().toEqualTypeOf<
            "session" | "user" | undefined
        >();
        expectTypeOf<ResumeSessionConfig>().not.toHaveProperty("trustWorkingDirectory");
    });

    it.each(["session", "user"] as const)(
        "forwards explicit %s trust only on session.create",
        async (trustWorkingDirectory) => {
            const workingDirectory = resolve("synthetic-workspace");
            const configDirectory = resolve("synthetic-config");
            const requests: { method: string; params: Record<string, unknown> }[] = [];
            const client = await createTestClient((method, params) => {
                requests.push({ method, params });
                return { sessionId: params.sessionId };
            });
            const config: SessionConfig = {
                workingDirectory,
                configDirectory,
                trustWorkingDirectory,
            };
            const session = await client.createSession(config);
            // Structural typing allows a create config variable at a resume call.
            await client.resumeSession(session.sessionId, config);

            expect(
                requests.find(({ method }) => method === "session.create")?.params
            ).toMatchObject({
                workingDirectory,
                configDir: configDirectory,
                trustWorkingDirectory,
            });
            const resume = requests.find(({ method }) => method === "session.resume");
            expect(resume).toBeDefined();
            expect(resume?.params).not.toHaveProperty("trustWorkingDirectory");
        }
    );

    it.each([undefined, false, true])(
        "omits trust when unset, with config discovery %s",
        async (enableConfigDiscovery) => {
            let payload: Record<string, unknown> | undefined;
            const client = await createTestClient((_method, params) => {
                payload = params;
                return { sessionId: params.sessionId };
            });
            await client.createSession({
                workingDirectory: resolve("synthetic-workspace"),
                enableConfigDiscovery,
            });
            expect(payload).toBeDefined();
            expect(payload).not.toHaveProperty("trustWorkingDirectory");
        }
    );

    it.each([
        [undefined, "trustWorkingDirectory requires a nonblank workingDirectory."],
        ["   ", "trustWorkingDirectory requires a nonblank workingDirectory."],
        ["relative", "trustWorkingDirectory requires an absolute workingDirectory."],
        [
            resolve("synthetic-workspace"),
            "trustWorkingDirectory is not supported with an RPC session filesystem provider.",
        ],
    ])("surfaces runtime trust errors for cwd %s", async (workingDirectory, message) => {
        const client = await createTestClient((method, params) => {
            expect(method).toBe("session.create");
            expect(params.trustWorkingDirectory).toBe("session");
            return new ResponseError(-32602, message);
        });
        await expect(
            client.createSession({ workingDirectory, trustWorkingDirectory: "session" })
        ).rejects.toThrow(message);
    });
});

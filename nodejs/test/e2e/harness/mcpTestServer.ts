/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function mcpTestServerConfig(result: string, descriptionFile?: string) {
    const serverPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../test/harness/test-mcp-server.mjs"
    );
    return {
        type: "stdio" as const,
        command: process.execPath,
        args: [
            serverPath,
            ...(descriptionFile ? ["--tool-description-file", descriptionFile] : []),
        ],
        workingDirectory: dirname(serverPath),
        env: { CACHE_TEST_RESULT: result },
        tools: ["get_env"],
    };
}

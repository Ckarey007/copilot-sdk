import { defineConfig } from "vitest/config";
import { isByokBackend } from "./test/e2e/harness/testBackend";

const integrationTestTimeout = process.platform === "win32" ? 60000 : 30000;

// These suites own their provider or CAPI auth/request-handler setup. They run
// in the ordinary CAPI job, not as repetitions of the matrix-selected backend.
const selfConfiguredBackendE2E = [
    "**/test/e2e/byok_bearer_token_provider.e2e.test.ts",
    "**/test/e2e/copilot_request_handler.e2e.test.ts",
    "**/test/e2e/copilot_request_session_id.e2e.test.ts",
    "**/test/e2e/disabled_mcp_servers.e2e.test.ts",
    "**/test/e2e/mcp_cached_oauth_overlap.e2e.test.ts",
    "**/test/e2e/mcp_catalog_recovery.e2e.test.ts",
    "**/test/e2e/memory_retrieval.e2e.test.ts",
    "**/test/e2e/mode_handlers.e2e.test.ts",
    "**/test/e2e/multi_provider_registry.e2e.test.ts",
    "**/test/e2e/per_session_auth.e2e.test.ts",
    "**/test/e2e/provider_endpoint.e2e.test.ts",
    "**/test/e2e/subagent_prompt_resume.e2e.test.ts",
    "**/test/e2e/tools_anthropic_updates.e2e.test.ts",
    "**/test/e2e/websocket_http_fallback.e2e.test.ts",
    "**/test/e2e/websocket_terminals.e2e.test.ts",
];

export default defineConfig({
    test: {
        ...(isByokBackend ? { include: ["test/e2e/*.e2e.test.ts"] } : {}),
        globals: true,
        environment: "node",
        testTimeout: integrationTestTimeout,
        hookTimeout: integrationTestTimeout,
        teardownTimeout: 10000,
        isolate: true, // Run each test file in isolation
        pool: "forks", // Use process forking for better isolation
        globalSetup: ["./test/e2e/harness/globalSetup.ts"],
        // Exclude our ad-hoc test files that aren't vitest-based
        exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/*.d.ts",
            "**/basic-test.ts", // Old manual test
            ...(isByokBackend ? selfConfiguredBackendE2E : []),
        ],
    },
});

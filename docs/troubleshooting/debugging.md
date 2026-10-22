# Debugging guide

This guide covers common issues and debugging techniques for the Copilot SDK across all supported languages.

## Table of contents

* [Enable Debug Logging](#enable-debug-logging)
* [Common Issues](#common-issues)
* [MCP Server Debugging](#mcp-server-debugging)
* [Connection Issues](#connection-issues)
* [Tool Execution Issues](#tool-execution-issues)
* [Platform-Specific Issues](#platform-specific-issues)

## Enable debug logging

The first step in debugging is enabling verbose logging to see what's happening under the hood.

<details open>
<summary><strong>Node.js / TypeScript</strong></summary>

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
  logLevel: "debug",  // Options: "none", "error", "warning", "info", "debug", "all"
});
```

</details>

<details>
<summary><strong>Python</strong></summary>

```python
from copilot import CopilotClient

client = CopilotClient(log_level="debug")
```

</details>

<details>
<summary><strong>Go</strong></summary>

<!-- docs-validate: hidden -->
```go
package main

import copilot "github.com/github/copilot-sdk/go"

func main() {
	client := copilot.NewClient(&copilot.ClientOptions{
		LogLevel: "debug",
	})
	_ = client
}
```
<!-- /docs-validate: hidden -->

```go
import copilot "github.com/github/copilot-sdk/go"

client := copilot.NewClient(&copilot.ClientOptions{
    LogLevel: "debug",
})
```

</details>

<details>
<summary><strong>.NET</strong></summary>

<!-- docs-validate: skip -->

```csharp
using GitHub.Copilot;
using Microsoft.Extensions.Logging;

// Using ILogger
var loggerFactory = LoggerFactory.Create(builder =>
{
    builder.SetMinimumLevel(LogLevel.Debug);
    builder.AddConsole();
});

var client = new CopilotClient(new CopilotClientOptions
{
    LogLevel = "debug",
    Logger = loggerFactory.CreateLogger<CopilotClient>()
});
```

</details>

<details>
<summary><strong>Java</strong></summary>

```java
import com.github.copilot.CopilotClient;
import com.github.copilot.rpc.*;

var client = new CopilotClient(new CopilotClientOptions()
    .setLogLevel("debug")
);
```

</details>

### Log directory

The SDK-managed out-of-process runtime writes redacted
`process-<timestamp>-<pid>.log` files under the Copilot home's `logs` directory
by default in `copilot-cli` mode. SDKs in `empty` mode do not set the logging
opt-in, but an inherited setting can still enable it; session events remain
available to `collectLogs`. An explicitly selected older CLI executable may
ignore this setting. You can specify a custom log location with `--log-dir`;
`collectLogs` searches the configured directory. In-process connections do
not start a separate logging process.

<details open>
<summary><strong>Node.js / TypeScript</strong></summary>

```typescript
const client = new CopilotClient({
  cliArgs: ["--log-dir", "/path/to/logs"],
});
```

</details>

<details>
<summary><strong>Python</strong></summary>

```python
from copilot import CopilotClient, RuntimeConnection

client = CopilotClient(
    connection=RuntimeConnection.for_stdio(args=["--log-dir", "/path/to/logs"])
)
```

</details>

<details>
<summary><strong>Go</strong></summary>

<!-- docs-validate: hidden -->
```go
package main

import copilot "github.com/github/copilot-sdk/go"

func main() {
	client := copilot.NewClient(&copilot.ClientOptions{
		Connection: copilot.StdioConnection{
			Args: []string{"--log-dir", "/path/to/logs"},
		},
	})
	_ = client
}
```
<!-- /docs-validate: hidden -->

```go
client := copilot.NewClient(&copilot.ClientOptions{
    Connection: copilot.StdioConnection{
        Args: []string{"--log-dir", "/path/to/logs"},
    },
})
```

</details>

<details>
<summary><strong>.NET</strong></summary>

```csharp
var client = new CopilotClient(new CopilotClientOptions
{
    Connection = RuntimeConnection.ForStdio(args: new[] { "--log-dir", "/path/to/logs" })
});
```

</details>

<details>
<summary><strong>Java</strong></summary>

<!-- docs-validate: skip -->
```java
import com.github.copilot.CopilotClient;
import com.github.copilot.rpc.CopilotClientOptions;

var client = new CopilotClient(new CopilotClientOptions()
    .setCliArgs(new String[] {"--log-dir", "/path/to/logs"}));
```

</details>

## Common issues

### "CLI not found" / "Copilot: command not found"

**Cause:** The Copilot CLI is not installed or not in PATH.

**Solution:**

1. Install the CLI: [Installation guide](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)

1. Verify installation:
   ```bash
   copilot --version
   ```

1. Or specify the full path:

   <details open>
   <summary><strong>Node.js</strong></summary>

   ```typescript
   const client = new CopilotClient({
     cliPath: "/usr/local/bin/copilot",
   });
   ```
   </details>

   <details>
   <summary><strong>Python</strong></summary>

   ```python
   client = CopilotClient({"cli_path": "/usr/local/bin/copilot"})
   ```
   </details>

   <details>
   <summary><strong>Go</strong></summary>

   ```go
   client := copilot.NewClient(&copilot.ClientOptions{
       Connection: copilot.StdioConnection{Path: "/usr/local/bin/copilot"},
   })
   ```
   </details>

   <details>
   <summary><strong>.NET</strong></summary>

   ```csharp
   var client = new CopilotClient(new CopilotClientOptions
   {
       CliPath = "/usr/local/bin/copilot"
   });
   ```
   </details>

   <details>
   <summary><strong>Java</strong></summary>

   ```java
   var client = new CopilotClient(new CopilotClientOptions()
       .setCliPath("/usr/local/bin/copilot")
   );
   ```
   </details>

### "Not authenticated"

**Cause:** The CLI is not authenticated with GitHub.

**Solution:**

1. Authenticate the CLI:
   ```bash
   copilot auth login
   ```

1. Or provide a token programmatically:

   <details open>
   <summary><strong>Node.js</strong></summary>

   ```typescript
   const client = new CopilotClient({
     gitHubToken: process.env.GITHUB_TOKEN,
   });
   ```
   </details>

   <details>
   <summary><strong>Python</strong></summary>

   ```python
   import os
   client = CopilotClient({"github_token": os.environ.get("GITHUB_TOKEN")})
   ```
   </details>

   <details>
   <summary><strong>Go</strong></summary>

   ```go
   client := copilot.NewClient(&copilot.ClientOptions{
       GitHubToken: os.Getenv("GITHUB_TOKEN"),
   })
   ```
   </details>

   <details>
   <summary><strong>.NET</strong></summary>

   ```csharp
   var client = new CopilotClient(new CopilotClientOptions
   {
       GitHubToken = Environment.GetEnvironmentVariable("GITHUB_TOKEN")
   });
   ```
   </details>

   <details>
   <summary><strong>Java</strong></summary>

   ```java
   var client = new CopilotClient(new CopilotClientOptions()
       .setGitHubToken(System.getenv("GITHUB_TOKEN"))
   );
   ```
   </details>

### "Session not found"

**Cause:** Attempting to use a session that was destroyed or doesn't exist.

**Solution:**

1. Ensure you're not calling methods after `disconnect()`:
   ```typescript
   await session.disconnect();
   // Don't use session after this!
   ```

1. For resuming sessions, verify the session ID exists:
   ```typescript
   const sessions = await client.listSessions();
   console.log("Available sessions:", sessions);
   ```

### "Connection refused" / "ECONNREFUSED"

**Cause:** The CLI server process crashed or failed to start.

**Solution:**

1. Check if the CLI runs correctly standalone:
   ```bash
   copilot --server --stdio
   ```

1. Check for port conflicts if using TCP mode:
   ```typescript
   const client = new CopilotClient({
     useStdio: false,
     port: 0,  // Use random available port
   });
   ```

## MCP server debugging

MCP (Model Context Protocol) servers can be tricky to debug. For comprehensive MCP debugging guidance, see the dedicated **[MCP Debugging Guide](./mcp-debugging.md)**.

### Quick MCP checklist

* [ ] MCP server executable exists and runs independently
* [ ] Command path is correct (use absolute paths)
* [ ] Tools are enabled: `tools: ["*"]`
* [ ] Server responds to `initialize` request correctly
* [ ] Working directory (`cwd`) is set if needed

### Test your MCP server

Before integrating with the SDK, verify your MCP server works:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | /path/to/your/mcp-server
```

See [MCP Debugging Guide](./mcp-debugging.md) for detailed troubleshooting.

## Connection issues

### stdio vs TCP mode

The SDK supports two transport modes:

| Mode | Description | Use Case |
|------|-------------|----------|
| **Stdio** (default) | CLI runs as subprocess, communicates via pipes | Local development, single process |
| **TCP** | CLI runs separately, communicates via TCP socket | Multiple clients, remote CLI |

**Stdio mode (default):**
```typescript
const client = new CopilotClient({
  useStdio: true,  // This is the default
});
```

**TCP mode:**
```typescript
const client = new CopilotClient({
  useStdio: false,
  port: 8080,  // Or 0 for random port
});
```

**Connect to existing server:**
```typescript
const client = new CopilotClient({
  cliUrl: "localhost:8080",  // Connect to running server
});
```

### Diagnosing connection failures

1. **Check client state:**
   ```typescript
   console.log("Connection state:", client.getState());
   // Should be "connected" after start()
   ```

1. **Listen for state changes:**
   ```typescript
   client.on("stateChange", (state) => {
     console.log("State changed to:", state);
   });
   ```

1. **Verify CLI process is running:**
   ```bash
   # Check for copilot processes
   ps aux | grep copilot
   ```

## Tool execution issues

### Interactive commands keep running without progress

The runtime's built-in terminal tools can execute commands without a
pseudo-terminal (PTY). In that mode, an interactive program cannot be operated
by typing into an unrelated terminal window. A tool call returning a background
task also does not mean that the command has finished.

Some build tools launch interactive configuration menus implicitly when a
configuration file is missing. For example, OpenWrt's prerequisite target can
invoke `menuconfig` in an unconfigured source tree. With non-terminal input, an
interactive program can wait indefinitely, exit, or repeatedly retry input.
Check process state and CPU usage as well as output; an unchanged log alone
does not establish that a process has stopped.

To prevent this failure:

1. Use the command's documented non-interactive configuration mode. Initialize
   and verify required configuration before running the build or prerequisite
   target. Redirecting output does not disable an interactive fallback.
1. If a command requires terminal input, check for a terminal inside the
   process that will run it, not just in the application hosting the SDK.
   For a POSIX command that requires terminal input, prepend this guard:

   ```sh
   if [ ! -t 0 ]; then
       printf '%s\n' 'This command requires a terminal; use its non-interactive mode.' >&2
       exit 2
   fi
   ```

   Do not add this guard to commands that are designed to read piped input.
1. Set an execution deadline using a mechanism that terminates the command,
   not just the wait for a tool result. An initial wait that returns a
   background task is not an execution deadline. On Linux with GNU coreutils,
   `timeout --kill-after=5s 60s your-command` bounds ordinary commands and
   escalates from TERM to KILL if needed. Descendants that escape the timeout's
   process group require separate lifecycle management.
1. Use an execution channel with a PTY and user input support when interaction
   is essential. A separate terminal cannot supply input to a process that is
   already running with a pipe as its standard input.

To recover an existing task, use the host's task-specific stop operation, if
available, and verify that the task and its owned child processes have exited.
Aborting a model turn is not a substitute for checking process termination.
On Windows with WSL, check the Linux descendants as well as the Windows
launcher. Do not assume that restarting the editor stopped them.

Keep intentionally detached services separate from work owned by the current
session. If manual cleanup is necessary, verify process identity and ownership
before targeting individual processes. Do not terminate all processes with the
same executable name or shut down a shared WSL instance.

When reporting a persistent task, include the SDK and runtime versions,
execution and attachment modes if available, whether stdin is a terminal, and
the result of the task-specific stop operation. Use a bounded reproduction in a
disposable directory. Replace local paths and session identifiers with
placeholders, and omit credentials and private command output.

### Custom tool not being called

1. **Verify tool registration:**
   ```typescript
   const session = await client.createSession({
     tools: [myTool],
   });
   
   // Check registered tools
   console.log("Registered tools:", session.getTools?.());
   ```

1. **Check tool schema is valid JSON Schema:**
   ```typescript
   const myTool = {
     name: "get_weather",
     description: "Get weather for a location",
     parameters: {
       type: "object",
       properties: {
         location: { type: "string", description: "City name" },
       },
       required: ["location"],
     },
     handler: async (args) => {
       return { temperature: 72 };
     },
   };
   ```

1. **Ensure handler returns valid result:**
   ```typescript
   handler: async (args) => {
     // Must return something JSON-serializable
     return { success: true, data: "result" };
     
     // Don't return undefined or non-serializable objects
   }
   ```

### Tool errors not surfacing

Subscribe to error events:

```typescript
session.on("tool.execution_error", (event) => {
  console.error("Tool error:", event.data);
});

session.on("error", (event) => {
  console.error("Session error:", event.data);
});
```

## Platform-specific issues

### Windows

1. **Path separators:** Use raw strings or forward slashes:
   ```csharp
   CliPath = @"C:\Program Files\GitHub\copilot.exe"
   // or
   CliPath = "C:/Program Files/GitHub/copilot.exe"
   ```

1. **PATHEXT resolution:** The SDK handles this automatically, but if issues persist:
   ```csharp
   // Explicitly specify .exe
   Command = "myserver.exe"  // Not just "myserver"
   ```

1. **Console encoding:** Ensure UTF-8 for proper JSON handling:
   ```csharp
   Console.OutputEncoding = System.Text.Encoding.UTF8;
   ```

### macOS

1. **Gatekeeper issues:** If CLI is blocked:
   ```bash
   xattr -d com.apple.quarantine /path/to/copilot
   ```

1. **PATH issues in GUI apps:** GUI applications may not inherit shell PATH:
   ```typescript
   const client = new CopilotClient({
     cliPath: "/opt/homebrew/bin/copilot",  // Full path
   });
   ```

### Linux

1. **Permission issues:**
   ```bash
   chmod +x /path/to/copilot
   ```

1. **Missing libraries:** Check for required shared libraries:
   ```bash
   ldd /path/to/copilot
   ```

## Getting help

If you're still stuck:

1. **Collect debug information:**
   * SDK version
   * CLI version (`copilot --version`)
   * Operating system
   * Debug logs
   * Minimal reproduction code

1. **Search existing issues:** [GitHub Issues](https://github.com/github/copilot-sdk/issues)

1. **Open a new issue** with the collected information

## See also

* [Getting Started Guide](../getting-started.md)
* [MCP Overview](../features/mcp.md) - MCP configuration and setup
* [MCP Debugging Guide](./mcp-debugging.md) - Detailed MCP troubleshooting
* [API Reference](https://github.com/github/copilot-sdk)

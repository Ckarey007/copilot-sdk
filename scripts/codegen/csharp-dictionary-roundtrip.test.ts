/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { generateRpcCode } from "./csharp.ts";

test("generated C# open dictionaries retain entries through System.Text.Json", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".csharp-dictionary-test-"));
    let failure: unknown;
    try {
        const code = generateRpcCode({
            server: {
                sample: {
                    read: {
                        rpcMethod: "sample.read",
                        params: null,
                        result: {
                            title: "SampleResult",
                            type: "object",
                            properties: {
                                environment: { type: "object", properties: {} },
                                settings: { type: "object", properties: {} },
                            },
                            required: ["environment"],
                        },
                    },
                },
            },
        });
        await writeFile(join(directory, "Rpc.cs"), code);
        await writeFile(
            join(directory, "Roundtrip.csproj"),
            `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`
        );
        await writeFile(
            join(directory, "Program.cs"),
            `using System.Text.Json;
using System.Text.Json.Nodes;
using GitHub.Copilot.Rpc;

const string json = """
{"environment":{"COPILOT_HOME":"/isolated/config","EMPTY":""},"settings":{"model":"selected-model","enabled":false,"custom":{"nested":42}}}
""";
var value = JsonSerializer.Deserialize<SampleResult>(json)!;
var actual = JsonSerializer.Serialize(value);
if (!JsonNode.DeepEquals(JsonNode.Parse(json), JsonNode.Parse(actual)))
    throw new Exception($"Dictionary entries lost: {actual}");
Console.WriteLine("environment and settings dictionaries round-trip");

namespace GitHub.Copilot.Rpc
{
    internal sealed class JsonRpc;
    internal static class CopilotClient
    {
        internal static Task<T> InvokeRpcAsync<T>(JsonRpc rpc, string method, object[] args,
            CancellationToken cancellationToken) => throw new NotSupportedException("No RPC is expected");
    }
}`
        );
        const result = spawnSync("dotnet", ["run", "--project", join(directory, "Roundtrip.csproj")], {
            cwd: directory,
            encoding: "utf8",
        });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /environment and settings dictionaries round-trip/);
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        try {
            await rm(directory, { recursive: true, force: true });
        } catch (cleanupError) {
            if (failure) throw new AggregateError([failure, cleanupError], "Test and cleanup failed");
            throw cleanupError;
        }
    }
});

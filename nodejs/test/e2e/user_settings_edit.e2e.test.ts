/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editUserSettings } from "../../examples/internal-user-settings.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";

describe("Internal user settings edit contract", async () => {
    const { copilotClient: client, workDir, env } = await createSdkTestContext();

    it("runs the edit example and preserves settings-only reads and safe writes", async () => {
        await client.start();
        // These host-only methods deliberately stay off the public SDK surface.
        const settings = client["internalRpc"].user.settings;
        const home = env.COPILOT_HOME;
        writeFileSync(join(home, "config.json"), '{"voice":{"enabled":false}}');
        writeFileSync(join(home, "settings.json"), '{"voice":{"selectedModel":"local"}}');

        expect(await settings.loadForEdit()).toEqual({
            status: "ok",
            settings: { voice: { selectedModel: "local" } },
        });

        const configDir = join(workDir, "example-config");
        mkdirSync(configDir);
        const result = await editUserSettings(settings, configDir);
        expect(result).toEqual({ value: { enabled: true, selectedModel: null } });
        expect(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))).toEqual({
            voice: result.value,
        });
        console.log("Internal settings example:", JSON.stringify(result));

        await settings.update({
            key: "voice",
            value: { enabled: false },
            configDir,
            subDir: "profile",
        });
        expect(JSON.parse(readFileSync(join(configDir, "settings/profile.json"), "utf8"))).toEqual({
            voice: { enabled: false },
        });
        await expect(
            settings.update({
                key: "voice",
                value: { enabled: false },
                configDir,
                subDir: "../../outside",
            })
        ).rejects.toThrow("`subDir` must be a single path component");

        const file = join(configDir, "settings.json");
        const original = "{ invalid settings";
        writeFileSync(file, original);
        await expect(
            settings.update({ key: "voice", value: { enabled: false }, configDir })
        ).rejects.toThrow("refusing to overwrite settings.json");
        expect(readFileSync(file, "utf8")).toBe(original);
        expect(await settings.validate({ topKey: "voice", delete: true })).toEqual({ ok: true });
    });
});

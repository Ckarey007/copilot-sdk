/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

export function findRuntimeRoot(sdkRoot: string): string | undefined;
export function getRuntimeCliPaths(
    runtimeRoot: string | undefined,
    environment?: NodeJS.ProcessEnv
): {
    cliPath: string | undefined;
    legacyCliPath: string | undefined;
};

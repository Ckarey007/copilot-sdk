/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { expectTypeOf, it } from "vitest";
import type {
    CopilotSession,
    ModelGetReasoningSummariesRequest,
    ModelGetReasoningSummariesResult,
} from "../src/index.js";

it("exports reasoning-summary request and result types from the package root", () => {
    expectTypeOf<ModelGetReasoningSummariesRequest>().toEqualTypeOf<
        Parameters<CopilotSession["rpc"]["model"]["getReasoningSummaries"]>[0]
    >();
    expectTypeOf<ModelGetReasoningSummariesResult>().toEqualTypeOf<
        Awaited<ReturnType<CopilotSession["rpc"]["model"]["getReasoningSummaries"]>>
    >();
});

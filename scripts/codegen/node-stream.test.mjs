/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import stream from "node:stream";
import { test } from "node:test";

const requireFromHere = createRequire(import.meta.url);
const requireFromQuicktype = createRequire(requireFromHere.resolve("quicktype-core"));
const { getStream } = requireFromQuicktype("./input/io/get-stream/index.js");

test("quicktype resolves Node's built-in streams through the first-party adapter", () => {
    assert.strictEqual(requireFromQuicktype("readable-stream"), stream);
    assert.equal(requireFromQuicktype("readable-stream/package.json").name, "@github/copilot-sdk-node-stream");
});

test("quicktype decodes input split inside multibyte characters", async () => {
    const expected = "schema: \u20ac \ud83d\ude00";
    const chunks = [...Buffer.from(expected)].map((byte) => Buffer.from([byte]));
    const actual = await getStream(stream.Readable.from(chunks));
    assert.equal(actual, expected);
});

test("quicktype retains the built-in decoder's incomplete-character handling", async () => {
    const actual = await getStream(stream.Readable.from([Buffer.from([0xe2, 0x82])]));
    assert.equal(actual, "\ufffd");
});

test("quicktype preserves binary and object-mode inputs", async () => {
    const bytes = Buffer.from([0, 0xff, 0x80, 1]);
    assert.deepEqual(await getStream(stream.Readable.from([bytes]), { encoding: "buffer" }), bytes);
    const values = [{ value: 1 }, { value: 2 }];
    assert.deepEqual(await getStream(stream.Readable.from(values), { array: true }), values);
});

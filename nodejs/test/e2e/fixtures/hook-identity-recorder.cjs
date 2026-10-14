/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

const { randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    body += chunk;
});
process.stdin.on("end", () => {
    const hook = process.argv[2];
    writeFileSync(
        join(process.argv[3], `${hook}.${randomUUID()}.json`),
        JSON.stringify({ hook, input: JSON.parse(body) })
    );
});

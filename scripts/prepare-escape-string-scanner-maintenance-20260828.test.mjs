import assert from "node:assert/strict";

import { buildMaintainedSource } from "./prepare-escape-string-scanner-maintenance-20260828.mjs";

const built = buildMaintainedSource();
const scanner = built.output.slice(built.output.indexOf("export function stripCommentsQuoteAware(sql)"));
assert.match(scanner, /const escapeString = \(ch === "e" \|\| ch === "E"\)/);
assert.match(scanner, /escapeString && src\[j\] === "\\\\"/);
assert.doesNotMatch(scanner, /if \(ch === "'"\) \{\n      let j = i \+ 1;/);
process.stdout.write(`escape-string scanner producer test passed: ${built.blob}\n`);

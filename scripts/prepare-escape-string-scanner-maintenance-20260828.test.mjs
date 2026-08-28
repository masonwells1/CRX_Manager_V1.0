import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildMaintainedSource } from "./prepare-escape-string-scanner-maintenance-20260828.mjs";

const built = buildMaintainedSource();
const scanner = built.output.slice(built.output.indexOf("export function stripCommentsQuoteAware(sql)"));
assert.match(scanner, /const escapeString = \(ch === "e" \|\| ch === "E"\)/);
assert.match(scanner, /escapeString && src\[j\] === "\\\\"/);
assert.doesNotMatch(scanner, /if \(ch === "'"\) \{\n      let j = i \+ 1;/);
process.stdout.write(`escape-string scanner producer test passed: ${built.blob}\n`);
const producer = readFileSync(new URL("./prepare-escape-string-scanner-maintenance-20260828.mjs", import.meta.url), "utf8");
assert.match(producer, /"--model", "gpt-5\.6-sol"/);
assert.match(producer, /model_reasoning_effort=\\"high\\"/);
assert.match(producer, /"--sandbox", "read-only"/);
assert.match(producer, /tokens\.length !== 1 \|\| tokens\[0\]\[1\] !== "CLEAN"/);
assert.match(producer, /git\(\["status", "--porcelain", "--untracked-files=all"\]\)/);
assert.ok(producer.indexOf("runArtifactReview({") < producer.indexOf("writeFileSync(TARGET_PATH, built.output"),
  "the artifact-specific review must complete before the protected write");

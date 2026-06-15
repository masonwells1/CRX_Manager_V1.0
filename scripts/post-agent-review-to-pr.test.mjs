#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  buildPrCommentBody,
  findSensitiveContentWarnings,
  parsePrCommentArgs,
  truncateForGitHubComment,
} from "./post-agent-review-to-pr.mjs";

const parsed = parsePrCommentArgs([
  "--pr", "77",
  "--file", "docs/audits/example.md",
  "--dry-run",
]);

assert.equal(parsed.pr, "77");
assert.equal(parsed.file, "docs/audits/example.md");
assert.equal(parsed.dryRun, true);
assert.equal(parsed.confirm, false);

assert.throws(
  () => parsePrCommentArgs(["--file", "docs/audits/example.md"]),
  /--pr is required/,
);
assert.throws(
  () => parsePrCommentArgs(["--pr", "77"]),
  /--file is required/,
);

const body = buildPrCommentBody({
  sourceFile: "docs/audits/example.md",
  content: "# Review\n\nVerdict: SHIP",
});

assert.match(body, /Agent review attached/);
assert.match(body, /docs\/audits\/example\.md/);
assert.match(body, /Verdict: SHIP/);

const long = "x".repeat(70_000);
const shortened = truncateForGitHubComment(long, 1_000);
assert.equal(shortened.length <= 1_000, true);
assert.match(shortened, /truncated/i);

assert.deepEqual(findSensitiveContentWarnings("Verdict: clean"), []);
assert.deepEqual(
  findSensitiveContentWarnings(`${["SUPABASE", "SERVICE", "ROLE"].join("_")}=example-value`),
  ["Supabase service-role reference", "secret-like env assignment"],
);

console.log("OK - post-agent-review-to-pr helpers passed.");

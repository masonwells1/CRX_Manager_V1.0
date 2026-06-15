#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "agent-pair-review-reminder.mjs");

function runHook(prompt) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
  });
}

function fires(prompt) {
  const result = runHook(prompt);
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout.trim().length > 0;
}

const SHOULD_FIRE = [
  "have both Codex and Claude review this",
  "run a pair review on this change",
  "ask both agents to check the work",
  "I want Claude and Codex to compare notes",
  "get a two model review before we trust it",
  "make Codex and Claude disagree out loud on this",
];

const SHOULD_NOT_FIRE = [
  "let Claude review this",
  "have Codex review Claude's work",
  "review this invoice before we send it",
  "compare these two herbicide quotes",
  "ask Mason and Claude about the schedule",
  "both trucks need maintenance this week",
];

let failures = 0;
for (const prompt of SHOULD_FIRE) {
  if (!fires(prompt)) {
    console.error(`FAIL (should fire): ${prompt}`);
    failures += 1;
  }
}

for (const prompt of SHOULD_NOT_FIRE) {
  if (fires(prompt)) {
    console.error(`FAIL (should NOT fire): ${prompt}`);
    failures += 1;
  }
}

const output = JSON.parse(runHook("run a pair review on this change").stdout);
assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
assert.match(output.hookSpecificOutput.additionalContext, /Agent Pair Review/i);
assert.match(output.hookSpecificOutput.additionalContext, /agent-pair-review\.md/);
assert.match(output.hookSpecificOutput.additionalContext, /Do not push, deploy, apply live migrations, delete data, or commit/i);

assert.equal(failures, 0, `${failures} trigger classification failure(s)`);
console.log(`OK - ${SHOULD_FIRE.length} fire + ${SHOULD_NOT_FIRE.length} no-fire cases passed.`);

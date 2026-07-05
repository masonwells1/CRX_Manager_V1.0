#!/usr/bin/env node
// Regression tests for the Codex-to-Claude handoff reminder hook.
// These spawn the real hook so phrase coverage stays tied to the shipped artifact.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "codex-to-claude-handoff-reminder.mjs");

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
  "let Claude review this",
  "let claude review your work",
  "have Claude look at this",
  "have Claude double-check your work",
  "ask Claude to check this",
  "send this to Claude",
  "make a Claude handoff",
  "give Claude the context for this",
  "set this up so Claude can continue",
  "can Claude review what you just did?",
  "I want Claude to challenge your findings",
  "Claude should review this before I trust it",
  "have claude take a second look",
];

const SHOULD_NOT_FIRE = [
  "what did Claude say about the weather?",
  "Claude is a good name for a farm truck",
  "review the meeting notes from the agronomy call",
  "check this invoice math",
  "double-check the herbicide rate before we spray",
  "send this invoice to the customer",
  "make a handoff note for the driver",
  "give me context on this customer account",
  "can you review this contract before I sign it?",
  "ask Mason if he wants to continue",
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

const output = JSON.parse(runHook("let Claude review this").stdout);
assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
assert.match(output.hookSpecificOutput.additionalContext, /Codex-to-Claude Handoff/i);
assert.match(output.hookSpecificOutput.additionalContext, /claude-review\.md/);
assert.match(output.hookSpecificOutput.additionalContext, /codex-to-claude-handoff\.md/);
assert.match(output.hookSpecificOutput.additionalContext, /HARD GATES that ALWAYS need Mason's explicit OK/i);
assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /never pushes|do not push.*without.*explicit approval/i);

assert.equal(failures, 0, `${failures} trigger classification failure(s)`);
console.log(`OK - ${SHOULD_FIRE.length} fire + ${SHOULD_NOT_FIRE.length} no-fire cases passed.`);

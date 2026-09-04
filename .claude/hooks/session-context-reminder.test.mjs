#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("./session-context-reminder.mjs", import.meta.url));

function runRaw(input) {
  const result = spawnSync(process.execPath, [hookPath], {
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function run(source) {
  const output = runRaw(JSON.stringify({ source }));
  return JSON.parse(output).hookSpecificOutput.additionalContext;
}

const startup = run("startup");
assert.match(startup, /read AGENTS\.md/);
assert.match(startup, /load only the workflow and reference documents/);
assert.match(startup, /Mason cannot read code or safely review a diff/);
assert.match(startup, /routine multi-file.*get his approval after a short plan/);
assert.match(startup, /continue without repeated pauses/);
assert.match(startup, /current approval immediately before each live migration/);
assert.match(startup, /armed hands-free migration path waives per-migration approval/);
assert.match(startup, /never for a destructive migration/);
// Keep the full rulebook task-routed instead of injecting it into every session.
assert.doesNotMatch(startup, /SAFE_DEVELOPMENT_RULES/);
assert.ok(startup.length < 1_000, `startup reminder grew to ${startup.length} characters`);
assert.equal(run("resume"), startup);
assert.equal(run("clear"), startup);
assert.equal(run(), startup);

const compact = run("compact");
assert.match(compact, /POST-COMPACT RULE RE-ANCHOR/);
assert.match(compact, /money = exact whole cents/);
assert.match(compact, /Mason has zero coding experience/);

assert.equal(runRaw("{"), "");

console.log("session-context-reminder: startup routing and compact re-anchor passed");

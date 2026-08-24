#!/usr/bin/env node
// Tests for codex-recursion-guard.mjs.
//
// The two REAL commands from the 2026-08-23 incident are the first cases, verbatim:
// a guard that does not stop those has not fixed anything.

import assert from "node:assert/strict";
import { classifyCommand } from "./codex-recursion-guard.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const blocks = (cmd) => classifyCommand(cmd);
const rule = (cmd) => classifyCommand(cmd)?.rule ?? null;

// ── The incident itself ───────────────────────────────────────────────────────
check("blocks the exact taskkill that destroyed the 2026-08-23 review", () => {
  assert.equal(rule("taskkill /PID 39564 /T /F"), "force-kill");
});

check("blocks the exact Stop-Process tree-kill attempt from the same session", () => {
  const real =
    '$root=39564; $all=Get-CimInstance Win32_Process; $ids | Sort-Object -Descending | ' +
    'ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }';
  assert.equal(rule(real), "force-kill");
});

check("blocks the nested codex review the reviewer spawned", () => {
  const real =
    'codex review --base origin/main -c \'model="gpt-5.6-sol"\' ' +
    "-c 'model_reasoning_effort=\"high\"' -c approval_policy=never";
  assert.equal(rule(real), "codex-review");
});

check("a PID-only kill is caught even though it never says codex", () => {
  // The whole point: matching the word "codex" would have missed the real command.
  const cmd = "taskkill /PID 12345 /T /F";
  assert.ok(!/codex/i.test(cmd));
  assert.equal(rule(cmd), "force-kill");
});

// ── codex review spellings ────────────────────────────────────────────────────
check("blocks a versioned absolute-path codex.exe review", () => {
  assert.equal(
    rule('"/c/Users/mason/AppData/Local/OpenAI/Codex/bin/110b3d66a02d864e/codex.exe" review --base origin/main'),
    "codex-review",
  );
});

check("blocks codex review wrapped in pwsh -Command", () => {
  assert.equal(rule('pwsh -NoProfile -Command "codex review --base origin/main"'), "codex-review");
});

check("blocks codex review after a shell separator", () => {
  assert.equal(rule("cd /repo && codex review --uncommitted"), "codex-review");
});

check("blocks the $CODEX spelling this repo's own skill documented", () => {
  // `"$CODEX" review $SCOPE` is verbatim what .claude/skills/codex-review/SKILL.md
  // printed. A guard that missed it would have waved through the documented path.
  assert.equal(rule('"$CODEX" review $SCOPE -c approval_policy=never'), "codex-review");
  assert.equal(rule("$CODEX review --base origin/main"), "codex-review");
  assert.equal(rule("${CODEX} review --base origin/main"), "codex-review");
});

// ── Must NOT block ────────────────────────────────────────────────────────────
check("allows codex exec — the wrapper and one-off prompts depend on it", () => {
  assert.equal(blocks("codex exec --skip-git-repo-check -"), null);
});

check("allows the sanctioned wrapper", () => {
  assert.equal(blocks("node scripts/write-codex-push-proof.mjs"), null);
});

check("allows prose merely mentioning codex review", () => {
  assert.equal(blocks('echo "do not run codex review here"'), null,
    "echo of the phrase has no invocation shape");
});

check("allows a polite kill without a force flag", () => {
  assert.equal(blocks("kill 1234"), null);
});

check("allows unrelated commands", () => {
  assert.equal(blocks("npm run test"), null);
  assert.equal(blocks("git status --short"), null);
  assert.equal(blocks(""), null);
  assert.equal(blocks(undefined), null);
});

check("allows a filename that merely contains the word killall", () => {
  assert.equal(blocks("cat docs/killall-notes.md"), null);
});

// ── Deny payload shape ────────────────────────────────────────────────────────
check("a blocked command names the wrapper as the alternative", () => {
  const v = classifyCommand("codex review --base origin/main");
  assert.match(v.reason, /write-codex-push-proof\.mjs/);
});

check("a blocked kill points at TaskStop rather than another kill", () => {
  const v = classifyCommand("taskkill /PID 1 /F");
  assert.match(v.reason, /TaskStop/);
});

console.log(`\n${passed} checks passed.`);

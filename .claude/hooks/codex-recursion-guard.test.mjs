#!/usr/bin/env node
// Tests for codex-recursion-guard.mjs.
//
// The two REAL commands from the 2026-08-23 incident are the first cases, verbatim:
// a guard that does not stop those has not fixed anything.

import assert from "node:assert/strict";
import { classifyCommand, normalizeExecutable } from "./codex-recursion-guard.mjs";

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

// ── Bypasses Sol found on PR #452 (each failed before the fix) ────────────────
check("P2: blocks `cmd /c codex review` — cmd's wrapper is a command position too", () => {
  assert.equal(rule("cmd /c codex review --base origin/main"), "codex-review");
  assert.equal(rule("cmd.exe /K codex review"), "codex-review");
});

check("P2: blocks global options placed BEFORE the review subcommand", () => {
  // Legal codex usage — options may precede the subcommand. A pattern demanding
  // `codex` and `review` be adjacent waved this through.
  assert.equal(rule('codex -c model="gpt-5.6-sol" review --base origin/main'), "codex-review");
  assert.equal(rule("codex --cd /repo -c approval_policy=never review"), "codex-review");
});

check("P3: blocks the SIGKILL spellings", () => {
  assert.equal(rule("kill -SIGKILL 1234"), "force-kill");
  assert.equal(rule("kill -s SIGKILL 1234"), "force-kill");
  assert.equal(rule("kill -s 9 1234"), "force-kill");
});

check("blocks PowerShell's kill alias, where kill IS Stop-Process", () => {
  assert.equal(rule("kill -Id 39564 -Force"), "force-kill");
  assert.equal(rule("spps -Id 39564"), "force-kill");
});

check("HIGH: blocks the four path/extension spellings Sol proved were allowed", () => {
  // Verbatim from Sol's BLOCKERS verdict on 72405060. Ordinary Windows and POSIX
  // spellings, not obfuscation — each one recreates the reviewer-kill exactly.
  assert.equal(rule("taskkill.exe /PID 39564 /T /F"), "force-kill");
  assert.equal(rule("C:\\Windows\\System32\\taskkill.exe /PID 39564 /T /F"), "force-kill");
  assert.equal(rule("/usr/bin/pkill -9 codex"), "force-kill");
  assert.equal(rule("/bin/kill -9 39564"), "force-kill");
});

check("normalizeExecutable strips path, extension, quotes, and case", () => {
  assert.equal(normalizeExecutable('"C:\\Windows\\System32\\TaskKill.EXE"'), "taskkill");
  assert.equal(normalizeExecutable("/usr/bin/pkill"), "pkill");
  assert.equal(normalizeExecutable("Stop-Process"), "stop-process");
  assert.equal(normalizeExecutable("node"), "node");
});

check("a pathed codex binary review is still caught after the rewrite", () => {
  assert.equal(rule("/usr/local/bin/codex review --base origin/main"), "codex-review");
});

check("still allows codex exec even when the prompt text says review", () => {
  // exec is the subcommand; "review" here is prompt content, not a subcommand.
  assert.equal(blocks('codex exec "review this diff and report"'), null);
  assert.equal(blocks("codex exec --skip-git-repo-check -"), null);
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

check("HIGH: blocks a BARE kill — on Windows `kill` IS Stop-Process", () => {
  // This assertion previously read `assert.equal(blocks("kill 1234"), null)`, pinning
  // a "polite TERM" exemption that is a POSIX fact and false on this machine. Sol
  // proved by read-only execution that `kill 39564` returned "allow". A test that
  // pins a wrong assumption makes the bug permanent — so the exemption is gone and
  // this is its inverse.
  assert.equal(rule("kill 1234"), "force-kill");
  assert.equal(rule("kill 39564"), "force-kill");
});

check("HIGH: blocks launcher-based execution of a guarded kill tool", () => {
  // Sol proved `Start-Process taskkill.exe … /F` slipped past a check that only
  // looked at the command-position token.
  assert.equal(rule("Start-Process taskkill.exe -ArgumentList '/PID','39564','/F'"), "force-kill");
  assert.equal(rule("sudo pkill -9 codex"), "force-kill");
  assert.equal(rule("saps taskkill"), "force-kill");
  assert.equal(rule('pwsh -NoProfile -Command "taskkill /PID 1 /F"'), "force-kill");
});

check("a launcher running something harmless is still allowed", () => {
  assert.equal(blocks("sudo npm install"), null);
  assert.equal(blocks("timeout 90 codex exec -"), null);
  assert.equal(blocks("env NODE_ENV=test npm run test"), null);
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

#!/usr/bin/env node
// Mutation tests for the guarded-surface lock.
//
// These are deliberately NOT "does it allow normal work" tests. A lock that has
// only ever been observed passing has not been tested — what matters is that it
// REFUSES on every route an agent could actually take to reach an enforcement
// file. So each case below names one concrete bypass and asserts the refusal.
//
// The ALLOW assertions are load-bearing too: a lock that refuses everything
// would pass every deny case while making the repository unusable, and — worse —
// would tempt someone to disable it wholesale.
//
// Run: node .claude/hooks/guarded-surface-lib.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateGuardedSurface,
  guardedSurfacePath,
  guardedSurfaceDirectory,
  shellCommandIsReadOnly,
  commandTouchesGuardedSurface,
  unlockValid,
  UNLOCK_PHRASE,
} from "./guarded-surface-lib.mjs";
import { extractPatchDestinations } from "./codex-push-lib.mjs";

let pass = 0;
const NOW = Date.parse("2026-08-31T12:00:00.000Z");

function judge(input, { unlock = null, toolName = "Bash" } = {}) {
  return evaluateGuardedSurface({ toolName, input, unlock, nowMs: NOW, extractPatchDestinations });
}
function denies(verdict, why) {
  assert.equal(verdict.decision, "block", `${why} — expected a refusal, got ${verdict.decision}`);
  assert.ok(/GUARDED SURFACE LOCK/.test(String(verdict.reason)), `${why} — refusal did not identify itself`);
  pass++;
}
function allows(verdict, why) {
  assert.equal(verdict.decision, "allow", `${why} — expected allow, got block: ${String(verdict.reason).slice(0, 200)}`);
  pass++;
}

// ---------------------------------------------------------------------------
// 1. The surface itself
// ---------------------------------------------------------------------------
for (const p of [
  ".claude/hooks/migration-apply-guard.mjs",
  ".claude/hooks/guarded-surface-lock.mjs",
  ".claude/hooks/guarded-surface-lib.mjs",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/hooks/production-action-guard.mjs",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".husky/pre-push",
  ".husky/pre-commit",
  ".github/workflows/ci.yml",
  ".coderabbit.yaml",
  "package.json",
  "package-lock.json",
  "scripts/check-ledger-update.mjs",
  "scripts/validate-sql.mjs",
  "scripts/verify-deps.mjs",
  "scripts/write-codex-push-proof.mjs",
  "scripts/remove-applied-ledger-entry.mjs",
  "scripts/run-claude-review.mjs",
  "scripts/guard-unlock.mjs",
  "C:/CRX_Manager/.claude/hooks/bash-safety.mjs",
]) {
  assert.ok(guardedSurfacePath(p), `${p} must be recognized as guarded`);
  denies(judge({ file_path: p }, { toolName: "Write" }), `Write to ${p}`);
  pass++;
}

// Self-protection is the load-bearing case: without it the lock is decorative.
assert.ok(guardedSurfacePath("scripts/guard-unlock.mjs"), "the unlock switch must protect itself");
assert.ok(guardedSurfacePath(".claude/hooks/guarded-surface-lib.mjs"), "the rule book must protect itself");
pass += 2;

// ---------------------------------------------------------------------------
// 2. Files that must stay editable — the whole point of the change
// ---------------------------------------------------------------------------
for (const p of [
  "src/pages/Invoices.tsx",
  "src/lib/db.ts",
  "supabase/migrations/20260831120000_x.sql",
  "docs/CHANGELOG.md",
  "AGENTS.md",            // prose contract: advises, does not enforce
  "CLAUDE.md",
  "scripts/smoke/run-smoke.mjs",
  "docs/changelog.d/2026-08-31-x.md",
]) {
  assert.ok(!guardedSurfacePath(p), `${p} must NOT be guarded`);
  allows(judge({ file_path: p }, { toolName: "Write" }), `Write to ${p}`);
  pass++;
}

// ---------------------------------------------------------------------------
// 3. Directory-level destruction — kills every guard without naming a guard file
// ---------------------------------------------------------------------------
for (const dir of [".claude/hooks", ".codex/hooks", ".husky", ".github/workflows", ".claude"]) {
  assert.ok(guardedSurfaceDirectory(dir), `${dir} must be recognized as a guarded directory`);
  denies(judge({ path: dir }, { toolName: "delete_directory" }), `delete_directory ${dir}`);
  denies(judge({ source: dir, destination: "/tmp/x" }, { toolName: "move_file" }), `move_file ${dir}`);
  pass++;
}

// ---------------------------------------------------------------------------
// 4. Shell writes — every route that edits a file without the Edit tool
// ---------------------------------------------------------------------------
for (const cmd of [
  'echo "" > .claude/hooks/migration-apply-guard.mjs',
  'echo "" >> .husky/pre-push',
  "sed -i 's/deny/allow/' .claude/hooks/bash-safety.mjs",
  "cp /tmp/evil.mjs .claude/hooks/bash-safety.mjs",
  "mv /tmp/evil.mjs .claude/hooks/bash-safety.mjs",
  "rm .claude/hooks/money-safety.mjs",
  "rm -rf .claude/hooks",
  "tee .husky/pre-commit < /tmp/x",
  "truncate -s 0 .claude/settings.json",
  "install -m 755 /tmp/x .husky/pre-push",
  "python -c \"open('.claude/settings.json','w')\"",
  "perl -i -pe 's/x/y/' .husky/pre-push",
  "patch .husky/pre-push < /tmp/p.diff",
  "find .claude/hooks -name '*.mjs' -delete",
  "cat /tmp/x | xargs -I{} cp {} .claude/hooks/",
  // Removing the blanket redirect test must NOT reopen these.
  "sed -i s/deny/allow/ .claude/hooks/bash-safety.mjs 2>/dev/null",
  "echo x > .claude/hooks/bash-safety.mjs 2>/dev/null",
  // git subcommands are the documented destination-guard bypass class
  "git checkout main -- .claude/hooks/bash-safety.mjs",
  "git restore --source=HEAD~5 .claude/hooks/",
  "git apply /tmp/disable-guards.patch",
  "git rm .claude/hooks/sql-safety.mjs",
  "git mv .husky/pre-push .husky/pre-push.bak",
  // package.json rewritten without ever naming it
  "npm pkg set scripts.typecheck=\"exit 0\"",
  "npm install some-package",
  "npm uninstall vitest",
  "yarn add left-pad",
]) {
  denies(judge({ command: cmd }), `shell write: ${cmd}`);
}

// ---------------------------------------------------------------------------
// 5. Obfuscation — the shell resolves these to the real path at run time
// ---------------------------------------------------------------------------
for (const cmd of [
  'echo x > .clau"de"/hooks/bash-safety.mjs',      // quote-split
  "echo x > .clau\\de/hooks/bash-safety.mjs",       // backslash dropped by shell
  "echo x > $'\\x2eclaude/hooks/bash-safety.mjs'",  // ANSI-C escape
  "rm -rf .clau*/hooks",                            // glob expands to .claude
  "rm -rf .hus*",                                   // glob expands to .husky
]) {
  denies(judge({ command: cmd }), `obfuscated write: ${cmd}`);
}

// ---------------------------------------------------------------------------
// 5b. The three bypasses Codex found in round 2. Each was a real HIGH.
// ---------------------------------------------------------------------------

// (1) Forging the unlock record. `Write` is blanket-allowed and the hook trusts
// this file, so if the path is not guarded an agent simply writes itself an
// unlock, then rewrites a production guard. The TTY prompt is no defense.
assert.ok(guardedSurfacePath(".claude/session-state/guard-unlock.json"), "the unlock RECORD must be guarded, not just the script");
pass++;
for (const payload of [
  { file_path: ".claude/session-state/guard-unlock.json" },
  { path: ".claude/session-state/guard-unlock.json" },
  { command: 'echo {"kind":"guarded-surface-unlock"} > .claude/session-state/guard-unlock.json' },
]) {
  denies(judge(payload, { toolName: "Write" }), `forged unlock via ${Object.keys(payload)[0]}`);
}

// (2) Mixed case. CRX runs on a case-INSENSITIVE Windows filesystem, so these
// spellings edit the real files while a case-sensitive matcher returns allow.
for (const p of [
  ".CLAUDE/hooks/sql-safety.mjs",
  ".Claude/Hooks/money-safety.mjs",
  ".HUSKY/pre-push",
  "Package.json",
  ".CLAUDE/settings.json",
  "SCRIPTS/verify-deps.mjs",
]) {
  assert.ok(guardedSurfacePath(p), `mixed-case path must still be guarded: ${p}`);
  denies(judge({ file_path: p }, { toolName: "Write" }), `mixed-case write: ${p}`);
  pass++;
}
denies(judge({ command: "echo x > .CLAUDE/hooks/sql-safety.mjs" }), "mixed-case shell redirect");

// (3) A lone `&` separates commands exactly like `;`, but only `&&` was split,
// so the read-only head of the FIRST command vouched for a writer after it.
for (const cmd of [
  "cat .claude/settings.json & rm .claude/hooks/sql-safety.mjs",
  "ls & cp /tmp/evil.mjs .claude/hooks/bash-safety.mjs",
  "grep -n x .husky/pre-push & sed -i s/a/b/ .husky/pre-push",
]) {
  denies(judge({ command: cmd }), `lone-& compound: ${cmd}`);
}

// ---------------------------------------------------------------------------
// 5c. Codex round 3. Two patchable bypasses (the third — that a script an agent
// writes and runs bypasses the hook entirely — is NOT patchable here and is
// recorded honestly instead; see DECISION_LOG 2026-08-31).
// ---------------------------------------------------------------------------

// (4) Path traversal. These resolve to real guarded files.
for (const p of [
  ".claude/session-state/../hooks/sql-safety.mjs",
  ".claude/hooks/../hooks/money-safety.mjs",
  "docs/../.claude/settings.json",
  ".claude/./hooks/bash-safety.mjs",
  ".claude/session-state/../../.claude/hooks/env-guard.mjs",
  "scripts/../.husky/pre-push",
  ".claude/hooks/../session-state/guard-unlock.json",   // traversal onto the unlock record
]) {
  assert.ok(guardedSurfacePath(p), `traversal must resolve to a guarded path: ${p}`);
  denies(judge({ file_path: p }, { toolName: "Write" }), `traversal write: ${p}`);
  pass++;
}
// Traversal must not over-reach: these genuinely are not guarded.
for (const p of [
  ".claude/hooks/../../src/lib/db.ts",
  "docs/manual/../reference/gotchas.md",
  "../sibling-repo/.claude/hooks/x.mjs",   // outside this repo root
]) {
  assert.ok(!guardedSurfacePath(p) || p.startsWith(".."), `traversal must not over-block: ${p}`);
  pass++;
}

// (5) Process-input channel. A shell-capable MCP runner feeds its command
// through stdin, which the evaluator did not read at all.
for (const field of ["input", "stdin"]) {
  denies(
    judge({ [field]: "echo x > .claude/hooks/sql-safety.mjs" }, { toolName: "mcp__Desktop_Commander__interact_with_process" }),
    `process-input channel via ${field}`,
  );
}
// File CONTENT must stay unjudged as shell text, or writing documentation that
// quotes a guarded path would be denied.
allows(
  judge({ file_path: "docs/reference/gotchas.md", content: "run: echo x > .claude/hooks/sql-safety.mjs" }, { toolName: "Write" }),
  "prose quoting a guarded command is not itself a write to it",
);

// ---------------------------------------------------------------------------
// 6. Reads stay allowed — agents inspect guards constantly during normal work
// ---------------------------------------------------------------------------
for (const cmd of [
  "cat .claude/hooks/bash-safety.mjs",
  "head -50 .claude/settings.json",
  "grep -n deny .claude/hooks/money-safety.mjs",
  "rg 'permissionDecision' .claude/hooks/",
  "ls -la .husky/",
  "wc -l .claude/hooks/review-proof-guard.mjs",
  "git diff .claude/settings.json",
  "git show HEAD:.claude/settings.json",
  "git log --oneline .claude/hooks/",
  "git status --short",
  "node scripts/verify-deps.mjs",              // RUNS a guarded script, does not edit it
  "node scripts/agent-manifest-parity.mjs",
  "npm ci",                                     // needed in a fresh worktree
  "npm run test:agent-workflows",
  "git add .claude/settings.json",              // staging records content, does not change it
  // Stderr redirects are NOT writes. A blanket `/>>?/` test denied all of these
  // and blocked two real read-only diagnostics while this guard was being built.
  "grep -n wired scripts/check-doc-drift.mjs 2>/dev/null",
  "node scripts/verify-deps.mjs 2>&1",
  "cat .claude/settings.json 2>/dev/null",
  "git diff .claude/settings.json > /tmp/out.diff",   // reads a guard, writes elsewhere
]) {
  assert.ok(shellCommandIsReadOnly(cmd) || !commandTouchesGuardedSurface(cmd), `should be read-only: ${cmd}`);
  allows(judge({ command: cmd }), `read: ${cmd}`);
}

// A read and a write chained together must still refuse: the write is real.
denies(judge({ command: "cat .claude/settings.json && rm .husky/pre-push" }), "read chained with a write");

// ---------------------------------------------------------------------------
// 7. Patch-style tools carry the destination in the payload, not a path field
// ---------------------------------------------------------------------------
denies(
  judge({ patch: "*** Begin Patch\n*** Update File: .claude/hooks/bash-safety.mjs\n" }, { toolName: "apply_patch" }),
  "apply_patch targeting a guard",
);

// ---------------------------------------------------------------------------
// 8. The unlock — and every way a forged one must fail
// ---------------------------------------------------------------------------
const validUnlock = {
  kind: "guarded-surface-unlock",
  issuedAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 29 * 60_000).toISOString(),
};
assert.ok(unlockValid(validUnlock, NOW), "a fresh unlock must be valid");
pass++;
allows(judge({ file_path: ".claude/hooks/bash-safety.mjs" }, { toolName: "Write", unlock: validUnlock }), "edit while unlocked");
allows(judge({ command: "rm .husky/pre-push" }, { unlock: validUnlock }), "shell write while unlocked");

for (const [bad, why] of [
  [null, "absent unlock"],
  [{}, "empty object"],
  [{ kind: "wrong", issuedAt: validUnlock.issuedAt, expiresAt: validUnlock.expiresAt }, "wrong kind"],
  [{ kind: "guarded-surface-unlock", issuedAt: new Date(NOW - 7200_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString() }, "expired"],
  [{ kind: "guarded-surface-unlock", issuedAt: new Date(NOW + 3600_000).toISOString(), expiresAt: new Date(NOW + 7200_000).toISOString() }, "future-dated"],
  [{ kind: "guarded-surface-unlock", issuedAt: validUnlock.issuedAt, expiresAt: new Date(NOW + 99 * 3600_000).toISOString() }, "absurdly long window"],
  [{ kind: "guarded-surface-unlock", issuedAt: "nonsense", expiresAt: "nonsense" }, "unparseable timestamps"],
]) {
  assert.ok(!unlockValid(bad, NOW), `${why} must not validate`);
  denies(judge({ file_path: ".claude/hooks/bash-safety.mjs" }, { toolName: "Write", unlock: bad }), `edit with ${why}`);
  pass++;
}

// The phrase is part of the human gate; if it drifts, guard-unlock.mjs and its
// on-screen instruction disagree and Mason cannot unlock.
assert.equal(UNLOCK_PHRASE, "unlock the guards", "unlock phrase changed — update scripts/guard-unlock.mjs docs too");
pass++;

// ---------------------------------------------------------------------------
// 9. The refusal must TEACH, not just refuse
// ---------------------------------------------------------------------------
const reason = String(judge({ file_path: ".claude/hooks/bash-safety.mjs" }, { toolName: "Write" }).reason);
assert.ok(reason.includes("scripts/guard-unlock.mjs"), "refusal must name the unlock command");
assert.ok(/interactive terminal/i.test(reason), "refusal must explain why an agent cannot self-unlock");
assert.ok(/Reading these files is always allowed/i.test(reason), "refusal must say reads are fine, to stop pointless retries");
pass += 3;

// ---------------------------------------------------------------------------
// 10. End-to-end through the HOOK itself
// ---------------------------------------------------------------------------
// The rule book being right proves nothing if the wiring drops the verdict on
// the floor. These spawn the real hook over stdin, exactly as Claude Code does,
// and read the JSON it emits back.
const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "guarded-surface-lock.mjs");
function runHook(payload) {
  const res = spawnSync(process.execPath, [hookPath], { input: JSON.stringify(payload), encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || "null"); } catch { parsed = null; }
  return { status: res.status, decision: parsed?.hookSpecificOutput?.permissionDecision ?? "allow" };
}

// These run against whatever unlock state the machine is actually in, so they
// must not assume "locked". Asserting a hard deny here made the suite pass or
// fail depending on whether Mason happened to have the surface unlocked — a
// test that changes its answer with ambient state is worse than no test.
// Instead, assert the HOOK's decision equals the RULE BOOK's decision for the
// same payload and the same ambient unlock. That is what end-to-end is for:
// proving the wiring carries the verdict through, in either state. The
// deny-specific coverage lives in the rule-book assertions above, which pass an
// explicit unlock and are therefore deterministic.
const ambientUnlock = (() => {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "session-state", "guard-unlock.json"), "utf8"));
  } catch { return null; }
})();
const ambientUnlocked = unlockValid(ambientUnlock, Date.now());

for (const payload of [
  { tool_name: "Write", tool_input: { file_path: ".claude/hooks/bash-safety.mjs", content: "x" } },
  { tool_name: "Edit", tool_input: { file_path: ".husky/pre-push" } },
  { tool_name: "Write", tool_input: { file_path: ".claude/settings.json" } },
  { tool_name: "mcp__filesystem__write_file", tool_input: { path: ".claude/hooks/money-safety.mjs" } },
  { tool_name: "mcp__filesystem__move_file", tool_input: { source: ".claude/hooks", destination: "/tmp/x" } },
  { tool_name: "Bash", tool_input: { command: "echo x > .claude/hooks/sql-safety.mjs" } },
  { tool_name: "Bash", tool_input: { command: "git checkout main -- .husky/pre-push" } },
  { tool_name: "Bash", tool_input: { command: 'npm pkg set scripts.typecheck="exit 0"' } },
  { tool_name: "PowerShell", tool_input: { command: "Remove-Item .claude/hooks/env-guard.mjs" } },
]) {
  const expected = evaluateGuardedSurface({
    toolName: payload.tool_name,
    input: payload.tool_input,
    unlock: ambientUnlock,
    nowMs: Date.now(),
    extractPatchDestinations,
  }).decision === "block" ? "deny" : "allow";
  // Sanity floor: while LOCKED these must be denials, or the guard is inert.
  if (!ambientUnlocked) {
    assert.equal(expected, "deny", `rule book must deny while locked: ${JSON.stringify(payload.tool_input).slice(0, 80)}`);
  }
  assert.equal(runHook(payload).decision, expected, `hook must match rule book: ${JSON.stringify(payload.tool_input).slice(0, 80)}`);
  pass++;
}
if (ambientUnlocked) {
  console.log("  note: guarded surface is currently UNLOCKED — end-to-end denials were checked as hook/rule-book agreement, not as hard denials.");
}

for (const payload of [
  { tool_name: "Write", tool_input: { file_path: "src/pages/Invoices.tsx", content: "x" } },
  { tool_name: "Edit", tool_input: { file_path: "AGENTS.md" } },
  { tool_name: "Bash", tool_input: { command: "cat .claude/settings.json" } },
  { tool_name: "Bash", tool_input: { command: "grep -rn deny .claude/hooks/" } },
  { tool_name: "Bash", tool_input: { command: "npm ci" } },
  { tool_name: "Bash", tool_input: { command: "npm run build" } },
]) {
  assert.equal(runHook(payload).decision, "allow", `hook must allow: ${JSON.stringify(payload.tool_input).slice(0, 90)}`);
  pass++;
}

// A malformed payload must not crash the hook into failing OPEN.
assert.equal(
  spawnSync(process.execPath, [hookPath], { input: "not json", encoding: "utf8" }).status, 0,
  "hook must exit 0 on unparseable input",
);
pass++;

console.log(`guarded-surface-lib: ${pass} assertions passed`);

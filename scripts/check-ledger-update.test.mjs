#!/usr/bin/env node
// Tests for the pre-commit ledger guard (scripts/check-ledger-update.mjs).
// Run: node scripts/check-ledger-update.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerCheck } from "./check-ledger-update.mjs";

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

const ledgerGuardSource = readFileSync(new URL("./check-ledger-update.mjs", import.meta.url), "utf8");
ok(ledgerGuardSource.includes('"--diff-filter=ACMRTD"'), "CLI includes staged Git type changes");
ok(ledgerGuardSource.includes('"--no-renames"'), "CLI preserves both sides of staged renames");

// ── no triggers → always ok ─────────────────────────────────────────────────
eq(ledgerCheck([]).ok, true, "empty commit is ok");
eq(ledgerCheck(["src/pages/Invoices.tsx", "src/lib/money.ts"]).ok, true, "pure src/ change needs no ledger");
eq(ledgerCheck(["docs/reference/gotchas.md"]).ok, true, "ordinary doc edit is not a trigger");
eq(ledgerCheck(["scripts/smoke/run-smoke.mjs"]).ok, true, "non-guard script is not a trigger");
eq(ledgerCheck(["package.json", "package-lock.json"]).ok, true, "dependency bump alone is not a trigger");

// ── triggers WITHOUT a ledger → blocked ─────────────────────────────────────
eq(ledgerCheck([".claude/hooks/migration-apply-guard.mjs"]).ok, false, "hook change without ledger is blocked");
eq(ledgerCheck([".claude/commands/ship.md"]).ok, false, "command change without ledger is blocked");
eq(ledgerCheck([".claude/skills/codex-review/SKILL.md"]).ok, false, "skill change without ledger is blocked");
eq(ledgerCheck([".claude/workflows/migration-review.js"]).ok, false, "workflow change without ledger is blocked");
eq(ledgerCheck([".claude/settings.json"]).ok, false, "settings change without ledger is blocked");
eq(ledgerCheck([".codex/hooks/production-action-guard.mjs"]).ok, false, "Codex guard change without ledger is blocked");
eq(ledgerCheck([".codex/hooks.json"]).ok, false, "Codex hook manifest change without ledger is blocked");
eq(ledgerCheck(["AGENTS.md"]).ok, false, "shared-contract change without ledger is blocked");
eq(ledgerCheck(["CLAUDE.md"]).ok, false, "CLAUDE.md change without ledger is blocked");
eq(ledgerCheck([".husky/pre-commit"]).ok, false, "pre-commit hook change without ledger is blocked");
eq(ledgerCheck(["scripts/check-doc-drift.mjs"]).ok, false, "guard-script change without ledger is blocked");
eq(ledgerCheck(["scripts/validate-sql.sh"]).ok, false, "validator change without ledger is blocked");
eq(ledgerCheck(["scripts/verify-deps.mjs"]).ok, false, "verifier change without ledger is blocked");
eq(ledgerCheck(["scripts/sync-agent-workflows.mjs"]).ok, false, "workflow-sync change without ledger is blocked");
eq(ledgerCheck(["scripts/run-claude-review.mjs"]).ok, false, "Claude proof wrapper change without ledger is blocked");
eq(ledgerCheck(["scripts/write-codex-push-proof.mjs"]).ok, false, "Codex proof wrapper change without ledger is blocked");
eq(ledgerCheck(["scripts/check-ledger-update.mjs"]).ok, false, "this guard itself is a trigger (self-covering)");
eq(ledgerCheck(["supabase/migrations/20260716000000_add_foo.sql"]).ok, false, "a new migration without a ledger update is blocked (2026-07-16)");
ok(/ledger/i.test(ledgerCheck(["AGENTS.md"]).reason), "block reason explains the ledger requirement");
eq(ledgerCheck([".claude/hooks/guards.test.mjs", "src/lib/db.ts"]).ok, false, "mixed commit with a hook-test change still needs a ledger");

// ── triggers WITH a ledger → ok (any one ledger file satisfies) ─────────────
eq(ledgerCheck([".claude/hooks/migration-apply-guard.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies");
eq(ledgerCheck([".codex/hooks/production-action-guard.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a Codex guard change");
eq(ledgerCheck(["AGENTS.md", "docs/manual/DECISION_LOG.md"]).ok, true, "DECISION_LOG satisfies");
eq(ledgerCheck([".claude/settings.json", "docs/manual/KNOWN_ISSUES.md"]).ok, true, "KNOWN_ISSUES satisfies");
eq(ledgerCheck([".claude/commands/ship.md", "docs/manual/OWNER_PLAYBOOK.md"]).ok, true, "another docs/manual file satisfies");
eq(ledgerCheck([".husky/pre-commit", "docs/reference/agent-guardrails.md"]).ok, true, "agent-guardrails.md satisfies");
eq(ledgerCheck(["scripts/check-doc-drift.mjs", "docs/loops/tooling-loop-ledger.md"]).ok, true, "a loop ledger satisfies");
eq(ledgerCheck(["scripts/run-claude-review.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a Claude proof-wrapper change");
eq(ledgerCheck(["scripts/write-codex-push-proof.mjs", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a Codex proof-wrapper change");
eq(ledgerCheck(["supabase/migrations/20260716000000_add_foo.sql", "docs/CHANGELOG.md"]).ok, true, "CHANGELOG satisfies a migration commit");
eq(ledgerCheck(["supabase/migrations/20260716000000_add_foo.sql", "docs/reference/migration-history.md"]).ok, true, "migration-history.md satisfies a migration commit (its natural ledger companion)");

// ── path normalization ───────────────────────────────────────────────────────
eq(ledgerCheck([".claude\\hooks\\bash-safety.mjs"]).ok, false, "backslash paths are normalized (still a trigger)");
eq(ledgerCheck([".claude\\hooks\\bash-safety.mjs", "docs\\CHANGELOG.md"]).ok, true, "backslash ledger path is normalized too");

// ── non-ledger docs do NOT satisfy ───────────────────────────────────────────
eq(ledgerCheck([".claude/hooks/bash-safety.mjs", "docs/reference/gotchas.md"]).ok, false, "gotchas.md is not a ledger — still blocked");
eq(ledgerCheck([".claude/hooks/bash-safety.mjs", "README.md"]).ok, false, "README is not a ledger — still blocked");

// A rename must expose both the protected source and unprotected destination.
// Without --no-renames, --name-only reports only src/moved.mjs and the CLI exits 0.
const renameRepo = mkdtempSync(join(tmpdir(), "crx-ledger-rename-"));
try {
  const git = (...args) => execFileSync("git", args, { cwd: renameRepo, stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "ledger-test@example.invalid");
  git("config", "user.name", "Ledger Test");
  mkdirSync(join(renameRepo, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(renameRepo, ".claude", "hooks", "protected.mjs"), "export default true;\n");
  git("add", ".claude/hooks/protected.mjs");
  git("commit", "--quiet", "-m", "fixture");
  mkdirSync(join(renameRepo, "src"), { recursive: true });
  git("mv", ".claude/hooks/protected.mjs", "src/moved.mjs");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./check-ledger-update.mjs", import.meta.url))], {
    cwd: renameRepo,
    encoding: "utf8",
  });
  eq(run.status, 1, "protected file renamed to an unprotected path is still blocked");
  ok(`${run.stdout}${run.stderr}`.includes("LEDGER UPDATE REQUIRED"), "rename block explains the ledger requirement");
} finally {
  rmSync(renameRepo, { recursive: true, force: true });
}

console.log(`check-ledger-update: ${pass} assertions passed`);

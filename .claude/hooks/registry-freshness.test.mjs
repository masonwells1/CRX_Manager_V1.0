#!/usr/bin/env node
// Tests for the registry-freshness PostToolUse watchdog (A8) + the sql-safety
// REGISTRY-STALE gate it feeds. Each spawn gets its own temp CLAUDE_PROJECT_DIR
// so no real session-state is touched.
// Run: node .claude/hooks/registry-freshness.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(file, payload, projectDir) {
  return spawnSync(process.execPath, [path.join(__dirname, file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "registry-freshness-test-"));
const flagPathIn = (dir) => path.join(dir, ".claude", "session-state", "REGISTRY-STALE.flag");

try {
  // ── (a) apply_migration with registry-relevant DDL → flag written + context emitted ─
  const dirA = path.join(tmpRoot, "a");
  mkdirSync(dirA, { recursive: true });
  let r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "rhyzpcqhnizqbxphqdkr", name: "20990101000000_test_table", query: "CREATE TABLE x (id int);" },
  }, dirA);
  eq(r.status, 0, "apply+DDL exits 0");
  ok(existsSync(flagPathIn(dirA)), "flag file created for CREATE TABLE apply");
  const flag = JSON.parse(readFileSync(flagPathIn(dirA), "utf8"));
  ok(typeof flag.created === "string" && !Number.isNaN(Date.parse(flag.created)), "flag has a parseable created timestamp");
  eq(flag.migration_hint, "20990101000000_test_table", "flag carries the migration name as hint");
  const outA = JSON.parse(r.stdout);
  eq(outA.hookSpecificOutput.hookEventName, "PostToolUse", "emits a PostToolUse output block");
  ok(outA.hookSpecificOutput.additionalContext.includes("regen-schema-registry"), "context points at /regen-schema-registry");
  ok(outA.hookSpecificOutput.additionalContext.includes("--from-introspection"), "context names the REAL refresh mode");
  ok(outA.hookSpecificOutput.additionalContext.includes("REGISTRY-STALE.flag"), "context says which flag to delete after verifying");

  // ── (b) apply_migration with SELECT-only SQL → silent, no flag ──────────
  const dirB = path.join(tmpRoot, "b");
  mkdirSync(dirB, { recursive: true });
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "sel_only", query: "SELECT * FROM invoices;" },
  }, dirB);
  eq(r.status, 0, "select-only apply exits 0");
  eq(r.stdout.trim(), "", "select-only apply is silent");
  ok(!existsSync(flagPathIn(dirB)), "no flag for select-only apply");

  // DDL mentioned only in a SQL line comment → silent (comments are stripped first)
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "cmt_only", query: "-- CREATE TABLE mentioned in a doc comment\nSELECT 1;" },
  }, dirB);
  eq(r.stdout.trim(), "", "comment-only DDL mention is silent");
  ok(!existsSync(flagPathIn(dirB)), "no flag for comment-only DDL mention");

  // ── (c) non-apply tool with DDL → silent, no flag ───────────────────────
  const dirC = path.join(tmpRoot, "c");
  mkdirSync(dirC, { recursive: true });
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__execute_sql",
    tool_input: { query: "CREATE TABLE x (id int);" },
  }, dirC);
  eq(r.status, 0, "non-apply tool exits 0");
  eq(r.stdout.trim(), "", "non-apply tool is silent");
  ok(!existsSync(flagPathIn(dirC)), "no flag for non-apply tool");

  // ── sql-safety REGISTRY-STALE gate ───────────────────────────────────────
  // Benign body: trips none of sql-safety's other rules (1-8), so any deny is the gate.
  const benignMigrationWrite = (dir) => runHook("sql-safety.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000000_benign.sql", content: "SELECT 1;" },
  }, dir);

  // Flag present → migration-file write is BLOCKED with the plain-English reason
  const dirD = path.join(tmpRoot, "d");
  mkdirSync(path.dirname(flagPathIn(dirD)), { recursive: true });
  writeFileSync(flagPathIn(dirD), JSON.stringify({ created: new Date().toISOString(), migration_hint: "test" }) + "\n");
  r = benignMigrationWrite(dirD);
  eq(r.status, 0, "sql-safety exits 0 (the deny rides in stdout)");
  ok(r.stdout.includes('"deny"'), "sql-safety denies a migration write while the flag exists");
  ok(r.stdout.includes("REGISTRY STALE"), "deny reason names the stale registry");
  ok(r.stdout.includes("regen-schema-registry"), "deny reason points at the refresh skill");

  // Flag present + exempt marker → the existing escape hatch skips the gate too
  r = runHook("sql-safety.mjs", {
    tool_name: "Write",
    tool_input: { file_path: "supabase/migrations/20990101000001_exempt.sql", content: "-- sql-safety: exempt-registry (test justification)\nSELECT 1;" },
  }, dirD);
  ok(r.stdout.includes('"allow"'), "exempt-registry marker bypasses the stale gate");

  // No flag → the same write passes
  const dirE = path.join(tmpRoot, "e");
  mkdirSync(dirE, { recursive: true });
  r = benignMigrationWrite(dirE);
  ok(r.stdout.includes('"allow"'), "sql-safety allows the same write when no flag exists");
  ok(!r.stdout.includes('"deny"'), "no deny without the flag");

  // ── FIX 3 (2026-07-13) — DROP CONSTRAINT / DROP SEQUENCE now flag the registry ──
  const dirF = path.join(tmpRoot, "f");
  mkdirSync(dirF, { recursive: true });
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "drop_constraint_test", query: "ALTER TABLE invoices DROP CONSTRAINT invoices_balance_non_negative;" },
  }, dirF);
  ok(existsSync(flagPathIn(dirF)), "DROP CONSTRAINT applies -> flag written");
  const outF = JSON.parse(r.stdout);
  ok(outF.hookSpecificOutput.additionalContext.includes("DROP CONSTRAINT"), "context names DROP CONSTRAINT as the matched DDL");

  const dirG = path.join(tmpRoot, "g");
  mkdirSync(dirG, { recursive: true });
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "drop_sequence_test", query: "DROP SEQUENCE cm_invoice_number_seq;" },
  }, dirG);
  ok(existsSync(flagPathIn(dirG)), "DROP SEQUENCE applies -> flag written");
  const outG = JSON.parse(r.stdout);
  ok(outG.hookSpecificOutput.additionalContext.includes("DROP SEQUENCE"), "context names DROP SEQUENCE as the matched DDL");

  // Sanity: an ADD CONSTRAINT-only migration (no DROP) still matches via the
  // pre-existing ADD CONSTRAINT pattern, unaffected by the new patterns.
  const dirH = path.join(tmpRoot, "h");
  mkdirSync(dirH, { recursive: true });
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "add_constraint_test", query: "ALTER TABLE invoices ADD CONSTRAINT chk_x CHECK (total_cents >= 0);" },
  }, dirH);
  ok(existsSync(flagPathIn(dirH)), "ADD CONSTRAINT still applies -> flag written (unaffected by FIX 3)");

  // ── FIX 4 (2026-07-13) — cross-worktree flag sharing, end-to-end ────────
  // A live apply from inside a git WORKTREE must be visible to sql-safety.mjs
  // running in the MAIN checkout (or a sibling worktree) — not just the
  // worktree that made the apply. Uses a real `git worktree add`.
  function git(args, cwd) {
    return spawnSync("git", args, { cwd, encoding: "utf8" });
  }
  const mainRepo = path.join(tmpRoot, "fix4-main");
  mkdirSync(mainRepo, { recursive: true });
  git(["init", "-q"], mainRepo);
  git(["-c", "user.email=test@test.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);
  const wtDir = path.join(tmpRoot, "fix4-wt");
  git(["worktree", "add", "-q", "-b", "fix4-wt-branch", wtDir], mainRepo);

  // Apply (with registry-relevant DDL) happens FROM the worktree.
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "fix4_from_worktree", query: "CREATE TABLE fix4_test (id int);" },
  }, wtDir);
  eq(r.status, 0, "FIX4: apply from worktree exits 0");
  ok(existsSync(flagPathIn(mainRepo)), "FIX4: flag lands at the MAIN checkout's session-state dir");
  ok(existsSync(flagPathIn(wtDir)), "FIX4: flag ALSO lands at the worktree's own session-state dir");

  // sql-safety.mjs run from the MAIN checkout (which never applied anything
  // itself) must still see the stale registry and DENY a new migration write.
  r = benignMigrationWrite(mainRepo);
  ok(r.stdout.includes('"deny"'), "FIX4: sql-safety in the MAIN checkout denies after a worktree-side apply");
  ok(r.stdout.includes("REGISTRY STALE"), "FIX4: main-checkout deny names the stale registry");

  // A SIBLING worktree (that never applied anything and never wrote a flag
  // itself) must also see the stale registry via the shared common path.
  const siblingWt = path.join(tmpRoot, "fix4-wt-sibling");
  git(["worktree", "add", "-q", "-b", "fix4-wt-sibling-branch", siblingWt], mainRepo);
  r = benignMigrationWrite(siblingWt);
  ok(r.stdout.includes('"deny"'), "FIX4: sql-safety in a SIBLING worktree also denies (shared common path)");

  try {
    git(["worktree", "remove", "--force", wtDir], mainRepo);
    git(["worktree", "remove", "--force", siblingWt], mainRepo);
  } catch { /* best-effort cleanup */ }

  console.log(`registry-freshness: ${pass} assertions passed`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

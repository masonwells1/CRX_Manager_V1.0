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

  console.log(`registry-freshness: ${pass} assertions passed`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

#!/usr/bin/env node
// Tests for the registry-freshness PostToolUse watchdog (A8) + the sql-safety
// REGISTRY-STALE gate it feeds. Each spawn gets its own temp CLAUDE_PROJECT_DIR
// so no real session-state is touched.
// Run: node .claude/hooks/registry-freshness.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitLocalEnvironmentNames, scratchHookEnvironment } from "./git-test-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(file, payload, projectDir, inheritedEnv = process.env) {
  return spawnSync(process.execPath, [path.join(__dirname, file)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: scratchHookEnvironment(projectDir, inheritedEnv),
    cwd: projectDir,
  });
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "registry-freshness-test-"));
const flagPathIn = (dir) => path.join(dir, ".claude", "session-state", "REGISTRY-STALE.flag");
function git(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: scratchHookEnvironment(cwd, process.env),
  });
}

try {
  let r;
  // Inherited Git hook context must not bind a scratch child to another
  // checkout. This mirrors a normal `git commit` parent environment.
  const contaminatedParent = path.join(tmpRoot, "contaminated-parent");
  mkdirSync(contaminatedParent, { recursive: true });
  git(["init", "-q"], contaminatedParent);
  const dirIsolated = path.join(tmpRoot, "isolated");
  mkdirSync(dirIsolated, { recursive: true });
  const allRepositoryLocalGitEnv = Object.fromEntries(
    gitLocalEnvironmentNames().map((name) => [name, `inherited-${name}`]),
  );
  const contaminatedEnv = {
    ...process.env,
    ...allRepositoryLocalGitEnv,
    GIT_DIR: path.join(contaminatedParent, ".git"),
    GIT_WORK_TREE: contaminatedParent,
    GIT_INDEX_FILE: path.join(contaminatedParent, ".git", "index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "test.hookcontext",
    GIT_CONFIG_VALUE_0: "parent",
  };
  const sanitizedEnv = scratchHookEnvironment(dirIsolated, contaminatedEnv);
  ok(
    gitLocalEnvironmentNames().every((name) => !Object.hasOwn(sanitizedEnv, name)),
    "every Git repository-local environment variable is stripped from scratch hooks",
  );
  ok(
    !Object.hasOwn(sanitizedEnv, "GIT_CONFIG_KEY_0") && !Object.hasOwn(sanitizedEnv, "GIT_CONFIG_VALUE_0"),
    "indexed Git config key/value variables are stripped with GIT_CONFIG_COUNT",
  );
  eq(sanitizedEnv.CLAUDE_PROJECT_DIR, dirIsolated, "scratch hook env preserves the scratch CLAUDE_PROJECT_DIR");
  r = runHook("registry-freshness.mjs", {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "inherited_git_context", query: "CREATE TABLE x (id int);" },
  }, dirIsolated, contaminatedEnv);
  eq(r.status, 0, "inherited Git context does not break scratch hook execution");
  ok(existsSync(flagPathIn(dirIsolated)), "inherited Git context writes only the scratch flag");
  ok(!existsSync(flagPathIn(contaminatedParent)), "inherited Git context does not write a parent-worktree flag");

  // Real Git hook launch: Git itself exports repository-local GIT_* variables
  // to hooks. This is the regression path that synthetic env maps missed.
  const realHookParent = path.join(tmpRoot, "real-hook-parent");
  mkdirSync(realHookParent, { recursive: true });
  git(["init", "-q"], realHookParent);
  const realHookScratch = path.join(tmpRoot, "real-hook-scratch");
  const realHookResultPath = path.join(tmpRoot, "real-hook-result.json");
  const realHookHelper = path.join(tmpRoot, "real-hook-helper.mjs");
  writeFileSync(realHookHelper, `
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const { gitLocalEnvironmentNames, scratchHookEnvironment } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, "git-test-env.mjs")).href)});
const scratchDir = ${JSON.stringify(realHookScratch)};
const parentDir = ${JSON.stringify(realHookParent)};
const registryFreshness = ${JSON.stringify(path.join(__dirname, "registry-freshness.mjs"))};
const resultPath = ${JSON.stringify(realHookResultPath)};
mkdirSync(scratchDir, { recursive: true });

const inheritedNames = gitLocalEnvironmentNames().filter((name) => Object.hasOwn(process.env, name));
const result = spawnSync(process.execPath, [registryFreshness], {
  input: JSON.stringify({
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { project_id: "x", name: "real_git_hook_context", query: "CREATE TABLE real_git_hook_context (id int);" },
  }),
  encoding: "utf8",
  cwd: scratchDir,
  env: scratchHookEnvironment(scratchDir, process.env),
});

const summary = {
  status: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
  inheritedNames,
  scratchFlag: existsSync(path.join(scratchDir, ".claude", "session-state", "REGISTRY-STALE.flag")),
  parentFlag: existsSync(path.join(parentDir, ".claude", "session-state", "REGISTRY-STALE.flag")),
};
writeFileSync(resultPath, JSON.stringify(summary, null, 2));
process.exit(summary.status === 0 && summary.inheritedNames.length > 0 && summary.scratchFlag && !summary.parentFlag ? 0 : 1);
`);
  const hookPath = path.join(realHookParent, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, `#!/bin/sh\nnode "${realHookHelper.replaceAll("\\", "/")}"\n`);
  chmodSync(hookPath, 0o755);
  r = git([
    "-c", "user.email=test@test.com",
    "-c", "user.name=test",
    "commit", "--allow-empty", "-q", "-m", "real hook env isolation",
  ], realHookParent);
  eq(r.status, 0, "real git pre-commit hook can run scratch registry-freshness child");
  const realHookSummary = JSON.parse(readFileSync(realHookResultPath, "utf8"));
  ok(realHookSummary.inheritedNames.length > 0, "real git hook exported repository-local Git env vars");
  ok(realHookSummary.scratchFlag, "real git hook child writes only the scratch flag");
  ok(!realHookSummary.parentFlag, "real git hook child does not write a parent-worktree flag");

  // ── (a) apply_migration with registry-relevant DDL → flag written + context emitted ─
  const dirA = path.join(tmpRoot, "a");
  mkdirSync(dirA, { recursive: true });
  r = runHook("registry-freshness.mjs", {
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

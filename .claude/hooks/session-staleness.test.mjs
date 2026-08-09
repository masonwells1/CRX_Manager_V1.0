#!/usr/bin/env node
// Tests for session-staleness.mjs's schema-registry staleness check (FIX 1 + FIX 2,
// 2026-07-13). Each case gets its own scratch CLAUDE_PROJECT_DIR (schema-registry.json
// + supabase/migrations/) so nothing in the real repo is touched.
// Run: node .claude/hooks/session-staleness.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }
const isolatedGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function runHook(projectDir) {
  return spawnSync(process.execPath, [path.join(__dirname, "session-staleness.mjs")], {
    input: "",
    encoding: "utf8",
    env: { ...isolatedGitEnv, CLAUDE_PROJECT_DIR: projectDir },
  });
}

function additionalContextOf(result) {
  if (!result.stdout.trim()) return "";
  const parsed = JSON.parse(result.stdout);
  return parsed?.hookSpecificOutput?.additionalContext || "";
}

function scaffold(dir, registry, migrationFiles) {
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "schema-registry.json"), JSON.stringify(registry, null, 2));
  for (const [name, sql] of Object.entries(migrationFiles || {})) {
    writeFileSync(path.join(dir, "supabase", "migrations", name), sql);
  }
}

const REGISTRY_RELEVANT_SQL = "CREATE TABLE widgets (id int);";
const NON_RELEVANT_SQL = "-- data-only migration\nUPDATE widgets SET x = 1;";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "session-staleness-test-"));

try {
  // ── FIX 1 (a): applied name present -> NOT flagged, even though the disk
  // stamp is numerically newer than migrations_high_water (the exact bug —
  // an MCP-applied migration got a server version LOWER than its filename) ──
  const dirA = path.join(tmpRoot, "a");
  scaffold(dirA, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: ["20260102000000_new_thing"] },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  let r = runHook(dirA);
  eq(r.status, 0, "FIX1(a): exits 0");
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1(a): applied name present in the list -> NOT flagged as behind");

  // ── FIX 1 (b): applied name ABSENT -> flagged (genuinely unapplied) ──────
  const dirB = path.join(tmpRoot, "b");
  scaffold(dirB, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: ["20260101000000_old_thing"] },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirB);
  ok(additionalContextOf(r).includes("BEHIND"), "FIX1(b): applied name absent -> flagged as behind");
  ok(additionalContextOf(r).includes("20260102000000_new_thing.sql"), "FIX1(b): names the specific missing file");

  // ── FIX 1: name match also accepts the `.sql`-suffixed live name shape ───
  const dirC = path.join(tmpRoot, "c");
  scaffold(dirC, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: ["20260102000000_new_thing.sql"] },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirC);
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1: applied name with .sql suffix still matches");

  // ── FIX 1: schema-neutral migration (no registry-relevant DDL) never flags,
  // even when its name is absent from the applied list ─────────────────────
  const dirD = path.join(tmpRoot, "d");
  scaffold(dirD, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] },
  }, { "20260102000000_data_only.sql": NON_RELEVANT_SQL });
  r = runHook(dirD);
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1: schema-neutral migration not flagged regardless of name-list membership");

  // ── FIX 1: migrations at/under the high-water mark are never candidates,
  // even if genuinely absent from the applied-name list (old pre-existing
  // drift is out of scope — see code comment) ─────────────────────────────
  const dirE = path.join(tmpRoot, "e");
  scaffold(dirE, {
    _meta: { migrations_high_water: "20260103000000", applied_migration_names: [] },
  }, { "20260102000000_old_and_unnamed.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirE);
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1: migration older than high-water is never a candidate, even if absent from the name list");

  // ── FIX 1: no applied_migration_names key at all -> falls back to the
  // original numeric-only compare (pre-FIX-1 registry shape) ──────────────
  const dirF = path.join(tmpRoot, "f");
  scaffold(dirF, {
    _meta: { migrations_high_water: "20260101000000" },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirF);
  ok(additionalContextOf(r).includes("BEHIND"), "FIX1: no applied_migration_names -> numeric fallback still flags a newer-stamped file");
  ok(additionalContextOf(r).includes("Supabase MCP"), "FIX1: numeric-fallback warning carries the new false-positive caveat");

  // ── FIX 2: registry present but unparseable JSON -> loud warning, not silent ──
  const dirG = path.join(tmpRoot, "g");
  mkdirSync(path.join(dirG, ".claude"), { recursive: true });
  mkdirSync(path.join(dirG, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(dirG, ".claude", "schema-registry.json"), "{ not valid json ");
  r = runHook(dirG);
  eq(r.status, 0, "FIX2: unparseable registry still exits 0 (fail-open)");
  const ctxG = additionalContextOf(r);
  ok(ctxG.includes("session-staleness"), "FIX2: warning names the hook");
  ok(ctxG.includes("unreadable/unparseable"), "FIX2: warning text matches the SKIPPED-check pattern");
  ok(ctxG.includes("/regen-schema-registry") || ctxG.includes("regen-schema-registry"), "FIX2: warning points at the fix");

  // ── FIX 3: linked worktrees see the canonical checkout's gitignored backup
  // marker instead of falsely claiming that no backup exists. ──────────────
  const backupRepo = path.join(tmpRoot, "backup-repo");
  scaffold(backupRepo, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] },
  }, {});
  execFileSync("git", ["init", "-b", "main", backupRepo], { env: isolatedGitEnv, stdio: "ignore" });
  execFileSync("git", ["-C", backupRepo, "config", "user.email", "session-staleness@example.com"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", backupRepo, "config", "user.name", "Session Staleness Test"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", backupRepo, "add", ".claude", "supabase"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", backupRepo, "commit", "-m", "fixture"], { env: isolatedGitEnv, stdio: "ignore" });
  mkdirSync(path.join(backupRepo, "backups"), { recursive: true });
  writeFileSync(path.join(backupRepo, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date().toISOString(),
    tables: 1,
    total_rows: 1,
  }));
  const linkedWorktree = path.join(tmpRoot, "backup-linked");
  execFileSync("git", ["-C", backupRepo, "worktree", "add", "--detach", linkedWorktree], { env: isolatedGitEnv, stdio: "ignore" });
  r = runHook(linkedWorktree);
  eq(r.status, 0, "FIX3: linked-worktree backup check exits 0");
  ok(!additionalContextOf(r).includes("No database backup exists yet"), "FIX3: canonical backup marker prevents false missing-backup warning");

  console.log(`session-staleness: ${pass} assertions passed`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

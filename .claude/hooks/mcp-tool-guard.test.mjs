#!/usr/bin/env node
// Tests for mcp-tool-guard.mjs (FIX 1, 2026-07-13 audit — "Desktop Commander
// blind spot"). Spawns the real hook with crafted stdin payloads, the same
// pattern guards.test.mjs / autopilot-lib.test.mjs use for their LIVE checks.
// Run: node .claude/hooks/mcp-tool-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(payload, cwd) {
  return spawnSync(process.execPath, [path.join(__dirname, "mcp-tool-guard.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd || process.env.CLAUDE_PROJECT_DIR },
  });
}
function isDeny(r) { return r.stdout.includes('"permissionDecision":"deny"'); }

// ── tools NOT in the Desktop Commander mutating set pass straight through ──
let r = runHook({ tool_name: "Read", tool_input: { file_path: "src/App.tsx" } });
eq(r.status, 0, "unrelated tool exits 0");
eq(r.stdout.trim(), "", "unrelated tool is silent (passthrough)");

r = runHook({ tool_name: "mcp__Desktop_Commander__list_directory", tool_input: { path: "." } });
eq(r.stdout.trim(), "", "non-mutating DC tool (list_directory) is silent (not matched)");

// ── start_process / interact_with_process: dangerous command denied ───────
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "git push --force origin main" } });
ok(isDeny(r), "DC start_process with a force-push command is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__interact_with_process", tool_input: { pid: 123, input: "rm -rf src\n" } });
ok(isDeny(r), "DC interact_with_process feeding rm -rf src is denied");

r = runHook({
  tool_name: "mcp__Desktop_Commander__start_process",
  tool_input: {
    command: "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  },
});
ok(isDeny(r), "DC start_process cannot route around the exact producer invocation gate");

// ── start_process: benign command allowed (silent) ─────────────────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__start_process", tool_input: { command: "npm run build" } });
eq(r.status, 0, "DC start_process benign command exits 0");
eq(r.stdout.trim(), "", "DC start_process with npm run build is silent (allowed)");

// ── write_file / edit_block / move_file: protected paths denied ────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".env" } });
ok(isDeny(r), "DC write_file targeting .env is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/settings.json" } });
ok(isDeny(r), "DC write_file targeting .claude/settings.json is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__edit_block", tool_input: { path: ".claude/hooks/bash-safety.mjs" } });
ok(isDeny(r), "DC edit_block targeting a hook file is denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { destination: ".env.production" } });
ok(isDeny(r), "DC move_file targeting .env.production is denied");

// ── write_file to an ordinary source file: allowed (silent) ────────────────
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "src/pages/Foo.tsx" } });
eq(r.status, 0, "DC write_file to an ordinary file exits 0");
eq(r.stdout.trim(), "", "DC write_file to an ordinary source file is silent (allowed)");

// ── migration files: ALL MCP writes denied, new or existing (Codex P1 R5) ──
// The SQL/RLS/enum/generated-column/idempotency content guards are wired to
// the native Write/Edit matchers only — an MCP write CREATING a migration
// would skip every one of them, so the guard denies the whole directory.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-tool-guard-migtest-"));
  try {
    const migDir = path.join(tmp, "supabase", "migrations");
    mkdirSync(migDir, { recursive: true });
    writeFileSync(path.join(migDir, "20260101000000_existing.sql"), "select 1;");

    r = runHook(
      { tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "supabase/migrations/20260101000000_existing.sql" } },
      tmp
    );
    ok(isDeny(r), "DC write_file to an EXISTING migration file is denied");

    r = runHook(
      { tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "supabase/migrations/20260102000000_new.sql" } },
      tmp
    );
    ok(isDeny(r), "DC write_file to a NEW migration file is ALSO denied — content guards only run on the native Write path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── kill_process / set_config_value: matched by the tool-name regex but no
//    specific check implemented (documented judgment call) — pass through.
r = runHook({ tool_name: "mcp__Desktop_Commander__kill_process", tool_input: { pid: 123 } });
eq(r.stdout.trim(), "", "kill_process has no path/command check, passes through silently");

// ── fail-open on malformed stdin ────────────────────────────────────────────
r = spawnSync(process.execPath, [path.join(__dirname, "mcp-tool-guard.mjs")], { input: "not json", encoding: "utf8" });
eq(r.status, 0, "malformed stdin still exits 0 (fail-open)");
eq(r.stdout.trim(), "", "malformed stdin produces no block");

// ── Codex P1 2026-07-13: move_file must check the SOURCE path, not just the
//    destination — moving a protected migration AWAY must be denied ──────────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcpguard-move-"));
  try {
    mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(tmp, "supabase", "migrations", "20260101000000_applied.sql"), "select 1;\n");

    r = runHook(
      {
        tool_name: "mcp__Desktop_Commander__move_file",
        tool_input: { source: "supabase/migrations/20260101000000_applied.sql", destination: "archive/gone.sql" },
      },
      tmp
    );
    ok(isDeny(r), "DC move_file with a protected SOURCE (existing migration) is denied");

    r = runHook(
      {
        tool_name: "mcp__Desktop_Commander__move_file",
        tool_input: { source: "docs/a.md", destination: "docs/b.md" },
      },
      tmp
    );
    eq(r.stdout.trim(), "", "DC move_file between unprotected paths is allowed (silent)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Codex P1 2026-07-13 round 2: OTHER MCP servers' same-named tools must be
//    guarded too (settings.json allow-lists mcp__filesystem__write_file) ──────
r = runHook({ tool_name: "mcp__filesystem__write_file", tool_input: { path: ".env" } });
ok(isDeny(r), "filesystem-server write_file to .env is denied (server-agnostic matcher)");
r = runHook({ tool_name: "mcp__filesystem__edit_file", tool_input: { path: ".claude/settings.json" } });
ok(isDeny(r), "filesystem-server edit_file to settings.json is denied");
r = runHook({ tool_name: "mcp__filesystem__write_file", tool_input: { path: "docs/notes.md" } });
eq(r.stdout.trim(), "", "filesystem-server write_file to an unprotected path is allowed (silent)");

// ── Codex P2 2026-07-13 round 2: path traversal must not evade the patterns ──
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: ".claude/sub/../settings.json" } });
ok(isDeny(r), "traversal form .claude/sub/../settings.json is denied (resolved-path check)");
r = runHook({ tool_name: "mcp__Desktop_Commander__write_file", tool_input: { path: "docs/../.env" } });
ok(isDeny(r), "traversal form docs/../.env is denied");

// ── Codex P1 round 3: whole-DIRECTORY moves of protected trees are denied ────
r = runHook({ tool_name: "mcp__filesystem__move_file", tool_input: { source: "supabase/migrations", destination: "old-migrations" } });
ok(isDeny(r), "moving the supabase/migrations DIRECTORY is denied");
r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: ".claude", destination: "claude-backup" } });
ok(isDeny(r), "moving the .claude DIRECTORY is denied");
r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: "supabase", destination: "supabase-old" } });
ok(isDeny(r), "moving the supabase DIRECTORY (parent of migrations) is denied");
r = runHook({ tool_name: "mcp__Desktop_Commander__move_file", tool_input: { source: "docs", destination: "docs-old" } });
eq(r.stdout.trim(), "", "moving an unprotected directory is allowed (silent)");

// ── 2026-09-05 (GitHub Codex P1 on PR #605): Supabase leaves fail CLOSED ──────
// Under Auto mode an unlisted tool reaches the classifier, so an unknown or
// renamed Supabase mutation must be denied by the guard, not left to chance.
r = runHook({ tool_name: "mcp__supabase__future_write_tool", tool_input: {} });
ok(isDeny(r), "unknown Supabase leaf (supabase server) is denied");
r = runHook({ tool_name: "mcp__claude_ai_Supabase__delete_project", tool_input: { project_id: "x" } });
ok(isDeny(r), "unknown Supabase leaf (claude_ai_Supabase server) is denied");
r = runHook({ tool_name: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__future_write_tool", tool_input: {} });
ok(isDeny(r), "unknown Supabase leaf (UUID connector) is denied");
r = runHook({ tool_name: "mcp__Supabase__pause_project", tool_input: { project_id: "x" } });
ok(isDeny(r), "known lifecycle mutation (pause_project) is denied by the guard too");
r = runHook({ tool_name: "mcp__Supabase__list_tables", tool_input: { project_id: "x" } });
eq(r.stdout.trim(), "", "read-only Supabase leaf (list_tables) is silent (allowed)");
r = runHook({ tool_name: "mcp__supabase__Search_Docs", tool_input: { graphql_query: "{}" } });
eq(r.stdout.trim(), "", "read-only leaf matches case-insensitively");
r = runHook({ tool_name: "mcp__supabase__execute_sql", tool_input: { query: "select 1" } });
eq(r.stdout.trim(), "", "execute_sql is left to the live-data guards (silent here)");
r = runHook({ tool_name: "mcp__supabase__apply_migration", tool_input: {} });
eq(r.stdout.trim(), "", "apply_migration is left to migration-apply-guard (silent here)");
r = runHook({ tool_name: "mcp__claude_ai_Supabase__deploy_edge_function", tool_input: {} });
eq(r.stdout.trim(), "", "deploy_edge_function is left to the ask tier (silent here)");
r = runHook({ tool_name: "mcp__github__future_write_tool", tool_input: {} });
eq(r.stdout.trim(), "", "non-Supabase server with an unknown leaf is not matched by the Supabase rule");

// ── 2026-09-05 (GitHub Codex P1, PR #605 head f9bd7e4a0): unregistered UUID ──
// The Supabase connector UUID changes on reinstall. Sensitive leaves on ANY
// UUID-shaped server are denied until that UUID is registered.
const ALT_UUID = "mcp__0f1e2d3c-4b5a-4c6d-8e7f-a0b1c2d3e4f5__";
r = runHook({ tool_name: ALT_UUID + "pause_project", tool_input: { project_id: "x" } });
ok(isDeny(r), "pause_project on an unregistered connector UUID is denied");
r = runHook({ tool_name: ALT_UUID + "deploy_edge_function", tool_input: { name: "send-email" } });
ok(isDeny(r), "deploy_edge_function on an unregistered connector UUID is denied");
r = runHook({ tool_name: ALT_UUID + "apply_migration", tool_input: {} });
ok(isDeny(r), "apply_migration on an unregistered connector UUID is denied");
r = runHook({ tool_name: ALT_UUID + "Execute_SQL", tool_input: { query: "select 1" } });
ok(isDeny(r), "execute_sql on an unregistered connector UUID is denied (case-insensitive)");
r = runHook({ tool_name: ALT_UUID + "list_projects", tool_input: {} });
eq(r.stdout.trim(), "", "Supabase read-only leaf on an unregistered UUID passes through (harmless on any connector)");
r = runHook({ tool_name: ALT_UUID + "get_event", tool_input: { id: "1" } });
eq(r.stdout.trim(), "", "read-shaped leaf (get_) on an unregistered UUID passes through");
r = runHook({ tool_name: ALT_UUID + "search_files", tool_input: { q: "x" } });
eq(r.stdout.trim(), "", "read-shaped leaf (search_) on an unregistered UUID passes through");
// Codex probe 2026-09-05 (PR #605 head c3e2b3fd7): unknown or renamed mutations on a
// reinstalled connector must NOT fall through to the classifier.
r = runHook({ tool_name: ALT_UUID + "delete_project", tool_input: { project_id: "x" } });
ok(isDeny(r), "unknown mutation (delete_project) on an unregistered UUID is denied");
ok(r.stdout.includes("has no exact entry for connector UUID"), "denial names the missing exact settings entry");
r = runHook({ tool_name: ALT_UUID + "future_write_tool", tool_input: {} });
ok(isDeny(r), "never-seen leaf (future_write_tool) on an unregistered UUID is denied");
r = runHook({ tool_name: ALT_UUID + "Create_Event", tool_input: {} });
ok(isDeny(r), "non-read leaf in mixed case on an unregistered UUID is denied");
r = runHook({ tool_name: ALT_UUID + "import-claude-design-from-url", tool_input: {} });
ok(isDeny(r), "hyphenated non-read leaf on an unregistered UUID is denied (regex accepts hyphens)");
// Registration is PER TOOL (Codex P1 on 68c1c32f0): one listed leaf never settles the
// rest of the server. The Vercel UUID has an exact `deploy_to_vercel` entry in
// .claude/settings.json; `unpause_project` has none and is not read-shaped.
const VERCEL_UUID = "mcp__0fb370f6-ff90-41a7-8c20-6f1490a21d59__";
r = runHook({ tool_name: VERCEL_UUID + "deploy_to_vercel", tool_input: {} });
eq(r.stdout.trim(), "", "deploy_to_vercel on the Vercel UUID has an exact settings entry and is left to its ask tier");
r = runHook({ tool_name: VERCEL_UUID + "unpause_project", tool_input: { project_id: "x" } });
ok(isDeny(r), "unpause_project on the Vercel UUID has no exact entry and is denied (per-tool registration)");
r = runHook({ tool_name: VERCEL_UUID + "list_deployments", tool_input: {} });
eq(r.stdout.trim(), "", "read-shaped leaf on the Vercel UUID passes");

// Codex probe on 68c1c32f0: a reinstalled Supabase connector with ONLY list_projects
// registered must still have its mutations denied. Fixture settings via CLAUDE_PROJECT_DIR.
function withProjectSettings(entries, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-tool-guard-registry-"));
  try {
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: entries }));
    fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const PARTIAL_UUID = "mcp__7a7a7a7a-1111-4222-8333-444444444444__";
withProjectSettings({ allow: [PARTIAL_UUID + "list_projects"] }, (dir) => {
  r = runHook({ tool_name: PARTIAL_UUID + "list_projects", tool_input: {} }, dir);
  eq(r.stdout.trim(), "", "the one exactly registered leaf passes");
  r = runHook({ tool_name: PARTIAL_UUID + "delete_project", tool_input: {} }, dir);
  ok(isDeny(r), "delete_project on a partially registered UUID is still denied");
  r = runHook({ tool_name: PARTIAL_UUID + "future_write_tool", tool_input: {} }, dir);
  ok(isDeny(r), "future_write_tool on a partially registered UUID is still denied");
  r = runHook({ tool_name: PARTIAL_UUID + "deploy_edge_function", tool_input: {} }, dir);
  ok(isDeny(r), "deploy_edge_function on a partially registered UUID is still denied");
  ok(r.stdout.includes("Supabase live-action leaf"), "denial names the Supabase live-action leaf");
});
// A UUID whose settings entry names a leaf only Supabase has (list_tables) IS the Supabase
// connector: the complete Supabase policy applies to every tool on it.
const SB_UUID = "mcp__8b8b8b8b-1111-4222-8333-444444444444__";
withProjectSettings({ allow: [SB_UUID + "list_tables"] }, (dir) => {
  r = runHook({ tool_name: SB_UUID + "list_projects", tool_input: {} }, dir);
  eq(r.stdout.trim(), "", "identified Supabase UUID: read-only allowlist leaf passes");
  r = runHook({ tool_name: SB_UUID + "execute_sql", tool_input: { query: "select 1" } }, dir);
  eq(r.stdout.trim(), "", "identified Supabase UUID: execute_sql is left to the live-db guards");
  r = runHook({ tool_name: SB_UUID + "get_event", tool_input: {} }, dir);
  ok(isDeny(r), "identified Supabase UUID: a read-shaped leaf NOT on the allowlist is denied (complete policy)");
  ok(r.stdout.includes("identified as the Supabase connector"), "denial explains the identification");
  r = runHook({ tool_name: SB_UUID + "delete_project", tool_input: {} }, dir);
  ok(isDeny(r), "identified Supabase UUID: unknown mutation denied");
  r = runHook({ tool_name: SB_UUID + "pause_project", tool_input: {} }, dir);
  ok(isDeny(r), "identified Supabase UUID: lifecycle leaf denied");
});
// Kebab-case leaves on the NAMED Supabase servers hit the same fail-closed branch
// (Codex P1 on 68c1c32f0).
r = runHook({ tool_name: "mcp__supabase__future-write-tool", tool_input: {} });
ok(isDeny(r), "hyphenated unknown leaf on mcp__supabase__ is denied");
r = runHook({ tool_name: "mcp__claude_ai_Supabase__delete-project", tool_input: {} });
ok(isDeny(r), "hyphenated unknown leaf on mcp__claude_ai_Supabase__ is denied");
r = runHook({ tool_name: "mcp__Supabase__pause-project", tool_input: {} });
ok(isDeny(r), "hyphenated lifecycle leaf on mcp__Supabase__ is denied");
r = runHook({ tool_name: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__deploy_edge_function", tool_input: {} });
eq(r.stdout.trim(), "", "deploy_edge_function on the REGISTERED UUID is still left to the ask tier");

console.log(`mcp-tool-guard: ${pass} assertions passed`);

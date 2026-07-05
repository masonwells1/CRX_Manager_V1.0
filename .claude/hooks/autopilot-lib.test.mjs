#!/usr/bin/env node
// Tests for the overnight autopilot decision + flag logic, plus a live check that
// the hook is INERT when the flag is absent (off by default).
// Run: node .claude/hooks/autopilot-lib.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { autopilotDecision, flagActive, intentFresh, overnightGateDecision } from "./autopilot-lib.mjs";

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }
function eq(a, b, msg) { assert.equal(a, b, msg); pass++; }

// ── deny-set: prod-touching + destructive must NEVER be auto-approved ─────
eq(autopilotDecision("mcp__supabase__apply_migration", { query: "..." }), "deny", "apply_migration denied");
eq(autopilotDecision("mcp__supabase__deploy_edge_function", {}), "deny", "deploy_edge_function denied");
eq(autopilotDecision("mcp__x__deploy_to_vercel", {}), "deny", "deploy_to_vercel denied");
eq(autopilotDecision("Bash", { command: "git push origin main" }), "deny", "git push denied");
eq(autopilotDecision("Bash", { command: "git push --force" }), "deny", "force push denied");
eq(autopilotDecision("Bash", { command: "git reset --hard HEAD~1" }), "deny", "hard reset denied");
eq(autopilotDecision("Bash", { command: "rm -rf build" }), "deny", "rm -rf denied");
eq(autopilotDecision("Bash", { command: "npm run test -- --no-verify" }), "deny", "--no-verify denied");
eq(autopilotDecision("Bash", { command: "npx supabase db reset" }), "deny", "supabase db reset denied");
eq(autopilotDecision("Bash", { command: "git worktree remove ../x" }), "deny", "worktree remove denied");
eq(autopilotDecision("Bash", { command: "echo SECRET >> .env" }), "deny", "write to .env denied");
eq(autopilotDecision("Write", { file_path: "C:/CRX_Manager/.env.local" }), "deny", "Write .env.local denied");
eq(autopilotDecision("Edit", { file_path: ".env" }), "deny", "Edit .env denied");

// ── deny-set additions (2026-07-04): CLI deploy, PR merge, MCP write/exec ─
eq(autopilotDecision("Bash", { command: "npx supabase functions deploy send-email" }), "deny", "CLI edge deploy denied");
eq(autopilotDecision("Bash", { command: "supabase functions deploy process-document" }), "deny", "bare CLI edge deploy denied");
eq(autopilotDecision("Bash", { command: "gh pr merge 42 --squash" }), "deny", "gh pr merge denied");
eq(autopilotDecision("mcp__github__push_files", {}), "deny", "GitHub MCP push_files denied");
eq(autopilotDecision("mcp__github__merge_pull_request", {}), "deny", "GitHub MCP merge PR denied");
eq(autopilotDecision("mcp__github__create_or_update_file", {}), "deny", "GitHub MCP file write denied");
eq(autopilotDecision("mcp__Desktop_Commander__start_process", {}), "deny", "Desktop Commander exec denied");
eq(autopilotDecision("mcp__Desktop_Commander__write_file", {}), "deny", "Desktop Commander write denied");

// ── overnight-arm handshake ──────────────────────────────────────────────
ok(intentFresh(JSON.stringify({ created: new Date().toISOString() })), "fresh intent recognized");
ok(!intentFresh(JSON.stringify({ created: new Date(Date.now() - 2 * 3600e3).toISOString() })), "stale intent ignored");
ok(!intentFresh("not json"), "malformed intent ignored");
eq(overnightGateDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "deny-until-armed", "edit blocked until armed");
eq(overnightGateDecision("Bash", { command: "git add -A && git commit -m x" }), "deny-until-armed", "commit blocked until armed");
eq(overnightGateDecision("mcp__supabase__execute_sql", { query: "SELECT 1" }), "deny-until-armed", "sql blocked until armed");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8" }), "allow-through", "arm command passes");
eq(overnightGateDecision("Bash", { command: "rm .claude/session-state/OVERNIGHT-INTENT.flag" }), "allow-through", "clearing intent flag passes");
eq(overnightGateDecision("Bash", { command: "git status" }), "allow-through", "git status passes");
// Codex 2026-07-05 P2: read-only leading token + write redirect must NOT pass
eq(overnightGateDecision("Bash", { command: "cat src/a.ts > src/b.ts" }), "deny-until-armed", "cat with redirect blocked until armed");
eq(overnightGateDecision("Bash", { command: "echo x >> supabase/migrations/x.sql" }), "deny-until-armed", "echo append blocked until armed");
eq(overnightGateDecision("Bash", { command: "git log | tee notes.txt" }), "deny-until-armed", "tee blocked until armed");
eq(overnightGateDecision("Read", { file_path: "x" }), "allow-through", "read passes");
eq(overnightGateDecision("Write", { file_path: ".claude/session-state/notes.md" }), "allow-through", "session-state write passes");

// ── allow-set: ordinary loop actions are auto-approved ───────────────────
eq(autopilotDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "allow", "normal edit allowed");
eq(autopilotDecision("Write", { file_path: "supabase/migrations/x.sql" }), "allow", "write migration file allowed (apply is separately denied)");
eq(autopilotDecision("Bash", { command: "npm run build" }), "allow", "npm build allowed");
eq(autopilotDecision("Bash", { command: "git add -A && git commit -m x" }), "allow", "commit allowed");
eq(autopilotDecision("Bash", { command: "node scripts/foo.mjs" }), "allow", "node script allowed");
eq(autopilotDecision("mcp__supabase__execute_sql", { query: "SELECT 1" }), "allow", "read sql allowed");
eq(autopilotDecision("Read", { file_path: "anything" }), "allow", "read allowed");

// ── flag expiry (fail-safe) ──────────────────────────────────────────────
const future = new Date(Date.now() + 3600e3).toISOString();
const pastT = new Date(Date.now() - 3600e3).toISOString();
ok(flagActive(JSON.stringify({ expires: future })).active === true, "unexpired flag active");
ok(flagActive(JSON.stringify({ expires: pastT })).active === false, "expired flag inactive");
ok(flagActive("not json").active === false, "malformed flag inactive");
ok(flagActive(JSON.stringify({ armed_at: "x" })).active === false, "no-expiry flag inactive");
ok(flagActive("").active === false, "empty flag inactive");

// ── LIVE: hook is inert (emits nothing) when the flag is absent ──────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "unattended-autopilot.mjs");
const r = spawnSync(process.execPath, [hookPath], {
  input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
  encoding: "utf8",
});
eq(r.status, 0, "hook exits 0");
eq(r.stdout.trim(), "", "hook emits NOTHING when flag absent (off by default — defers to normal flow)");

console.log(`autopilot-lib: ${pass} assertions passed`);

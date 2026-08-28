#!/usr/bin/env node
// Tests for the overnight autopilot decision + flag logic, plus a live check that
// the hook is INERT when the flag is absent (off by default).
// Run: node .claude/hooks/autopilot-lib.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { autopilotDecision, flagActive, intentFresh, overnightGateDecision } from "./autopilot-lib.mjs";

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }
function eq(a, b, msg) { assert.equal(a, b, msg); pass++; }

// ── SQL/migration: Mason-authorized to auto-run unattended (2026-07-10) ────
// apply_migration + execute_sql are intentionally NOT denied — Mason owns this live
// DB and does not want them to gate. The migration-apply-guard hook (reviewer proof)
// remains the real backstop for migrations.
eq(autopilotDecision("mcp__supabase__apply_migration", { query: "..." }), "allow", "apply_migration allowed (Mason 2026-07-10)");
eq(autopilotDecision("mcp__supabase__execute_sql", { query: "..." }), "allow", "execute_sql allowed (Mason 2026-07-10)");

// ── deny-set: prod-touching + destructive must NEVER be auto-approved ─────
eq(autopilotDecision("mcp__supabase__deploy_edge_function", {}), "deny", "deploy_edge_function denied");
eq(autopilotDecision("mcp__x__deploy_to_vercel", {}), "deny", "deploy_to_vercel denied");
eq(autopilotDecision("Bash", { command: "git push -u origin codex/routine-work" }), "allow", "ordinary feature push reaches the normal push guard");
eq(autopilotDecision("Bash", { command: "git push --force" }), "deny", "force push denied");
eq(autopilotDecision("Bash", { command: "git push origin codex/routine-work --force-with-lease" }), "deny", "trailing force-with-lease denied");
eq(autopilotDecision("Bash", { command: "git push -fu origin codex/routine-work" }), "deny", "combined short force flag denied");
eq(autopilotDecision("Bash", { command: "git push origin +codex/routine-work:codex/routine-work" }), "deny", "forced refspec denied");
eq(autopilotDecision("PowerShell", { command: "git push origin --delete feature/shared" }), "deny", "remote branch deletion denied");
eq(autopilotDecision("PowerShell", { command: "git push origin :feature/shared" }), "deny", "deletion refspec denied");
eq(autopilotDecision("Bash", { command: "git reset --hard HEAD~1" }), "deny", "hard reset denied");
eq(autopilotDecision("Bash", { command: "rm -rf build" }), "deny", "rm -rf denied");
eq(autopilotDecision("Bash", { command: "npm run test -- --no-verify" }), "deny", "--no-verify denied");
eq(autopilotDecision("Bash", { command: "npx supabase db reset" }), "deny", "supabase db reset denied");
eq(autopilotDecision("Bash", { command: "git worktree remove ../x" }), "deny", "worktree remove denied");
eq(autopilotDecision("Bash", { command: "echo SECRET >> .env" }), "deny", "write to .env denied");
eq(autopilotDecision("Write", { file_path: "C:/CRX_Manager/.env.local" }), "deny", "Write .env.local denied");
eq(autopilotDecision("Edit", { file_path: ".env" }), "deny", "Edit .env denied");

// ── deny-set additions (2026-07-04): CLI deploy and direct remote writes ───
eq(autopilotDecision("Bash", { command: "npx supabase functions deploy send-email" }), "deny", "CLI edge deploy denied");
eq(autopilotDecision("Bash", { command: "supabase functions deploy process-document" }), "deny", "bare CLI edge deploy denied");
eq(autopilotDecision("Bash", { command: "gh pr merge 42 --squash" }), "allow", "protected PR merge reaches the normal merge guard");
eq(autopilotDecision("PowerShell", { command: "&gh pr merge 42 --squash --auto" }), "allow", "PowerShell call-operator merge reaches the normal merge guard");
eq(autopilotDecision("PowerShell", { command: "gh pr m''erge 42 --auto" }), "deny", "empty-quote composed merge is never auto-approved");
eq(autopilotDecision("PowerShell", { command: "g''h pr merge 42 --auto" }), "deny", "empty-quote composed gh executable is never auto-approved");
eq(autopilotDecision("PowerShell", { command: "gh pr merge 42 --squash # --repo attacker/safe --match-head-commit deadbeef" }), "deny", "comment-forged merge context is never auto-approved");
eq(autopilotDecision("Bash", { command: "gh pr merge 42 --squash", env: { GH_HOST: "attacker.example" } }), "deny", "structured GitHub host overrides are never auto-approved");
eq(autopilotDecision("PowerShell", { command: "g`h pr merge 42 --auto" }), "deny", "PowerShell-composed gh is never auto-approved");
eq(autopilotDecision("Bash", { command: "g${EMPTY}h pr merge 42 --auto" }), "deny", "POSIX-composed gh is never auto-approved");
eq(autopilotDecision("Bash", { command: "(gh pr merge 42 --auto)" }), "deny", "parenthesized gh merges are never auto-approved");
eq(autopilotDecision("Bash", { command: "gh p\\r m\\erge 42 --auto" }), "deny", "POSIX-escaped GitHub words are never auto-approved");
eq(autopilotDecision("PowerShell", { command: "gh p^r m^erge 42 --auto" }), "deny", "cmd-caret-composed GitHub words are never auto-approved");
eq(autopilotDecision("Bash", { command: "gh a\\pi graphql --input payload.json" }), "deny", "POSIX-escaped GitHub API is never auto-approved");
eq(autopilotDecision("PowerShell", { command: 'powershell -Command "gh pr merge 42 --admin"' }), "deny", "nested PowerShell merge is never auto-approved");
eq(autopilotDecision("PowerShell", { command: 'cmd /c "gh pr merge 42 --admin"' }), "deny", "nested cmd merge is never auto-approved");
eq(autopilotDecision("Bash", { command: "bash -c 'gh api graphql --input payload.json'" }), "deny", "nested Bash GitHub API call is never auto-approved");
eq(autopilotDecision("Bash", { command: "$verb='merge'; gh pr $verb 42 --auto" }), "deny", "dynamic GitHub merge is never auto-approved");
eq(autopilotDecision("mcp__github__push_files", {}), "deny", "GitHub MCP push_files denied");
eq(autopilotDecision("mcp__github__merge_pull_request", {}), "allow", "GitHub MCP merge PR reaches the normal merge guard");
eq(autopilotDecision("mcp__github__create_or_update_file", {}), "deny", "GitHub MCP file write denied");
eq(autopilotDecision("mcp__Desktop_Commander__start_process", {}), "deny", "Desktop Commander exec denied");
eq(autopilotDecision("mcp__Desktop_Commander__write_file", {}), "deny", "Desktop Commander write denied");

// ── overnight-arm handshake ──────────────────────────────────────────────
ok(intentFresh(JSON.stringify({ created: new Date().toISOString() })), "fresh intent recognized");
ok(!intentFresh(JSON.stringify({ created: new Date(Date.now() - 2 * 3600e3).toISOString() })), "stale intent ignored");
ok(!intentFresh("not json"), "malformed intent ignored");
eq(overnightGateDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "deny-until-armed", "edit blocked until armed");
eq(overnightGateDecision("Bash", { command: "git add -A && git commit -m x" }), "deny-until-armed", "commit blocked until armed");
eq(overnightGateDecision("mcp__supabase__execute_sql", { query: "SELECT 1" }), "allow-through", "sql passes even before arm (Mason 2026-07-10)");
eq(overnightGateDecision("mcp__x__deploy_edge_function", {}), "deny-until-armed", "deploy still blocked until armed");
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

// ── LIVE: the hook's arming decision must depend ONLY on the flag in its OWN
// project dir, never on whatever AUTOPILOT.on happens to be armed in the ambient
// session. The hook reads $CLAUDE_PROJECT_DIR/.claude/session-state/AUTOPILOT.on,
// so earlier versions of this test failed whenever real autopilot was armed while
// it ran (the spawned hook saw the ambient flag and denied). We now point
// CLAUDE_PROJECT_DIR at throwaway temp dirs — one without a flag, one with a fresh
// active flag — so both directions are proven deterministically regardless of
// whether real autopilot is armed. (This is why commits used to fail while armed.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(__dirname, "unattended-autopilot.mjs");
const resolvedTempRoot = `${path.resolve(tmpdir())}${path.sep}`;

function safeTempDir(testDir) {
  const resolvedTestDir = path.resolve(testDir);
  if (!resolvedTestDir.startsWith(resolvedTempRoot)) {
    throw new Error(`Refusing to use non-temp test directory: ${resolvedTestDir}`);
  }
  return resolvedTestDir;
}

function runHook(projectDir) {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

// (1) flag ABSENT → hook is inert (emits nothing, defers to normal flow).
const noFlagDir = mkdtempSync(path.join(tmpdir(), "autopilot-noflag-"));
const resolvedNoFlagDir = safeTempDir(noFlagDir);
try {
  const r = runHook(noFlagDir);
  eq(r.status, 0, "hook exits 0 when flag absent");
  eq(r.stdout.trim(), "", "hook emits NOTHING when flag absent (off by default — defers to normal flow)");
} finally {
  rmSync(resolvedNoFlagDir, { recursive: true, force: true });
}

// (2) flag PRESENT + active → hook DENIES a deny-set command (rm -rf /). This is
// the counterpart proof: the same isolation lets us assert the armed behavior too.
const armedDir = mkdtempSync(path.join(tmpdir(), "autopilot-armed-"));
const resolvedArmedDir = safeTempDir(armedDir);
try {
  const armedStateDir = path.join(armedDir, ".claude", "session-state");
  mkdirSync(armedStateDir, { recursive: true });
  writeFileSync(
    path.join(armedStateDir, "AUTOPILOT.on"),
    JSON.stringify({ expires: new Date(Date.now() + 3600e3).toISOString() })
  );
  const r = runHook(armedDir);
  eq(r.status, 0, "hook exits 0 when armed");
  ok(/"permissionDecision":\s*"deny"/.test(r.stdout), "hook DENIES a deny-set command (rm -rf /) when armed");
} finally {
  rmSync(resolvedArmedDir, { recursive: true, force: true });
}

console.log(`autopilot-lib: ${pass} assertions passed`);

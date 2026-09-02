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
eq(overnightGateDecision("mcp__supabase__execute_sql", { query: "SELECT 1" }), "allow-through", "sql passes even before arm (Mason 2026-07-10)");
eq(overnightGateDecision("mcp__x__deploy_edge_function", {}), "deny-until-armed", "deploy still blocked until armed");
eq(overnightGateDecision("Bash", { command: "node .claude/hooks/autopilot-arm.mjs --hours 8" }), "allow-through", "arm command passes");
// The `rm` form is NOT the escape hatch and must not be advertised as one: this
// gate is only one of seven PreToolUse hooks, and review-proof-guard (matcher "*")
// refuses it outright. This assertion used to say "allow-through" and passed for
// months while the real stack denied the command — false assurance of exactly the
// class this project calls a silently-no-op mutation test. The end-to-end proof
// that the sanctioned command survives EVERY registered hook lives in
// overnight-intent-clear.test.mjs; keep that one honest, not this one.
eq(overnightGateDecision("Bash", { command: "rm .claude/session-state/OVERNIGHT-INTENT.flag" }), "deny-until-armed", "rm form is NOT the escape hatch (review-proof-guard denies it downstream)");
eq(overnightGateDecision("Bash", { command: "node scripts/clear-overnight-intent.mjs --not-a-hands-free-run" }), "allow-through", "sanctioned clear script passes");
eq(overnightGateDecision("Bash", { command: "node scripts/clear-overnight-intent.mjs" }), "allow-through", "clear script without the flag still reaches the script (which then refuses)");
// Anchored, so the allowance cannot ride as a prefix/suffix on a chained command.
eq(overnightGateDecision("Bash", { command: "node scripts/clear-overnight-intent.mjs && npm run build" }), "deny-until-armed", "chained build after the clear script is still gated");
eq(overnightGateDecision("Bash", { command: "npm run build && node scripts/clear-overnight-intent.mjs" }), "deny-until-armed", "clear script as a suffix does not unlock the prefix");
eq(overnightGateDecision("Bash", { command: "echo clear-overnight-intent.mjs > x.txt" }), "deny-until-armed", "merely naming the script does not unlock");
eq(overnightGateDecision("Bash", { command: "node scripts/clear-overnight-intent.mjs --hours 9" }), "deny-until-armed", "unknown argument is not covered by the allowance");
// Codex (gpt-5.6-sol, exact-SHA review 2026-09-01) proved the first draft — an
// anchored regex over the command SHAPE — was a HIGH bypass: it validated only the
// two BASENAMES, so any attacker-controlled file with that name, run by any
// interpreter, executed arbitrary JS during the very pause the latch enforces.
// The allowance is now an exact-string Set. These are the proven exploits.
eq(overnightGateDecision("Bash", { command: "node attacker/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "PROVEN BYPASS: alternate directory must not ride the basename");
eq(overnightGateDecision("Bash", { command: '"C:\\attacker\\node.exe" "C:\\attacker\\clear-overnight-intent.mjs" --not-a-hands-free-run' }), "deny-until-armed", "PROVEN BYPASS: alternate interpreter + absolute script path");
eq(overnightGateDecision("Bash", { command: "node ../clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "traversal out of the repo is not the sanctioned script");
eq(overnightGateDecision("Bash", { command: "node scripts/../scripts/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "a traversal-normalized spelling is still not the literal command");
eq(overnightGateDecision("Bash", { command: "node //server/share/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "UNC path is not the sanctioned script");
eq(overnightGateDecision("Bash", { command: "node scripts/*/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "a glob is not the sanctioned script");
eq(overnightGateDecision("Bash", { command: "node $DIR/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "an expansion is not the sanctioned script");
eq(overnightGateDecision("Bash", { command: 'node "scripts/clear-overnight-intent.mjs" --not-a-hands-free-run' }), "deny-until-armed", "a quoting variant is not the literal command");
eq(overnightGateDecision("Bash", { command: "NODE_OPTIONS=--require=./evil.js node scripts/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "an env prefix that injects a module is not the literal command");
eq(overnightGateDecision("Bash", { command: "node  scripts/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "extra internal whitespace is not the literal command");
eq(overnightGateDecision("Bash", { command: "NODE scripts/clear-overnight-intent.mjs --not-a-hands-free-run" }), "deny-until-armed", "the allowance is case-sensitive by design");
// Leading/trailing whitespace only is trimmed — that is the one normalization.
eq(overnightGateDecision("Bash", { command: "  node scripts/clear-overnight-intent.mjs --not-a-hands-free-run  " }), "allow-through", "surrounding whitespace is trimmed");
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

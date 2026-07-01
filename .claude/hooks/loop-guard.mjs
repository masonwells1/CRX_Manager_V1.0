#!/usr/bin/env node
// loop-guard.mjs — DETERMINISTIC hard guard for the autonomous debug/bug-hunt loop.
//
// Registered ONLY in the CRX_MainDebug worktree's `.claude/settings.local.json`, so it
// scopes to C:\CRX_MainDebug and never touches Mason's normal sessions (where push /
// live-SQL are intentionally allowed). It turns the loop's PROSE gates into LOCKED
// DOORS — a misbehaving or prompt-injected loop session physically cannot:
//
//   1. push           — ANY git push (incl. `git.exe push`, `git -c k=v push`) is blocked;
//                       so are gh/MCP remote-write ops (merge/create/update/delete/push/fork).
//   2. commit off-branch — `git commit` is blocked unless HEAD is the debug branch.
//   3. apply a migration / deploy — apply_migration / deploy_* tools are blocked (PARKED).
//   4. write the live DB — execute_sql with write DDL/DML is blocked; read-only SELECT
//                       and a strict BEGIN…ROLLBACK validation are allowed.
//
// LIMITATION (honest): the SQL/command checks are LEXICAL (regex), not a parsed AST, so a
// determined evasion (odd aliases, comment tricks) is theoretically possible. This guard is
// defense-in-depth; the loop is read-only BY DESIGN and the hunter only emits text. Everything
// else (reads, tests, builds, file edits, branch-correct commits) is allowed.
//
// Contract matches the other CRX PreToolUse hooks: read tool-call JSON on fd 0, emit
// {hookSpecificOutput:{hookEventName,permissionDecision,permissionDecisionReason}}.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LOOP_BRANCH = "claude/main-debug-hunt";

function out(decision, reason) {
  const payload =
    decision === "deny"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
      : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let p;
try {
  p = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const tool = p?.tool_name || "";
const input = p?.tool_input || {};

// Self-gate: only ENFORCE inside the dedicated CRX_MainDebug worktree. This makes the
// guard safe to register durably (even in the committed project settings.json) — it is
// INERT (allow-all) in any other folder, including main / Mason's normal sessions.
let __top = "";
try {
  __top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch { __top = ""; }
if (__top.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() !== "c:/crx_maindebug") {
  out("allow");
}

// ---- MCP / tool-name guards ----------------------------------------------------
if (/(?:^|__)apply_migration$/.test(tool)) {
  out("deny", "loop-guard: apply_migration is blocked. Live migrations are PARKED for Mason's explicit OK — the loop never applies them.");
}
if (/(?:^|__)deploy/.test(tool)) {
  out("deny", "loop-guard: deploys are blocked. Edge-function / Vercel deploys are PARKED for Mason — the loop never deploys.");
}
// Remote-WRITE tools (GitHub etc. via MCP): the loop only edits LOCAL files + commits to its
// branch; it never writes through a remote API. Block write verbs; read verbs (get_/list_/search_) pass.
if (/(?:^|__)(?:create|update|delete|merge|push|fork|add)_[a-z0-9_]*$/i.test(tool)) {
  out("deny", `loop-guard: remote write tool '${tool}' is blocked. The loop only edits local files and commits to the debug branch.`);
}
if (/execute_sql$/.test(tool)) {
  const q = String(input.query ?? input.sql ?? "");
  const hasWrite = /\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|reindex|vacuum|refresh\s+materialized|comment\s+on|call|do)\b/i.test(q);
  // Allow ONLY: pure reads, or a strict BEGIN…ROLLBACK validation with no COMMIT.
  const rollbackWrapped = /\bbegin\b/i.test(q) && /\brollback\b/i.test(q) && !/\bcommit\b/i.test(q);
  if (hasWrite && !rollbackWrapped) {
    out("deny", "loop-guard: live-DB writes are blocked. Use a read-only SELECT to verify, or a strict BEGIN…ROLLBACK validation (no COMMIT). Real migrations are PARKED for Mason.");
  }
  out("allow");
}

// ---- Bash guards ---------------------------------------------------------------
if (tool === "Bash") {
  const cmd = String(input.command ?? "");
  // Any git push — `git push`, `git.exe push`, `git -c k=v push`, `... && git push ...`.
  if (/\bgit(?:\.exe)?\b[^\n]*\bpush\b/i.test(cmd)) {
    out("deny", "loop-guard: the loop never pushes. Green fixes remain LOCAL commits on the debug branch; Mason merges the ones he wants.");
  }
  // gh CLI write ops (merge/create/delete/edit/close/push a PR/release/repo).
  if (/\bgh\b[^\n]*\b(?:merge|create|delete|close|edit|push)\b/i.test(cmd)) {
    out("deny", "loop-guard: gh write operations are blocked. The loop never merges/creates/deletes/pushes via gh.");
  }
  // Any git commit — must be on the debug branch.
  if (/\bgit(?:\.exe)?\b[^\n]*\bcommit\b/i.test(cmd)) {
    let branch = "";
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      branch = "";
    }
    if (branch && branch !== LOOP_BRANCH) {
      out("deny", `loop-guard: refusing to commit on '${branch}'. The loop commits ONLY on '${LOOP_BRANCH}'.`);
    }
  }
}

out("allow");

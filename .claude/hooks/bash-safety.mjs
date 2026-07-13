#!/usr/bin/env node
// Bash safety guard for CRX Manager.
// Deterministic replacement for the prompt-hook version that overreached.
//
// Behavior:
//   - Block known dangerous patterns (force push, hard reset, --no-verify, rm -rf src, etc.)
//   - Block MODIFY of EXISTING files in supabase/migrations/ ONLY when target exists
//     (creating new files is allowed)
//   - Do NOT block writes to docs/
//   - Also check `npm run <script>`'s RESOLVED script body from package.json
//     (recursing into scripts it calls, max depth 3) against the same patterns —
//     otherwise a dangerous command hidden behind an innocuous-looking npm script
//     name sails straight through (2026-07-13 audit finding, FIX 2).
//
// The dangerous-command pattern table lives in bash-safety-lib.mjs, SHARED with
// mcp-tool-guard.mjs (Desktop Commander start_process/interact_with_process runs
// the exact same shell commands and used to skip every one of these checks).

import { readFileSync } from "node:fs";
import { checkCommandDeep, checkMigrationModify } from "./bash-safety-lib.mjs";

function out(decision, reason) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const cmd = payload?.tool_input?.command || "";
if (!cmd) out("allow");

const cwd = process.cwd();

try {
  const reason = checkCommandDeep(cmd, cwd);
  if (reason) out("block", reason);

  const migReason = checkMigrationModify(cmd, cwd);
  if (migReason) out("block", migReason);
} catch (err) {
  // FAIL-OPEN, but loud: a broken hook must never brick the session.
  process.stderr.write(`bash-safety.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  out("allow");
}

out("allow");

#!/usr/bin/env node
// PreToolUse guard for Supabase MCP `apply_migration` calls.
// Refuses to let Claude apply a migration to live unless proof exists that the
// review subagents (rls-security-reviewer + migration-drift-reviewer) have run
// THIS SESSION on that specific migration and returned clean.
//
// Proof = a file at .claude/session-state/migration-review-<safe-name>.json
// with structure:
//   { "migration": "<filename or migration name>",
//     "timestamp": "<ISO-8601>",
//     "reviewers": ["rls-security-reviewer", "migration-drift-reviewer"],
//     "findings": "clean" | "blockers-fixed" }
//
// The file is written by Claude after subagents return clean. Without it, this
// hook blocks the apply_migration call with explicit instructions.
//
// Setup matcher: in .claude/settings.json this hook is registered against matcher
// "mcp__.*" (narrowed 2026-08-18); .codex/hooks.json still registers it under "*".
// Either way it filters in-script for tool names containing "apply_migration".
//
// THE RULES THEMSELVES LIVE IN ./migration-apply-lib.mjs (2026-08-24). This file
// is now only the transport: read the PreToolUse payload, ask the shared rule
// book for a verdict, emit it. scripts/apply-migration-file.mjs asks the SAME
// rule book, which is how an oversized migration — one that cannot be re-emitted
// byte-exact through this tool's pasted `query` parameter — reaches live without
// any gate being skipped or duplicated. Do not reintroduce check logic here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluateMigrationApply } from "./migration-apply-lib.mjs";

function deny(reason) {
  const payload = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const toolName = (payload?.tool_name || "").toLowerCase();
// Only decide migration calls. An explicit allow on an unrelated MCP call
// overrides its normal permission check; silence delegates to that check.
if (!toolName.includes("apply_migration")) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Extract the migration identifier from the MCP call. Supabase MCP apply_migration
// shape is { project_id, name, query }. We use `name` if present, otherwise fall
// back to the first matching migration file from the SQL query content.
const input = payload?.tool_input || {};

let verdict;
try {
  verdict = evaluateMigrationApply({
    name: input.name,
    query: input.query,
    projectId: input.project_id,
    projectDir,
    cwd: payload?.cwd || input.cwd || process.cwd(),
  });
} catch (err) {
  // A crash in the rule book must not wave a live migration through.
  deny(
    `MIGRATION APPLY GUARD: the apply-gate evaluation itself failed ` +
    `(${err?.message || err}). Refusing the apply rather than proceeding with the gate in an ` +
    `unknown state. Fix ${path.join(".claude", "hooks", "migration-apply-lib.mjs")} — do not route ` +
    `around this by applying through another channel.`);
}

// Allow ONLY on an explicit "allow". Testing for `=== "block"` and allowing
// everything else would let a missing, undefined, or unrecognised decision
// permit a live apply — the exact inversion of this file's own rule that an
// unknown gate state must refuse (CodeRabbit, PR #460).
if (verdict?.decision !== "allow") {
  deny(verdict?.reason ||
    `MIGRATION APPLY GUARD: the apply gate returned no recognisable decision ` +
    `(${JSON.stringify(verdict?.decision ?? null)}). An unknown verdict is not a pass. Refusing the apply.`);
}
// Technical proof is necessary, but does not grant owner permission. Leave a
// successful evaluation silent so the tool's ask/deny tier still applies.
process.exit(0);

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

const toolName = (payload?.tool_name || "").toLowerCase();
// Only act on apply_migration tool calls; allow everything else instantly.
if (!toolName.includes("apply_migration")) out("allow");

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
  out("block",
    `MIGRATION APPLY GUARD: the apply-gate evaluation itself failed ` +
    `(${err?.message || err}). Refusing the apply rather than proceeding with the gate in an ` +
    `unknown state. Fix ${path.join(".claude", "hooks", "migration-apply-lib.mjs")} — do not route ` +
    `around this by applying through another channel.`);
}

if (verdict?.decision === "block") out("block", verdict.reason);
out("allow");

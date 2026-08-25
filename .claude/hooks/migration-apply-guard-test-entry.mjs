#!/usr/bin/env node
// Test-only transport for fixture-backed migration-guard regression cases.
// Production hook manifests invoke migration-apply-guard.mjs, whose evaluator
// performs fixed linked reads in memory. No argument or environment switch on
// either production entrypoint can select this cached-evidence evaluator.

import { readFileSync } from "node:fs";
import {
  evaluateMigrationApplyWithCachedTestEvidence,
} from "./migration-apply-lib.mjs";

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
if (!toolName.includes("apply_migration")) out("allow");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const input = payload?.tool_input || {};
let verdict;
try {
  verdict = evaluateMigrationApplyWithCachedTestEvidence({
    name: input.name,
    query: input.query,
    projectId: input.project_id,
    projectDir,
    cwd: payload?.cwd || input.cwd || process.cwd(),
  });
} catch (err) {
  out("block", `MIGRATION APPLY GUARD: cached regression evaluation failed (${err?.message || err}).`);
}

if (verdict?.decision !== "allow") {
  out("block", verdict?.reason || "MIGRATION APPLY GUARD: cached regression evaluation returned an unknown verdict.");
}
out("allow");

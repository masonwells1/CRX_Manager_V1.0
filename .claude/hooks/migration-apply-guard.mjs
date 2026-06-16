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
// Setup matcher: this hook is registered against matcher "*" and filters
// in-script for tool names containing "apply_migration".

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

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
const stateDir = path.join(projectDir, ".claude", "session-state");

// Make sure the directory exists so future writes work.
try { mkdirSync(stateDir, { recursive: true }); } catch { /* ignore */ }

// Extract the migration identifier from the MCP call. Supabase MCP apply_migration
// shape is { project_id, name, query }. We use `name` if present, otherwise fall
// back to the first matching migration file from the SQL query content.
const input = payload?.tool_input || {};
const migName = (input.name || "").toString().trim();
const migQuery = (input.query || "").toString();
const currentHash = migQuery ? createHash("sha256").update(migQuery).digest("hex") : "";

// Look at all proof files in stateDir and find a recent one for this migration.
const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const now = Date.now();

let validProof = null;
try {
  const files = readdirSync(stateDir).filter(f => f.startsWith("migration-review-") && f.endsWith(".json"));
  for (const f of files) {
    const full = path.join(stateDir, f);
    let data;
    try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
    let ageMs;
    try { ageMs = now - new Date(data.timestamp).getTime(); } catch { continue; }
    if (ageMs > MAX_AGE_MS) continue;
    // Match if proof migration name appears in the apply_migration `name` field
    // or if the apply_migration name matches.
    const proofName = (data.migration || "").toString();
    if (
      proofName &&
      (migName.includes(proofName) || proofName.includes(migName) || migName === proofName)
    ) {
      const findings = (data.findings || "").toString();
      if (findings === "clean" || findings === "blockers-fixed") {
        // Content-binding: if the proof recorded a queryHash, it must match the SQL
        // actually being applied. A mismatch means the migration was edited AFTER it
        // was reviewed, so the proof no longer attests to this content — skip it.
        if (data.queryHash && currentHash && data.queryHash !== currentHash) continue;
        validProof = { file: f, data };
        break;
      }
    }
  }
} catch { /* directory unreadable — fall through to block */ }

if (validProof) out("allow");

// No valid proof — block with explicit instructions.
const safeName = migName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
out("block",
  `MIGRATION APPLY GUARD: Cannot apply migration "${migName || "(unnamed)"}" without subagent review proof.\n\n` +
  `REQUIRED STEPS before retrying this call:\n` +
  `  1. Dispatch in PARALLEL (single message with two Agent tool calls):\n` +
  `       Agent: rls-security-reviewer    (scope: this migration)\n` +
  `       Agent: migration-drift-reviewer (scope: this migration)\n` +
  `  2. If either returns BLOCKER findings, FIX them and re-dispatch until clean.\n` +
  `  3. Once both return clean (or "blockers-fixed"), write the proof file:\n` +
  `       Path: .claude/session-state/migration-review-${safeName}.json\n` +
  `       Content (JSON):\n` +
  `         {\n` +
  `           "migration": "${migName}",\n` +
  `           "timestamp": "<current ISO timestamp>",\n` +
  `           "reviewers": ["rls-security-reviewer", "migration-drift-reviewer"],\n` +
  `           "findings": "clean",\n` +
  `           "queryHash": "${currentHash}"\n` +
  `         }\n` +
  `  4. Retry the apply_migration call.\n\n` +
  `The proof file expires after 30 minutes — this catches stale reviews on long sessions.\n` +
  `The "queryHash" above is the SHA-256 of the exact SQL being applied; it binds this proof to\n` +
  `this content. If the migration is edited after review, the hash changes and this guard blocks\n` +
  `again — re-confirm the reviewers, then update queryHash to the new value printed here.\n` +
  `This guard exists because of the B7/B8/B9 incidents (2026-05-26) where migrations were\n` +
  `applied without the parallel-session reviewers catching anon-EXECUTE-able SECDEF DML.`
);

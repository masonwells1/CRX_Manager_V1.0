#!/usr/bin/env node
// Idempotency body-check guard for CRX Manager.
// Detects SQL migration functions that declare p_idempotency_key text DEFAULT NULL
// but never actually USE it.
//
// TWO wiring patterns count as correctly wired (checked per function body):
//   1. Direct table access:
//        FROM idempotency_keys WHERE idempotency_key = p_idempotency_key   (check)
//        INSERT INTO idempotency_keys ...                                  (record)
//   2. Canonical helper calls (preferred — see CLAUDE.md "Idempotency" and
//      20260210000000_tier3_idempotency_and_triggers.sql):
//        check_idempotency(p_idempotency_key, '<op>')    (check, at top)
//        save_idempotency(p_idempotency_key, '<op>', v)  (record, at end)
//
// BOTH halves of ONE pattern are required. A body with only check_idempotency()
// or only save_idempotency() is HALF-WIRED — exactly the bug class this hook
// exists for — and is blocked. Mixing halves across patterns (e.g. a
// check_idempotency() call paired with a direct INSERT INTO idempotency_keys)
// is also blocked: use both halves of the same pattern.
//
// Escape hatch: the file-level marker comment
//   -- idempotency-body-check: exempt
// skips the check (only for wrappers that genuinely delegate idempotency —
// helper-wired bodies do NOT need it since this hook recognizes the helpers).
//
// Bug pattern: issue_return_credit declared the parameter and threw it away,
// so retries silently created duplicate credits (9b36cd2).

import { readFileSync } from "node:fs";

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

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!filePath || !filePath.endsWith(".sql") || !filePath.includes("supabase/migrations/")) {
  out("allow");
}

const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

if (/--\s*idempotency-body-check:\s*exempt/i.test(content)) {
  out("allow");
}

const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(([^)]*?)\)[\s\S]*?AS\s+(\$\w*\$)([\s\S]*?)\3/gi;

const violations = [];
let match;
while ((match = fnRe.exec(content)) !== null) {
  const fnName = match[1];
  const params = match[2];
  const body = match[4];

  if (!/p_idempotency_key\s+text/i.test(params)) continue;

  const hasMutation = /\b(INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(body);
  if (!hasMutation) continue;

  // Pattern 1: direct idempotency_keys access (check + record).
  const readsKey = /FROM\s+idempotency_keys\s+WHERE\s+idempotency_key\s*=\s*p_idempotency_key/i.test(body);
  const writesKey = /INSERT\s+INTO\s+idempotency_keys/i.test(body);
  const directWired = readsKey && writesKey;

  // Pattern 2: canonical helper calls. BOTH are required — half-wired fails.
  const callsCheckHelper = /\bcheck_idempotency\s*\(/i.test(body);
  const callsSaveHelper = /\bsave_idempotency\s*\(/i.test(body);
  const helperWired = callsCheckHelper && callsSaveHelper;

  if (directWired || helperWired) continue;

  const missing = [];
  if (callsCheckHelper !== callsSaveHelper) {
    missing.push(callsCheckHelper
      ? "calls check_idempotency() but never save_idempotency() — half-wired, the result is never recorded so retries replay the mutation"
      : "calls save_idempotency() but never check_idempotency() — half-wired, existing keys are never checked so retries replay the mutation");
  } else {
    if (!readsKey) missing.push("does not check idempotency before mutating (no direct idempotency_keys lookup, no check_idempotency() call)");
    if (!writesKey) missing.push("does not record the key after mutating (no INSERT INTO idempotency_keys, no save_idempotency() call)");
  }
  violations.push(`Function ${fnName}: ${missing.join("; ")}.`);
}

if (violations.length > 0) {
  out("block",
    "IDEMPOTENCY VIOLATION: " + violations.join(" | ") +
    " A function that declares p_idempotency_key MUST both check existing keys before mutating " +
    "and record the new key after — either via the canonical helpers (check_idempotency() at top " +
    "AND save_idempotency() at end — both, same pattern, no mixing) or via direct idempotency_keys " +
    "access. See .claude/skills/new-rpc/SKILL.md for the canonical pattern. " +
    "If this is intentional (e.g., a wrapper that delegates idempotency), add the marker " +
    "-- idempotency-body-check: exempt near the top of the migration file.");
}

out("allow");

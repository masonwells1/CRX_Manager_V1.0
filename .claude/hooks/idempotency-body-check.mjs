#!/usr/bin/env node
// Idempotency body-check guard for CRX Manager.
// Detects SQL migration functions that declare p_idempotency_key text DEFAULT NULL
// but never actually USE it (no SELECT from idempotency_keys, no INSERT into it).
//
// Bug pattern: issue_return_credit declared the parameter and threw it away,
// so retries silently created duplicate credits.

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

  const readsKey = /FROM\s+idempotency_keys\s+WHERE\s+idempotency_key\s*=\s*p_idempotency_key/i.test(body);
  const writesKey = /INSERT\s+INTO\s+idempotency_keys/i.test(body);

  if (!readsKey || !writesKey) {
    const missing = [];
    if (!readsKey) missing.push("does not read idempotency_keys");
    if (!writesKey) missing.push("does not record into idempotency_keys");
    violations.push(`Function ${fnName}: ${missing.join("; ")}.`);
  }
}

if (violations.length > 0) {
  out("block",
    "IDEMPOTENCY VIOLATION: " + violations.join(" | ") +
    " A function that declares p_idempotency_key MUST both check existing keys before mutating " +
    "and record the new key after. See .claude/skills/new-rpc/SKILL.md for the canonical pattern. " +
    "If this is intentional (e.g., a wrapper that delegates idempotency), add the marker " +
    "-- idempotency-body-check: exempt near the top of the migration file.");
}

out("allow");

#!/usr/bin/env node
// SQL migration safety guard for CRX Manager.
// Deterministic replacement for the prompt-hook version.
//
// Rules:
//   - Only inspect *.sql files in supabase/migrations/
//   - If no content visible, allow (fail-open)
//   - Block known patterns that have caused recurring bugs.

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
if (!filePath) out("allow");

if (!filePath.endsWith(".sql") || !filePath.includes("supabase/migrations/")) {
  out("allow");
}

const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

const violations = [];

// 1. pg_get_functiondef — bakes in existing bugs
if (/\bpg_get_functiondef\b/.test(content)) {
  violations.push("pg_get_functiondef() — never use this to clone/modify functions; rewrite explicitly.");
}

// 2. updated_at on tables that lack the column
const tablesWithoutUpdatedAt = [
  "commissions", "purchase_order_items", "payments", "write_offs", "delivery_items",
  "order_items", "quote_items", "return_items", "finance_charges", "prepay_applications",
  "cycle_counts", "cycle_count_items", "activity_feed", "financial_audit_log",
  "idempotency_keys", "receiving_records", "inventory_transactions", "invoice_line_allocations",
];
for (const t of tablesWithoutUpdatedAt) {
  const re = new RegExp(`UPDATE\\s+${t}\\s+SET[\\s\\S]{0,400}?\\bupdated_at\\b`, "i");
  if (re.test(content)) {
    violations.push(`UPDATE ${t} SET ... updated_at — table ${t} has no updated_at column.`);
    break;
  }
}

// 3. idempotency_keys wrong column names
if (/idempotency_keys/i.test(content)) {
  if (/\bWHERE\s+key\s*=\s*p_idempotency_key\b/i.test(content))
    violations.push("`WHERE key = p_idempotency_key` — column is `idempotency_key`, not `key`.");
  if (/\bidempotency_keys\s*\(\s*key\s*,/i.test(content))
    violations.push("INSERT INTO idempotency_keys (key, ...) — column is `idempotency_key`.");
  if (/\bON\s+CONFLICT\s*\(\s*key\s*\)/i.test(content))
    violations.push("ON CONFLICT (key) — should be ON CONFLICT (idempotency_key).");
  if (/\bidempotency_keys\b[\s\S]{0,200}?\bentity_(type|id)\b/i.test(content))
    violations.push("idempotency_keys references entity_type/entity_id — correct columns are operation/result.");
  if (/\bidempotency_keys\b[\s\S]{0,200}?\bresult_id\b/i.test(content))
    violations.push("idempotency_keys references result_id — correct column is `result`.");
}

// 4. ::text cast on idempotency_keys.result (jsonb)
if (/INSERT\s+INTO\s+idempotency_keys[\s\S]{0,400}?::text/i.test(content)) {
  violations.push("INSERT INTO idempotency_keys with ::text cast — result is jsonb. Pass jsonb_build_object(...) without ::text.");
}

// 5. Audit #7: `(<bigint_cents> * <numeric_qty>)::bigint` truncates fractional cents.
// Use safe_cents_qty(cents, qty) instead — it ROUNDs before casting.
// Strip SQL line-comments first so doc comments mentioning the pattern don't false-positive.
const stripped = content.replace(/--[^\n]*/g, "");
const reTruncatingMult = /(?<!ROUND\s*|round\s*)\(\s*[A-Za-z_."'\->]*_cents[A-Za-z_."'\->]*\s*\*[^()]*\)\s*::bigint/g;
const truncatingMatches = stripped.match(reTruncatingMult);
if (truncatingMatches) {
  violations.push(
    `(<*_cents> * <qty>)::bigint without ROUND — drops fractional cents on cast. ` +
    `Use safe_cents_qty(p_cents, p_qty) instead. ` +
    `Found: ${truncatingMatches.slice(0, 3).map(s => s.replace(/\s+/g, " ")).join(" / ")}`
  );
}

if (violations.length > 0) {
  out("block", "SQL SAFETY VIOLATION: " + violations.join(" | "));
}

out("allow");

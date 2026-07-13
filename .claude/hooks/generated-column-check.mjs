#!/usr/bin/env node
// Generated-column guard for CRX Manager.
// Bug pattern: reverse_write_off tried to UPDATE invoices.balance_cents,
// which is a GENERATED column — Postgres rejects every call (commit a419da8).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function out(decision, reason, systemMessage) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  if (decision !== "block" && systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

// FIX 2 (loud fail-open): registry missing/unparseable means this hook can't
// validate anything — still allow (fail-open by design), but say so loudly
// instead of silently waving everything through.
const REGISTRY_UNREADABLE_WARNING =
  "⚠ generated-column-check: schema-registry unreadable/stale — GENERATED-column " +
  "UPDATE guard SKIPPED. Run /regen-schema-registry.";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!filePath) out("allow");

const isSql = filePath.endsWith(".sql") && filePath.includes("supabase/migrations/");
const isTs = /\.tsx?$/.test(filePath) && filePath.includes("/src/") && !/\.(test|spec)\.tsx?$/.test(filePath);
if (!isSql && !isTs) out("allow");

const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

if (/(?:--|\/\/)\s*generated-column-check:\s*exempt/.test(content)) out("allow");

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, "..", "schema-registry.json");
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch {
  out("allow", null, REGISTRY_UNREADABLE_WARNING);
}

const generated = registry.generated_columns || [];
if (generated.length === 0) out("allow");

const violations = [];

for (const { table, column, expression } of generated) {
  if (isSql) {
    const re = new RegExp(`UPDATE\\s+(?:public\\.)?${table}\\s+SET[\\s\\S]{0,600}?\\b${column}\\b\\s*=`, "i");
    if (re.test(content)) {
      violations.push(`SQL: UPDATE ${table} SET ${column} = ... — ${column} is GENERATED (${expression}); update the source columns instead.`);
    }
  }
  if (isTs) {
    const re1 = new RegExp(`\\.from\\s*\\(\\s*['"\`]${table}['"\`]\\s*\\)[\\s\\S]{0,800}?\\.update\\s*\\(\\s*\\{[^}]*?\\b${column}\\s*:`, "i");
    const re2 = new RegExp(`\\.update\\s*\\(\\s*\\{[^}]*?\\b${column}\\s*:[\\s\\S]{0,400}?\\}\\s*\\)[\\s\\S]{0,200}?\\.from\\s*\\(\\s*['"\`]${table}['"\`]`, "i");
    if (re1.test(content) || re2.test(content)) {
      violations.push(`TS: .from('${table}').update({ ${column}: ... }) — ${column} is GENERATED (${expression}); update the source columns instead.`);
    }
  }
}

if (violations.length > 0) {
  out("block",
    "GENERATED COLUMN VIOLATION: " + violations.join(" | ") +
    ". Postgres rejects writes to GENERATED columns at runtime. " +
    "If you really mean to drop or alter the generated definition, do it in a separate migration " +
    "and add the marker -- generated-column-check: exempt at the top.");
}

out("allow");

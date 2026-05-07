#!/usr/bin/env node
// RLS-on-new-tables guard for CRX Manager.
// If a SQL migration creates a new table, the same migration must also
// ENABLE ROW LEVEL SECURITY and define at least one CREATE POLICY.

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

if (/--\s*rls-check:\s*exempt/i.test(content)) {
  out("allow");
}

const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([\w]+)\s*\(/gi;
const tablesCreated = [];
let m;
while ((m = tableRe.exec(content)) !== null) {
  tablesCreated.push(m[1]);
}

if (tablesCreated.length === 0) out("allow");

const violations = [];
for (const tbl of tablesCreated) {
  const enableRe = new RegExp(`ALTER\\s+TABLE\\s+(?:public\\.)?${tbl}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "i");
  const policyRe = new RegExp(`CREATE\\s+POLICY\\s+[^;]+ON\\s+(?:public\\.)?${tbl}\\b`, "i");

  const hasEnable = enableRe.test(content);
  const hasPolicy = policyRe.test(content);

  if (!hasEnable || !hasPolicy) {
    const missing = [];
    if (!hasEnable) missing.push("missing ENABLE ROW LEVEL SECURITY");
    if (!hasPolicy) missing.push("missing CREATE POLICY");
    violations.push(`Table ${tbl}: ${missing.join("; ")}.`);
  }
}

if (violations.length > 0) {
  out("block",
    "RLS VIOLATION: " + violations.join(" | ") +
    " Every new table MUST enable RLS and have at least one policy in the SAME migration. " +
    "See docs/workflows/DATABASE_CHANGE_CHECKLIST.md and docs/workflows/RLS_SECURITY_GUIDE.md. " +
    "If this is a junction/system table that legitimately doesn't need RLS, add the marker " +
    "-- rls-check: exempt near the top of the migration file (and document why).");
}

out("allow");

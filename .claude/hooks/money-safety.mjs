#!/usr/bin/env node
// Money safety guard for CRX Manager.
// Deterministic replacement for the prompt-hook version that erroneously blocked
// non-TS files (.md, .sql) when the LLM couldn't see file content.
//
// Rules:
//   - Only inspect .ts/.tsx files inside src/
//   - Skip node_modules/, supabase/migrations/, *.test/spec.tsx?
//   - If no content visible, allow (fail-open)
//   - Block: parseFloat() on a *cents variable

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

const isTs = /\.tsx?$/.test(filePath);
const isTest = /\.(test|spec)\.tsx?$/.test(filePath);
const inSrc = filePath.includes("/src/");
const excluded = /node_modules\/|supabase\/migrations\//.test(filePath);

if (!isTs || isTest || !inSrc || excluded) out("allow");

const content = payload?.tool_input?.content || payload?.tool_input?.new_string || "";
if (!content) out("allow");

const violations = [];
const reParseFloatCents = /parseFloat\s*\(\s*[A-Za-z_$][\w$]*(?:_cents|Cents)\b/g;
if (reParseFloatCents.test(content)) {
  violations.push("parseFloat() called on a *cents variable. Cents are integers — parseFloat introduces float rounding errors.");
}

if (violations.length > 0) {
  out("block",
    "MONEY SAFETY: " + violations.join(" | ") +
    " Money in CRX Manager is stored as bigint cents (e.g. 2550 for $25.50). " +
    "Use parseDollarsToCents() from src/lib/parseCents.");
}

out("allow");

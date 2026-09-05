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
    " New money storage in CRX Manager uses bigint cents (e.g. 2550 for $25.50); " +
    "existing PostgreSQL numeric-dollar storage may remain temporarily to avoid a risky unit rewrite, " +
    "but it is not an approved exception until exact numeric math, clean finite whole-cent values, " +
    "and an active finite whole-cent CHECK are verified; dirty or unconstrained columns remain findings. " +
    "For authoritative TypeScript input, first reject more than two fractional digits or apply one " +
    "explicit approved exact rounding rule; only then convert to integer cents. The shared " +
    "parseDollarsToCents() helper REFUSES more than two decimals by returning null (since " +
    "2026-09-03); callers must check for null and show MONEY_PRECISION_MESSAGE, never coerce " +
    "null to 0.");
}

out("allow");

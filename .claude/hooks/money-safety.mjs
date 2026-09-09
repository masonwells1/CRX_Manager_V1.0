#!/usr/bin/env node
// Money safety guard for CRX Manager.
// Deterministic replacement for the prompt-hook version that erroneously blocked
// non-TS files (.md, .sql) when the LLM couldn't see file content.
//
// Rules:
//   - Only inspect .ts/.tsx files inside src/
//   - Skip node_modules/, supabase/migrations/, *.test/spec.tsx?
//   - Judge the FULL post-edit file (Write content, or Edit/MultiEdit spliced onto disk)
//   - If no content visible at all, allow (fail-open)
//   - Block: parseFloat() on a *cents variable

import { readFileSync } from "node:fs";
import { judgedContent } from "./edit-splice-lib.mjs";
import { canonicalToolPath, hasShortNameSegment } from "./autopilot-lib.mjs";

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

// Judged on the CANONICAL path (GitHub Codex P1 on 60910c005): the scope predicate below
// used to read the raw spelling, so an alias that resolves to the real file fell outside it
// and the guard answered allow. Measured on this machine 2026-09-09: `x.sql::$DATA` opens the
// real file through Node's fs (the native editors) AND through PowerShell; `migrations.\x.sql`
// opens it through PowerShell / any Win32-normalising channel but not through Node's fs; a
// `.. ` or trailing-space directory opens it through neither. Canonicalising all of them is
// the deny-only, by-class answer: the guard judges the file Windows would open, whichever
// channel carried the path. canonicalToolPath() folds separators, drops a drive-relative
// prefix or stream suffix, trims trailing periods/spaces per segment and resolves `.`/`..`.
const filePath = canonicalToolPath(payload?.tool_input?.file_path || "");
// A DOS 8.3 short name (Codex gpt-5.6-sol High CRX-SEC-001 on 5f69ecc2d: `supabase\\MIGRAT~1`
// resolves to `supabase\\migrations`) opens the real file but matches no scope predicate below,
// so this guard would wave it through. Expanding the alias needs the filesystem; refusing it
// does not, and nothing legitimate spells a path this way.
const ALIAS_MSG = "PATH ALIAS: this path contains a DOS 8.3 short name (for example `MIGRAT~1`), " +
  "which opens the real file but matches no guard scope check, so the edit is refused rather than " +
  "waved through. Re-issue it with the full long path.";
if (hasShortNameSegment(filePath) || hasShortNameSegment(payload?.tool_input?.file_path || "")) out("block", ALIAS_MSG);
if (!filePath) out("allow");

const isTs = /\.tsx?$/.test(filePath);
const isTest = /\.(test|spec)\.tsx?$/.test(filePath);
const inSrc = /(?:^|\/)src\//.test(filePath);
const excluded = /node_modules\/|supabase\/migrations\//.test(filePath);

if (!isTs || isTest || !inSrc || excluded) out("allow");

// Full post-edit file for Edit/MultiEdit, the Write content otherwise — a MultiEdit
// `edits[]` array used to read as empty content here and this guard allowed it
// (Codex gpt-5.6-sol High on PR #605 at 233dbf3c8; probe-confirmed).
const { content } = judgedContent(filePath, payload?.tool_input);
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

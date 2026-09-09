#!/usr/bin/env node
// Generated-column guard for CRX Manager.
// Bug pattern: reverse_write_off tried to UPDATE invoices.balance_cents,
// which is a GENERATED column — Postgres rejects every call (commit a419da8).

import { readFileSync } from "node:fs";
import { judgedContent } from "./edit-splice-lib.mjs";
import { canonicalToolPath, hasShortNameSegment } from "./autopilot-lib.mjs";
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

const isSql = filePath.endsWith(".sql") && filePath.includes("supabase/migrations/");
const isTs = /\.tsx?$/.test(filePath) && /(?:^|\/)src\//.test(filePath) && !/\.(test|spec)\.tsx?$/.test(filePath);
if (!isSql && !isTs) out("allow");

// Full post-edit file for Edit/MultiEdit, the Write content otherwise — a MultiEdit
// `edits[]` array used to read as empty content here and this guard allowed it
// (Codex gpt-5.6-sol High on PR #605 at 233dbf3c8; probe-confirmed).
const { content } = judgedContent(filePath, payload?.tool_input);
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

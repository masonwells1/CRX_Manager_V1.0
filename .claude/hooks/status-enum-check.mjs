#!/usr/bin/env node
// CHECK-constraint literal guard for CRX Manager (formerly status-enum-only).
// Bug patterns:
//   - writing 'void' when the DB requires 'voided' (commit 4a25aea)
//   - writing entity_type 'system' when the CHECK only allows 'batch' etc.
//     (financial_audit_log, 2026-05-30 — caught only by a post-apply smoke test)
//
// v2 (C3, 2026-06-10): generalized from status_enums to ALL parseable CHECK
// IN-lists in .claude/schema-registry.json `check_constraints` (any literal
// written to a CHECK-IN-list column must be in the allowed set), and now also
// inspects SQL migration files, not just TS in src/.
// Constraints the registry could NOT parse are listed in `skipped_constraints`
// — this hook does NOT validate those.
// File name kept as status-enum-check.mjs for settings.json wiring stability.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { toLF, applyEditsForAnalysis } from "./edit-splice-lib.mjs";

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
  "⚠ status-enum-check: schema-registry unreadable/stale — CHECK-constraint literal " +
  "validation SKIPPED. Run /regen-schema-registry.";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  out("allow");
}

const filePath = (payload?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!filePath) out("allow");

const isTs = /\.tsx?$/.test(filePath) && !/\.(test|spec)\.tsx?$/.test(filePath) && filePath.includes("/src/");
const isSql = filePath.endsWith(".sql") && filePath.includes("supabase/migrations/");
if (!isTs && !isSql) out("allow");

// Content being judged: Write -> content (the full file). For Edit/MultiEdit
// the fragment is only PART of the file, so simulate the edit against the
// on-disk content (line-ending-safe — edit-splice-lib) and judge the FULL
// post-edit file. That is what makes a file-level `status-enum-check: exempt`
// marker that already lives elsewhere in the file (SQL or TS) visible to an
// Edit (fragment-only judging denied the very file the marker exempts — the
// 2026-08-26 deadlock class, same as grant-change-guard), and it closes the
// MultiEdit gap where an edits array produced empty content and the guard
// silently allowed. Falls back to the fragment(s) if the file can't be
// read/applied. LF-normalized either way.
const input = payload?.tool_input || {};
let content = input.content || input.new_string || "";
const isFragmentEdit = typeof input.content !== "string" &&
  (typeof input.old_string === "string" || Array.isArray(input.edits));
let reconstructed = !isFragmentEdit; // Write content IS the real post-edit file
if (isFragmentEdit) {
  try {
    if (existsSync(filePath)) {
      content = applyEditsForAnalysis(readFileSync(filePath, "utf8"), input);
      reconstructed = true;
    } else if (Array.isArray(input.edits)) {
      content = input.edits.map((e) => e?.new_string || "").join("\n");
    }
  } catch {
    /* keep the fragment */
  }
}
content = toLF(content);
if (!content) {
  // Empty content is only trustworthy when it IS the real post-edit file (a
  // Write of empty content, or a reconstruction that emptied the file). A
  // deletion Edit whose reconstruction FAILED leaves no signal at all —
  // allowing it would let a marker-deleting edit through unanalyzed
  // (CodeRabbit PR #489 round 2). Fail closed.
  if (reconstructed) out("allow");
  out("block",
    "STATUS-ENUM GUARD: this Edit deletes content, but the on-disk file could not be read to " +
    "analyze the post-edit result, so the deletion cannot be checked. Retry, or use a single " +
    "full-file Write so the guard sees complete content.");
}

if (/(?:\/\/|--)\s*status-enum-check:\s*exempt/.test(content)) out("allow");

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, "..", "schema-registry.json");
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch {
  out("allow", null, REGISTRY_UNREADABLE_WARNING);
}

// v2 registry: check_constraints { "table.column": { values: [...] } }.
// Fallback for a v1-shaped registry: status_enums { "table.column": [...] }.
const constraintMap = {};
if (registry.check_constraints && typeof registry.check_constraints === "object") {
  for (const [key, entry] of Object.entries(registry.check_constraints)) {
    if (entry && Array.isArray(entry.values)) constraintMap[key] = entry.values;
  }
} else {
  for (const [key, vals] of Object.entries(registry.status_enums || {})) {
    if (Array.isArray(vals)) constraintMap[key] = vals;
  }
}
if (Object.keys(constraintMap).length === 0) out("allow");

// table -> { column -> values[] }
const byTable = {};
for (const [key, values] of Object.entries(constraintMap)) {
  const dot = key.indexOf(".");
  const table = key.slice(0, dot);
  const col = key.slice(dot + 1);
  (byTable[table] = byTable[table] || {})[col] = values;
}

const violations = [];
const allowedList = (values) => values.map(v => `'${v}'`).join(", ");
const inSet = (values, literal) => values.some(v => String(v) === String(literal));

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

if (isTs) {
  // ── TS: .from('<table>') windows, .eq() filters + update/insert/upsert object literals ──
  const fromRe = /\.from\s*\(\s*['"`]([\w]+)['"`]\s*\)/g;
  let fm;
  while ((fm = fromRe.exec(content)) !== null) {
    const table = fm[1];
    const cols = byTable[table];
    if (!cols) continue;
    // The window ends at the NEXT .from() call: since Edits are judged as the
    // FULL post-edit file (2026-08-26), a fixed 800-char window otherwise
    // crosses into unrelated query chains — a later table's valid status fell
    // inside the preceding tables' windows and benign edits to existing pages
    // were denied (CodeRabbit PR #489, reproduced on GettingStarted.tsx).
    let after = content.slice(fm.index, fm.index + 800);
    const nextFrom = after.slice(fm[0].length).search(/\.from\s*\(/);
    if (nextFrom !== -1) after = after.slice(0, fm[0].length + nextFrom);

    for (const [col, values] of Object.entries(cols)) {
      const eqRe = new RegExp(`\\.eq\\s*\\(\\s*['"\`]${escRe(col)}['"\`]\\s*,\\s*(?:['"\`]([^'"\`]+)['"\`]|(-?\\d+(?:\\.\\d+)?))\\s*\\)`, "g");
      let em;
      while ((em = eqRe.exec(after)) !== null) {
        const val = em[1] !== undefined ? em[1] : em[2];
        if (!inSet(values, val)) {
          violations.push(`${table}.${col} = '${val}' (allowed: ${allowedList(values)})`);
        }
      }

      const objRe = new RegExp(`\\.(?:update|insert|upsert)\\s*\\(\\s*\\{[^}]*?\\b${escRe(col)}\\s*:\\s*(?:['"\`]([^'"\`]+)['"\`]|(-?\\d+(?:\\.\\d+)?))`, "g");
      let om;
      while ((om = objRe.exec(after)) !== null) {
        const val = om[1] !== undefined ? om[1] : om[2];
        if (!inSet(values, val)) {
          violations.push(`${table}.${col} = '${val}' (allowed: ${allowedList(values)})`);
        }
      }
    }
  }
}

if (isSql) {
  // Strip SQL line comments so doc comments don't false-positive.
  const sql = content.replace(/--[^\n]*/g, "");

  // Carve-out: if this migration ALTERs a table's CHECK constraints (expanding
  // the allowed set), skip validation for that table — the registry is stale
  // by definition until /regen-schema-registry runs post-apply.
  const tableConstraintTouched = new Set();
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\b([\s\S]*?);/gi;
  let am;
  while ((am = alterRe.exec(sql)) !== null) {
    if (/\bCHECK\b|\bCONSTRAINT\b/i.test(am[2])) tableConstraintTouched.add(am[1]);
  }

  // Splits one VALUES tuple / column list on top-level commas (paren + quote aware).
  function splitTopLevel(s) {
    const parts = [];
    let depth = 0, inQ = false, cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        cur += ch;
        if (ch === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else inQ = false; }
        continue;
      }
      if (ch === "'") { inQ = true; cur += ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  for (const [table, cols] of Object.entries(byTable)) {
    if (tableConstraintTouched.has(table)) continue;

    // (a) UPDATE <table> SET ... <col> = '<literal>'
    const updRe = new RegExp(`UPDATE\\s+(?:ONLY\\s+)?(?:public\\.)?${escRe(table)}(?:\\s+(?:AS\\s+)?\\w+)?\\s+SET\\b([\\s\\S]*?)(?=\\bWHERE\\b|\\bRETURNING\\b|;|$)`, "gi");
    let um;
    while ((um = updRe.exec(sql)) !== null) {
      for (const [col, values] of Object.entries(cols)) {
        const setRe = new RegExp(`\\b${escRe(col)}\\s*=\\s*'((?:[^']|'')*)'`, "gi");
        let sm;
        while ((sm = setRe.exec(um[1])) !== null) {
          const val = sm[1].replace(/''/g, "'");
          if (!inSet(values, val)) {
            violations.push(`SQL UPDATE ${table} SET ${col} = '${val}' (allowed: ${allowedList(values)})`);
          }
        }
      }
    }

    // (b) INSERT INTO <table> (col, ...) VALUES (...), (...) — positional literal check
    const insRe = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${escRe(table)}\\s*\\(([^)]+)\\)\\s*VALUES\\s*([\\s\\S]*?)(?=;|ON\\s+CONFLICT|RETURNING|$)`, "gi");
    let im;
    while ((im = insRe.exec(sql)) !== null) {
      const colList = splitTopLevel(im[1]).map(c => c.replace(/"/g, "").trim());
      const tupleRe = /\(([\s\S]*?)\)(?=\s*(?:,\s*\(|;|$|\s*ON|\s*RETURNING))/g;
      let tm;
      while ((tm = tupleRe.exec(im[2])) !== null) {
        const vals = splitTopLevel(tm[1]);
        colList.forEach((col, idx) => {
          const values = cols[col];
          if (!values || idx >= vals.length) return;
          const lit = vals[idx].match(/^'((?:[^']|'')*)'$/);
          if (!lit) return; // expression / variable — can't validate statically
          const val = lit[1].replace(/''/g, "'");
          if (!inSet(values, val)) {
            violations.push(`SQL INSERT INTO ${table} (${col}) = '${val}' (allowed: ${allowedList(values)})`);
          }
        });
      }
    }

    // (c) qualified comparisons:  <table>.<col> = '<literal>'
    for (const [col, values] of Object.entries(cols)) {
      const qRe = new RegExp(`\\b${escRe(table)}\\.${escRe(col)}\\s*=\\s*'((?:[^']|'')*)'`, "gi");
      let qm;
      while ((qm = qRe.exec(sql)) !== null) {
        const val = qm[1].replace(/''/g, "'");
        if (!inSet(values, val)) {
          violations.push(`SQL ${table}.${col} = '${val}' (allowed: ${allowedList(values)})`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  out("block",
    "CHECK CONSTRAINT VIOLATION: " + [...new Set(violations)].join(" | ") +
    ". The DB CHECK constraint will reject this at runtime. " +
    "If the CHECK constraint is intentionally being expanded in this change, " +
    "add // status-enum-check: exempt (TS) or -- status-enum-check: exempt (SQL) near the top of " +
    "the file and refresh .claude/schema-registry.json after the migration lands. " +
    "Constraints the registry could not parse are listed in skipped_constraints — those are NOT validated here.");
}

out("allow");

#!/usr/bin/env node
// SQL migration safety guard for CRX Manager.
// Deterministic replacement for the prompt-hook version.
//
// Rules:
//   - Only inspect *.sql files in supabase/migrations/
//   - If no content visible, allow (fail-open)
//   - Block known patterns that have caused recurring bugs.
//
// v2 (C3, 2026-06-10) — registry-backed rules 6-8 (read .claude/schema-registry.json):
//   6. UPDATE <table> SET <col> = NULL where col is NOT NULL live
//      (B1: unapply_credit_memo set returns.total_credit_cents = NULL — NOT NULL DEFAULT 0)
//   7. INSERT INTO <table> (...) explicitly listing a column that doesn't exist live
//      (B1 follow-on: issue_return_credit wrote returns.credited_by before the column existed)
//   8. nextval()/currval()/setval() or '<name>_seq'::regclass referencing a sequence
//      that doesn't exist live (B6: cm_invoice_number_seq was disk-only for months)
//   Carve-outs: tables CREATEd, columns ADDed (ALTER TABLE ... ADD COLUMN), columns
//   with DROP NOT NULL, and sequences CREATEd in the SAME file are exempt.
//   Marker `-- sql-safety: exempt-registry` skips rules 6-8 only (rules 1-5 always run).
//   Rules 6-8 fail-open when the registry is missing or still v1-shaped.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readStaleFlag } from "./registry-freshness-lib.mjs";
import { toLF, applyEditsForAnalysis } from "./edit-splice-lib.mjs";

function out(decision, reason, systemMessage) {
  const payload = decision === "block"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  if (decision !== "block" && systemMessage) payload.systemMessage = systemMessage;
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

// Content being judged: Write -> content (the full file). For Edit/MultiEdit
// the fragment is only PART of the file, so simulate the edit against the
// on-disk content (line-ending-safe — edit-splice-lib) and judge the FULL
// post-edit file. That is what makes a file-level `-- sql-safety:
// exempt-registry` marker that already lives elsewhere in the file visible to
// an Edit (fragment-only judging denied the very migration the marker exempts
// — the 2026-08-26 deadlock class, same as grant-change-guard), and it closes
// the MultiEdit gap where an edits array produced empty content and the guard
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
    "SQL SAFETY GUARD: this Edit deletes content, but the on-disk file could not be read to " +
    "analyze the post-edit result, so the deletion cannot be checked. Retry, or use a single " +
    "full-file Write so the guard sees complete content.");
}

// ─── Registry-freshness gate (A8, 2026-07-04; FIX 4 cross-worktree, 2026-07-13) ──
// A live apply_migration this session (in THIS worktree or ANY other — see FIX 4
// below) contained registry-relevant DDL, so registry-freshness.mjs (PostToolUse)
// wrote a REGISTRY-STALE.flag. Until the registry is refreshed, rules 6-8 below
// (and the 2 other registry-backed hooks: status-enum-check, generated-column-check)
// are checking against a schema that no longer exists — block new migration writes
// rather than validate them against stale data.
// The existing `-- sql-safety: exempt-registry` marker skips this gate too.
//
// FIX 4: the flag can live in either the LOCAL (this projectDir's) session-state
// directory or the SHARED main-checkout one (resolved via `git rev-parse
// --git-common-dir`) — a live apply from a sibling worktree writes to the shared
// location, which this checkout would otherwise never see. Flag present in EITHER
// location counts as stale. See registry-freshness-lib.mjs.
if (!/--\s*sql-safety:\s*exempt-registry/i.test(content)) {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { stale, path: flagPath } = readStaleFlag(projectDir);
    if (stale) {
      out("block",
        "REGISTRY STALE: the schema snapshot that powers the safety hooks (.claude/schema-registry.json) " +
        "is stale from the last live apply — a migration changed the live database and the registry has not " +
        "been refreshed, so every registry-backed check could be blind to what just changed. " +
        "Refresh it FIRST via the /regen-schema-registry skill's live-introspection mode " +
        "(the script's default mode only re-stamps the timestamp — that is NOT a refresh), " +
        "verify the registry content actually changed, then delete the flag " +
        `(found at: ${flagPath} — also check for/delete its counterpart in the OTHER location, ` +
        "local checkout vs. shared main-checkout .claude/session-state/, if one exists) " +
        "and retry this write. " +
        "(Escape hatch: add `-- sql-safety: exempt-registry` with a justification comment, same as rules 6-8.)");
    }
  } catch { /* fail-open */ }
}

const violations = [];

// 1. pg_get_functiondef — bakes in existing bugs
if (/\bpg_get_functiondef\b/.test(content)) {
  violations.push("pg_get_functiondef() — never use this to clone/modify functions; rewrite explicitly.");
}

// Schema registry (v2) — powers rules 2 (augmented) and 6-8. Fail-open if absent.
let registry = null;
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  registry = JSON.parse(readFileSync(path.join(here, "..", "schema-registry.json"), "utf8"));
} catch { /* fail-open */ }

// 2. updated_at on tables that lack the column
// (hardcoded fallback list, unioned with the registry's live-derived list)
const tablesWithoutUpdatedAt = [...new Set([
  "commissions", "purchase_order_items", "payments", "write_offs", "delivery_items",
  "order_items", "quote_items", "return_items", "finance_charges", "prepay_applications",
  "cycle_counts", "cycle_count_items", "activity_feed", "financial_audit_log",
  "idempotency_keys", "receiving_records", "inventory_transactions", "invoice_line_allocations",
  ...(Array.isArray(registry?.tables_without_updated_at) ? registry.tables_without_updated_at : []),
])];
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
// `to_jsonb(expr::text)` is SAFE — the cast is wrapped, so the inserted value
// is still jsonb (live batch_post_invoices stores to_jsonb(v_count::text));
// mask that shape first so only bare ::text near the INSERT trips the rule.
const rule4Content = content.replace(/to_jsonb\s*\([^()]*::text[^()]*\)/gi, "to_jsonb(__safe_wrapped__)");
if (/INSERT\s+INTO\s+idempotency_keys[\s\S]{0,400}?::text/i.test(rule4Content)) {
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

// ─── Rules 6-8: registry-backed live-schema checks ───────────────────────
const registryExempt = /--\s*sql-safety:\s*exempt-registry/i.test(content);
const hasV2 = registry && registry.columns && registry.not_null_columns && Array.isArray(registry.sequences);

if (!registryExempt && hasV2) {
  // Work on comment-stripped content (reuse `stripped` from rule 5).
  const sql = stripped;

  // In-file carve-outs.
  const inFileTables = new Set();
  let m6;
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
  while ((m6 = ctRe.exec(sql)) !== null) inFileTables.add(m6[1]);

  const inFileSequences = new Set();
  const csRe = /CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
  while ((m6 = csRe.exec(sql)) !== null) inFileSequences.add(m6[1]);

  const inFileAddedCols = {};       // table -> Set(col)
  const inFileDroppedNotNull = {};  // table -> Set(col)
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)\b([\s\S]*?)(?=;|$)/gi;
  while ((m6 = alterRe.exec(sql)) !== null) {
    const tbl = m6[1];
    const body = m6[2];
    let cm;
    const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
    while ((cm = addRe.exec(body)) !== null) (inFileAddedCols[tbl] = inFileAddedCols[tbl] || new Set()).add(cm[1]);
    const dnnRe = /ALTER\s+(?:COLUMN\s+)?"?(\w+)"?\s+DROP\s+NOT\s+NULL/gi;
    while ((cm = dnnRe.exec(body)) !== null) (inFileDroppedNotNull[tbl] = inFileDroppedNotNull[tbl] || new Set()).add(cm[1]);
  }

  // Rule 6 — UPDATE <table> SET <col> = NULL where col is NOT NULL live.
  const updRe = /UPDATE\s+(?:ONLY\s+)?(?:public\.)?(\w+)(?:\s+(?:AS\s+)?\w+)?\s+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|;|$)/gi;
  while ((m6 = updRe.exec(sql)) !== null) {
    const tbl = m6[1];
    const nn = registry.not_null_columns[tbl];
    if (!nn || inFileTables.has(tbl)) continue;
    const notNullSet = new Set([...(nn.no_default || []), ...(nn.with_default || [])]);
    let sm;
    const setNullRe = /\b(\w+)\s*=\s*NULL\b/gi;
    while ((sm = setNullRe.exec(m6[2])) !== null) {
      const col = sm[1];
      if (notNullSet.has(col) && !inFileDroppedNotNull[tbl]?.has(col)) {
        violations.push(
          `UPDATE ${tbl} SET ${col} = NULL — ${col} is NOT NULL live; Postgres rejects every call ` +
          `(B1 class: returns.total_credit_cents). Use the column's neutral value (e.g. 0) or DROP NOT NULL first.`
        );
      }
    }
  }

  // Rule 7 — INSERT INTO <table> (...) listing a column that doesn't exist live.
  const insRe = /INSERT\s+INTO\s+(?:public\.)?(\w+)\s*\(([^)]+)\)/gi;
  while ((m6 = insRe.exec(sql)) !== null) {
    const tbl = m6[1];
    const known = registry.columns[tbl];
    if (!known || inFileTables.has(tbl)) continue;
    const cols = m6[2].split(",").map(c => c.replace(/"/g, "").trim());
    if (!cols.every(c => /^\w+$/.test(c))) continue; // not a plain column list — skip
    const allowed = new Set([...known, ...(inFileAddedCols[tbl] || [])]);
    const unknown = cols.filter(c => !allowed.has(c));
    if (unknown.length > 0) {
      violations.push(
        `INSERT INTO ${tbl} (...${unknown.join(", ")}...) — column(s) do not exist live ` +
        `(B1 class: returns.credited_by was referenced before it existed). ` +
        `ADD COLUMN in this migration first, or fix the column name.`
      );
    }
  }

  // Rule 8 — sequence refs that don't exist live.
  const seqSet = new Set(registry.sequences);
  const seenSeqViolations = new Set();
  const nvRe = /\b(?:nextval|currval|setval)\s*\(\s*'(?:public\.)?(\w+)'/gi;
  while ((m6 = nvRe.exec(sql)) !== null) {
    const seq = m6[1];
    if (!seqSet.has(seq) && !inFileSequences.has(seq) && !seenSeqViolations.has(seq)) {
      seenSeqViolations.add(seq);
      violations.push(
        `nextval/currval/setval('${seq}') — sequence does not exist live ` +
        `(B6 class: cm_invoice_number_seq was disk-only and crashed on first use). ` +
        `CREATE SEQUENCE in this migration, or fix the name. Live sequences: ${[...seqSet].join(", ")}.`
      );
    }
  }
  const rcRe = /'(?:public\.)?(\w+_seq)'\s*::\s*regclass/gi;
  while ((m6 = rcRe.exec(sql)) !== null) {
    const seq = m6[1];
    if (!seqSet.has(seq) && !inFileSequences.has(seq) && !seenSeqViolations.has(seq)) {
      seenSeqViolations.add(seq);
      violations.push(`'${seq}'::regclass — sequence does not exist live. CREATE SEQUENCE first or fix the name.`);
    }
  }
}

if (violations.length > 0) {
  out("block", "SQL SAFETY VIOLATION: " + violations.join(" | ") +
    (hasV2 && !registryExempt
      ? " | (If a registry-backed rule 6-8 hit is a false positive because the schema just changed, refresh via /regen-schema-registry, or add -- sql-safety: exempt-registry with a justification comment.)"
      : ""));
}

// FIX 2 (loud fail-open): rules 6-8 are silently disabled when the registry is
// missing or still v1-shaped (no columns/not_null_columns/sequences keys) — say
// so loudly instead of letting a migration write pass with no indication those
// checks never ran. The explicit exempt-registry marker is a deliberate opt-out,
// not a failure, so it does not warn.
const registryStaleWarning = (!hasV2 && !registryExempt)
  ? "⚠ sql-safety: schema-registry unreadable/stale — rules 6-8 (NOT NULL / unknown-column / " +
    "unknown-sequence checks) SKIPPED. Run /regen-schema-registry."
  : undefined;

out("allow", null, registryStaleWarning);

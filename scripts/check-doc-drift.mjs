#!/usr/bin/env node
// C8 — machine-checkable doc-claims vs reality
// (docs/audits/2026-06-10-error-prevention-review.md §4: doc drift eats
// Codex findings — counts in CLAUDE.md / migration-history.md silently lag.)
//
// CHECKS (all local; live-DB cross-checks are out of scope for plain node —
// see the SKIP row):
//   1. supabase/migrations/*.sql file count  vs  the
//      "# Migration History (N migrations)" header in
//      docs/reference/migration-history.md
//   2. migration file count  vs  the CLAUDE.md "**NNN migrations**" claim
//   3. lazy( count in src/App.tsx  vs  the CLAUDE.md "NN pages" claim
//   4. every supabase/migrations/*.sql filename represented in
//      migration-history.md (by 14-digit stamp OR by slug — B7 renames mean
//      the doc may carry the MCP stamp while describing the same slug)
//   5. live DB migration count — SKIP (no DB driver here, zero-new-deps rule;
//      cross-check via Supabase MCP `list_migrations` on rhyzpcqhnizqbxphqdkr)
//
// REGEXES (documented; parse defensively — a claim that can't be found is
// itself reported as ERROR, not silently skipped):
//   header:    /^#\s*Migration History\s*\((\d+)\s+migrations?\)/m
//   CLAUDE.md: /\*\*(\d{1,5})\s+migrations\*\*/      (first match = Current State line;
//              the plain-text "379 migrations" in the Reference Docs table is NOT bold,
//              so it is deliberately not matched)
//   pages:     /\b(\d{1,4})\s+pages\b/               (first match = Current State line)
//   lazy:      /\blazy\(/g                           (matches `lazy(` exactly — React.lazy imports)
//   migration: /^(\d{8,14})_(.+)\.sql$/              (stamp + slug; non-conforming names fall
//              back to full-basename containment)
//
// Usage:  node scripts/check-doc-drift.mjs
// Exit:   0 = all PASS/SKIP, 1 = any FAIL or ERROR.
// Deps:   none (node builtins only).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const rows = []; // { check, claim, actual, status, note }
function row(check, claim, actual, status, note = "") {
  rows.push({ check, claim: String(claim), actual: String(actual), status, note });
}

function readOrNull(rel) {
  try { return readFileSync(path.join(root, rel), "utf8"); } catch { return null; }
}

// ─── Reality ──────────────────────────────────────────────────────────────
let migrationFiles = [];
try {
  migrationFiles = readdirSync(path.join(root, "supabase", "migrations"))
    .filter(f => f.endsWith(".sql"));
} catch { /* handled below: count 0 + ERROR rows will follow */ }
const migCount = migrationFiles.length;

const appTsx = readOrNull("src/App.tsx");
const lazyCount = appTsx ? (appTsx.match(/\blazy\(/g) || []).length : null;

const historyMd = readOrNull("docs/reference/migration-history.md");
const claudeMd = readOrNull("CLAUDE.md");

// ─── 1. migration-history.md header count ────────────────────────────────
{
  const m = historyMd?.match(/^#\s*Migration History\s*\((\d+)\s+migrations?\)/m);
  if (!historyMd) {
    row("migration-history.md header", "(file missing)", migCount, "ERROR", "docs/reference/migration-history.md not readable");
  } else if (!m) {
    row("migration-history.md header", "(header not found)", migCount, "ERROR", "header regex did not match — was the '(N migrations)' header reworded?");
  } else {
    const claim = Number(m[1]);
    row("migration-history.md header", claim, migCount, claim === migCount ? "PASS" : "FAIL",
      claim === migCount ? "" : `header says ${claim}, disk has ${migCount} (Δ ${migCount - claim})`);
  }
}

// ─── 2. CLAUDE.md **NNN migrations** claim ────────────────────────────────
{
  const m = claudeMd?.match(/\*\*(\d{1,5})\s+migrations\*\*/);
  if (!claudeMd) {
    row("CLAUDE.md migrations claim", "(file missing)", migCount, "ERROR", "CLAUDE.md not readable");
  } else if (!m) {
    row("CLAUDE.md migrations claim", "(claim not found)", migCount, "ERROR", "no bold '**N migrations**' claim matched");
  } else {
    const claim = Number(m[1]);
    row("CLAUDE.md migrations claim", claim, migCount, claim === migCount ? "PASS" : "FAIL",
      claim === migCount ? "" : `Current State says ${claim}, disk has ${migCount} (Δ ${migCount - claim})`);
  }
}

// ─── 3. CLAUDE.md pages claim vs App.tsx lazy() count ─────────────────────
{
  const m = claudeMd?.match(/\b(\d{1,4})\s+pages\b/);
  if (lazyCount === null) {
    row("CLAUDE.md pages vs App.tsx lazy()", m ? m[1] : "?", "(src/App.tsx missing)", "ERROR", "src/App.tsx not readable");
  } else if (!m) {
    row("CLAUDE.md pages vs App.tsx lazy()", "(claim not found)", lazyCount, "ERROR", "no 'N pages' claim matched in CLAUDE.md");
  } else {
    const claim = Number(m[1]);
    row("CLAUDE.md pages vs App.tsx lazy()", claim, lazyCount, claim === lazyCount ? "PASS" : "FAIL",
      claim === lazyCount ? "" : `CLAUDE.md says ${claim} pages, App.tsx has ${lazyCount} lazy() imports`);
  }
}

// ─── 4. every migration filename indexed in migration-history.md ─────────
{
  if (!historyMd) {
    row("all migrations indexed in history doc", migCount, "(doc missing)", "ERROR");
  } else {
    const missing = [];
    for (const f of migrationFiles) {
      const base = f.replace(/\.sql$/, "");
      const m = base.match(/^(\d{8,14})_(.+)$/);
      // Present if the doc mentions the stamp OR the slug (B7: disk stamp may
      // have been renamed to the MCP stamp the doc records, or vice versa).
      const present = m
        ? (historyMd.includes(m[1]) || historyMd.includes(m[2]))
        : historyMd.includes(base);
      if (!present) missing.push(f);
    }
    row("all migrations indexed in history doc", `${migCount} files`, `${migCount - missing.length} indexed`,
      missing.length === 0 ? "PASS" : "FAIL",
      missing.length ? `missing: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? ` …+${missing.length - 15} more` : ""}` : "");
  }
}

// ─── 5. live DB cross-check (optional — skipped without a DB driver) ─────
row("live DB migration count", "(live)", "(skipped)", "SKIP",
  "no DB access from plain node (zero-deps rule); cross-check via Supabase MCP list_migrations (project rhyzpcqhnizqbxphqdkr)");

// ─── Print table ──────────────────────────────────────────────────────────
const w1 = Math.max(...rows.map(r => r.check.length), 5);
const w2 = Math.max(...rows.map(r => r.claim.length), 5);
const w3 = Math.max(...rows.map(r => r.actual.length), 6);
console.log("── check-doc-drift ──────────────────────────────────────────────");
console.log(`${"CHECK".padEnd(w1)}  ${"CLAIM".padEnd(w2)}  ${"ACTUAL".padEnd(w3)}  STATUS`);
for (const r of rows) {
  console.log(`${r.check.padEnd(w1)}  ${r.claim.padEnd(w2)}  ${r.actual.padEnd(w3)}  ${r.status}`);
  if (r.note) console.log(`${"".padEnd(w1)}  ↳ ${r.note}`);
}

const bad = rows.filter(r => r.status === "FAIL" || r.status === "ERROR");
console.log("─────────────────────────────────────────────────────────────────");
if (bad.length === 0) {
  console.log("PASS — docs match reality.");
  process.exit(0);
}
console.log(`FAIL — ${bad.length} drifted/erroring check(s). Update the docs (Documentation Maintenance Rules in CLAUDE.md) — drift here is how Codex findings get lost.`);
process.exit(1);

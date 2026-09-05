#!/usr/bin/env node

// Machine-checkable reference-doc claims vs repository reality.
// Always-loaded AGENTS.md and CLAUDE.md intentionally contain no volatile counts.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chicagoCalendarStamp,
  manualFreshnessBoundary,
  parseLatestMigrationHistoryEntry,
} from "./check-doc-drift-lib.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const rows = [];
const row = (check, claim, actual, status, note = "") => rows.push({ check, claim: String(claim), actual: String(actual), status, note });
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const migrations = readdirSync(path.join(ROOT, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
const history = read("docs/reference/migration-history.md");
const routes = read("docs/reference/pages-routes.md");
const app = read("src/App.tsx");
const databaseSchema = read("docs/reference/database-schema.md");
const schemaRegistry = JSON.parse(read(".claude/schema-registry.json"));

const historyClaim = parseLatestMigrationHistoryEntry(history);
const historySequences = [...history.matchAll(/^\|\s*(\d+)\s*\|\s*\d{8,14}\s*\|/gm)]
  .map((match) => Number(match[1]));
const latestHistorySequence = historySequences.length ? Math.max(...historySequences) : 0;
row("migration-history latest sequence", historyClaim ?? "missing", latestHistorySequence,
  Number(historyClaim) === latestHistorySequence ? "PASS" : "FAIL",
  `parsed history rows: ${historySequences.length}`);

const missingMigrations = migrations.filter((filename) => {
  const base = filename.replace(/\.sql$/, "");
  const match = base.match(/^(\d{8,14})_(.+)$/);
  return match ? !history.includes(match[1]) && !history.includes(match[2]) : !history.includes(base);
});
row("all migrations indexed", migrations.length, migrations.length - missingMigrations.length,
  missingMigrations.length === 0 ? "PASS" : "FAIL",
  missingMigrations.length ? `missing: ${missingMigrations.slice(0, 15).join(", ")}` : "");

const routeHeader = routes.match(/^#\s*Pages & Routes Reference\s*\((\d+)\s+pages,\s*(\d+)\s+routes\)/im);
const pageClaim = routeHeader?.[1];
const routeClaim = routeHeader?.[2];
const lazyCount = (app.match(/\blazy\s*\(/g) || []).length;
const routeRows = routes.split(/\r?\n/).filter((line) => /^\| `\//.test(line)).length;
row("pages-routes page count", pageClaim ?? "missing", lazyCount,
  Number(pageClaim) === lazyCount ? "PASS" : "FAIL");
row("pages-routes route count", routeClaim ?? "missing", routeRows,
  Number(routeClaim) === routeRows ? "PASS" : "FAIL");

row("live DB migration count", "live", "skipped", "SKIP",
  "plain Node check is local-only; verify via the read-only Supabase connector when current live state matters");

// Returns is a high-risk money/inventory lifecycle row. Keep its concise doc
// entry tied to the live-generated registry so stale invented fields or a
// missing terminal status cannot survive an ordinary docs check.
const returnsDocLine = databaseSchema.split(/\r?\n/).find((line) => line.startsWith("- `returns` -")) || "";
const returnsColumns = new Set(schemaRegistry.columns?.returns || []);
const returnsStatuses = schemaRegistry.status_enums?.["returns.status"];
const hasReturnsStatuses = Array.isArray(returnsStatuses) && returnsStatuses.length > 0;
const documentedStatuses = (returnsDocLine.match(/\bstatus:\s*([^,]+)/)?.[1] || "")
  .split("/")
  .map((status) => status.trim())
  .filter(Boolean);
const statusMatches = hasReturnsStatuses
  && documentedStatuses.length === returnsStatuses.length
  && documentedStatuses.every((status, index) => status === returnsStatuses[index]);
const documentedStatus = hasReturnsStatuses
  ? `status: ${returnsStatuses.join("/")}`
  : "status: <missing from schema registry>";
const requiredReturnsColumns = [
  "reason", "reason_notes", "total_credit_cents", "credit_invoice_id",
  "cancelled_at", "cancelled_by", "cancellation_reason", "credited_by",
];
const missingReturnsColumns = requiredReturnsColumns.filter(
  (column) => !returnsColumns.has(column) || !new RegExp(`\\b${column}\\b`).test(returnsDocLine),
);
const staleReturnsColumns = ["return_type", "reason_category"].filter(
  (column) => !returnsColumns.has(column) && new RegExp(`\\b${column}\\b`).test(returnsDocLine),
);
row("Returns schema reference", documentedStatus, returnsDocLine || "missing",
  statusMatches && missingReturnsColumns.length === 0 && staleReturnsColumns.length === 0 ? "PASS" : "FAIL",
  [
    !hasReturnsStatuses ? "missing live status enum: returns.status" : "",
    hasReturnsStatuses && !statusMatches ? "documented status values do not exactly match live returns.status" : "",
    missingReturnsColumns.length ? `missing live columns: ${missingReturnsColumns.join(", ")}` : "",
    staleReturnsColumns.length ? `stale non-columns: ${staleReturnsColumns.join(", ")}` : "",
  ].filter(Boolean).join("; "));

// Every hook wired in settings.json must be documented in agent-guardrails.md,
// so the doc future agents are routed to can never silently fall behind the guard net.
const settingsRaw = read(".claude/settings.json");
const guardrails = read("docs/reference/agent-guardrails.md");
const wiredHooks = [...new Set(
  [...settingsRaw.matchAll(/\.claude[\\/]hooks[\\/]([\w.-]+\.mjs)/g)].map((m) => m[1])
)];
const undocumentedHooks = wiredHooks.filter((name) => !guardrails.includes(name));
row("wired hooks documented in agent-guardrails.md", wiredHooks.length, wiredHooks.length - undocumentedHooks.length,
  undocumentedHooks.length === 0 ? "PASS" : "FAIL",
  undocumentedHooks.length ? `undocumented: ${undocumentedHooks.join(", ")}` : "");

// Operating-manual docs must exist and carry a "Last verified:" stamp so staleness is visible.
const manualDocs = [
  "ARCHITECTURE.md", "DECISION_LOG.md", "KNOWN_ISSUES.md",
  "CURRENT_STATE.md", "OWNER_PLAYBOOK.md", "AGENT_ONBOARDING.md",
];
for (const doc of manualDocs) {
  const rel = `docs/manual/${doc}`;
  if (!existsSync(path.join(ROOT, rel))) {
    row(`manual doc ${doc}`, "exists", "missing", "FAIL");
    continue;
  }
  const stamped = /^\*{0,2}Last verified:?\*{0,2}\s*\d{4}-\d{2}-\d{2}/m.test(read(rel));
  row(`manual doc ${doc}`, "Last verified stamp", stamped ? "present" : "missing",
    stamped ? "PASS" : "FAIL");
}

// HARD freshness gate (2026-07-16 scaffolding review): the two docs that describe
// LIVE state must not claim a "Last verified" date OLDER than the newest migration
// on disk, capped at today's America/Chicago calendar date. A future stamp cannot
// truthfully force a future verification claim before that business date arrives;
// on and after that date the normal freshness rule applies. A migration dated after
// the stamp means the schema/behavior changed
// after the doc was last checked — so its freshness promise is stale. This is the
// forcing function the manual layer lacked: within 48h of shipping, KNOWN_ISSUES
// listed an applied-live fix as "parked" while claiming same-day re-verification.
// Bump the stamp ONLY after actually re-reading the doc against live state.
const newestMigDate = migrations
  .map((name) => name.match(/^(\d{8})/)?.[1])
  .filter(Boolean)
  .sort()
  .at(-1); // YYYYMMDD of the newest migration
const todayChicago = chicagoCalendarStamp();
const freshnessDate = manualFreshnessBoundary(newestMigDate, todayChicago);
for (const doc of ["CURRENT_STATE.md", "KNOWN_ISSUES.md"]) {
  const rel = `docs/manual/${doc}`;
  if (!existsSync(path.join(ROOT, rel))) continue; // the "stamp present" check above already failed this
  const m = read(rel).match(/Last verified:?\*{0,2}\s*(\d{4})-(\d{2})-(\d{2})/);
  if (!m) continue; // no parseable stamp — already a FAIL above
  const stampDate = `${m[1]}${m[2]}${m[3]}`; // YYYYMMDD
  const fresh = !freshnessDate || stampDate >= freshnessDate;
  row(`manual freshness ${doc}`, `stamp >= freshness boundary (${freshnessDate ?? "none"})`, `stamp ${stampDate}`,
    fresh ? "PASS" : "FAIL",
    fresh ? "" : `migration ${newestMigDate} requires freshness through ${freshnessDate} (America/Chicago today ${todayChicago}) but this doc is older — re-verify it against live state (list_migrations / the live schema), correct anything stale, THEN bump the stamp. Do not bump the date without re-reading.`);
}

console.log("check-doc-drift");
for (const item of rows) {
  console.log(`${item.status.padEnd(4)} ${item.check}: claim=${item.claim} actual=${item.actual}${item.note ? ` - ${item.note}` : ""}`);
}
const failed = rows.filter((item) => item.status === "FAIL" || item.status === "ERROR");
if (failed.length > 0) {
  console.log(`FAIL - ${failed.length} reference-doc drift check(s) failed.`);
  process.exit(1);
}
console.log("PASS - reference documentation matches repository reality.");

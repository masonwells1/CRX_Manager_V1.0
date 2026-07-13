#!/usr/bin/env node

// Machine-checkable reference-doc claims vs repository reality.
// Always-loaded AGENTS.md and CLAUDE.md intentionally contain no volatile counts.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const rows = [];
const row = (check, claim, actual, status, note = "") => rows.push({ check, claim: String(claim), actual: String(actual), status, note });
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const migrations = readdirSync(path.join(ROOT, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
const history = read("docs/reference/migration-history.md");
const routes = read("docs/reference/pages-routes.md");
const app = read("src/App.tsx");

const historyClaim = history.match(/^#\s*Migration History\s*\((\d+)\s+migrations?\)/m)?.[1];
row("migration-history count", historyClaim ?? "missing", migrations.length,
  Number(historyClaim) === migrations.length ? "PASS" : "FAIL");

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

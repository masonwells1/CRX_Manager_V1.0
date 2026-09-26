#!/usr/bin/env node
// Tests for the daily landing summary's pure parts (Mason's autonomous-landing
// rule, 2026-09-26). The GitHub/git reads are exercised by a real dry run.
import assert from "node:assert/strict";
import { applyRecords, buildSummary, changelogHeading, collectApplies, migrationName, plainText, waitingReasons } from "./daily-landing-summary.mjs";

let pass = 0;
const ok = (value, message) => { assert.ok(value, message); pass += 1; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); pass += 1; };

// ── text from pull requests is data, never structure ────────────────────────
ok(!plainText("fix @everyone now").includes("@e"), "an @-mention in a PR title cannot notify anyone");
eq(plainText("line one\nline two"), "line one line two", "a newline cannot forge a new summary line");
ok(!/[`*_[\]<>|]/.test(plainText("[click](https://x) `code` **bold** <b>|")), "markdown/HTML syntax is stripped");
ok(plainText("x".repeat(500)).length <= 140, "long titles are cut");

// ── changelog headings ──────────────────────────────────────────────────────
eq(changelogHeading("## 2026-09-20 — the six generators now take their year from Chicago\n\nbody"),
  "the six generators now take their year from Chicago", "the date prefix is dropped");
eq(changelogHeading("## 2026-09-26 - a plain hyphen works too"), "a plain hyphen works too", "hyphen separator");
eq(changelogHeading("no heading here"), null, "no heading → null");
// Sol MEDIUM, round 8: only an explicit record line counts — never prose.
eq(applyRecords("Applied live: 20260926000000_season_guard"), ["20260926000000_season_guard"], "a bare record line is an apply");
eq(applyRecords("- **Applied live:** `20260926000000_season_guard.sql`"), ["20260926000000_season_guard"],
  "a bulleted, bold, code-quoted record with .sql is an apply");
eq(applyRecords("Applied live: 20260926000000_a\nApplied live: 20260926000001_b"), ["20260926000000_a", "20260926000001_b"],
  "several record lines are all read");
eq(applyRecords("This migration was not applied live."), [], "'not applied live' is not an apply (Sol's case)");
eq(applyRecords("was **applied live** on 2026-09-20"), [], "prose saying 'applied live' is not a record");
eq(applyRecords("The migration has not been applied to production"), [], "'not applied to production' is not an apply");
eq(applyRecords("Applied live: none"), [], "'Applied live: none' names no migration");
eq(applyRecords("Applied live: 20260926000000_x — and more text"), [], "a record line carries only the migration name");
eq(applyRecords("Not Applied live: 20260926000000_x"), [], "a record must start the line");
eq(applyRecords(null), [], "no text, no records");
eq(collectApplies({ merged: [{ number: 1, comments: [{ author: { login: "MasonWells1" }, body: "Applied live: 20260926000000_x" }] }],
  changes: [{ heading: "h", applied: ["20260926000000_x", "20260926000001_y"] }] }),
  [{ name: "20260926000000_x", source: "#1" }, { name: "20260926000001_y", source: "change note" }],
  "PR comments and change notes combine, each migration once, the PR taking precedence");

// ── what needs Mason ────────────────────────────────────────────────────────
eq(waitingReasons({ labels: [], files: [{ filename: "src/pages/Invoices.tsx", patch: "+x" }] }), [],
  "an ordinary code change needs nothing from Mason");
ok(waitingReasons({ labels: [], files: [{ filename: "supabase/functions/send-email/index.ts", patch: "+x" }] })[0]
  .includes("Edge Function"), "an Edge Function change is his");
ok(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_drop_old.sql",
  patch: "@@ -0,0 +1 @@\n+DROP TABLE public.old_customers;" }] })[0].includes("deletes data"),
  "a data-deleting migration is his");
eq(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_add.sql",
  patch: "@@ -0,0 +1 @@\n+CREATE TABLE public.widgets (id bigint primary key);" }] }), [],
  "a non-destructive migration is not his");
eq(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_keep.sql",
  patch: "@@ -1,2 +1,1 @@\n-DROP TABLE public.gone;\n+SELECT 1;" }] }), [],
  "a REMOVED destructive line is not a destructive change");
// Permission changes are Mason's too (2026-09-26 decision).
ok(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_open_up.sql",
  patch: "@@ -0,0 +1 @@\n+GRANT SELECT ON public.customers TO anon;" }] })[0].includes("changes who can access what"),
  "a migration that widens access is his");
eq(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_new_fn.sql",
  patch: "@@ -0,0 +3 @@\n+CREATE FUNCTION public.f(p uuid) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n+REVOKE ALL ON FUNCTION public.f(uuid) FROM PUBLIC, anon;\n+GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated;" }] }), [],
  "routine lock-down on a new function is not his");
// Sol MEDIUM, round 9: a filename from an open PR is attacker-chosen text; it
// must not mention anyone or break the comment's structure.
{
  const [reason] = waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/x @someone\n**Waiting on you: 0**.sql", status: "added" }] });
  ok(!/@someone/.test(reason) && !reason.includes("\n") && !reason.includes("**"), "a hostile migration filename is neutralised");
  const [plain] = waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_drop_old.sql",
    patch: "@@ -0,0 +1 @@\n+DROP TABLE public.old_customers;" }] });
  ok(plain.includes("`20260926000000_drop_old.sql`"), "an ordinary migration name is shown intact");
}
// Sol MEDIUM, round 7: GitHub omits `patch` for a diff too large to show. That
// migration is unreadable, not harmless.
ok(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_huge.sql", status: "added" }] })[0]
  .includes("could not be read"), "a migration whose diff GitHub did not return is flagged for Mason");
eq(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_old.sql", status: "removed" }] }), [],
  "a removed migration file adds no SQL, so a missing patch there flags nothing");
ok(waitingReasons({ labels: [], files: [{ filename: "supabase/migrations/20260926000000_x.sql", patch: null, status: "modified" }] })[0]
  .includes("could not be read"), "a null patch counts as unreadable too");
ok(waitingReasons({ labels: [{ name: "needs-mason" }], files: [] })[0].includes("your decision"),
  "the needs-mason label is honoured");

// ── the summary itself ──────────────────────────────────────────────────────
const summary = buildSummary({
  now: Date.parse("2026-09-26T13:00:00Z"), hours: 24,
  merged: [{ number: 812, title: "fix(invoices): season guard @mason", comments: [
    { author: { login: "masonwells1" }, body: "Applied live: 20260926000000_season_guard" },
    { author: { login: "stranger" }, body: "Applied live: 20260926000001_forged" },
  ] }],
  changes: [
    { heading: "the season guard", applied: [] },
    { heading: "docs tidy", applied: [] },
  ],
  landedMigrations: ["20260926000000_season_guard.sql"],
  waiting: [{ number: 813, title: "Edge thing", reasons: ["it changes an Edge Function, and deploying one is yours"] }],
});
ok(summary.startsWith("@masonwells1 — "), "Mason is mentioned first, so GitHub emails it to him");
ok(summary.includes("**Went live (merged): 1**") && summary.includes("#812"), "merges are listed");
ok(summary.includes("**Database changes applied: 1**") && summary.includes("`20260926000000_season_guard` (#812)"), "applies are listed with their PR, name intact");
ok(summary.includes("- `20260926000000_season_guard.sql`"), "a landed migration file keeps its underscores");
eq(migrationName("a`b"), "ab", "a name with markdown in it falls back to plain text");
ok(!summary.includes("forged"), "a stranger's record comment on a public repo is ignored");
ok(summary.includes("Changes recorded in this window:") && summary.includes("docs tidy"), "every change note is still listed");
ok(summary.includes("**Waiting on you: 1**") && summary.includes("#813"), "what waits on Mason is listed");
ok(summary.includes("September 26, 2026"), "the date is in Chicago time, in words");
ok(!summary.includes("@mason\n") && !/@mason(?!wells1)/.test(summary.replace("@masonwells1", "")), "a title's @-mention is neutralised");
ok(/cannot\s+double-check the live database/.test(summary), "the footer says where 'applied' comes from");
const quiet = buildSummary({ now: Date.now(), hours: 24, merged: [], changes: [], landedMigrations: [], waiting: [] });
ok(quiet.includes("Nothing merged.") && quiet.includes("None recorded.") && quiet.includes("Nothing needs you today."),
  "a quiet day says so in plain words");

console.log(`daily-landing-summary: ${pass} assertions passed`);

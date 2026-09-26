#!/usr/bin/env node
// Tests for the daily landing summary's pure parts (Mason's autonomous-landing
// rule, 2026-09-26). The GitHub/git reads are exercised by a real dry run.
import assert from "node:assert/strict";
import { buildSummary, changelogHeading, plainText, recordsLiveApply, waitingReasons } from "./daily-landing-summary.mjs";

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
ok(recordsLiveApply("was **applied live** on 2026-09-20"), "'applied live' is an apply");
ok(recordsLiveApply("All three were then applied to live production"), "'applied to live production' is an apply");
ok(!recordsLiveApply("parked; not applied yet, waiting on Mason"), "a parked migration is not an apply");

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
ok(waitingReasons({ labels: [{ name: "needs-mason" }], files: [] })[0].includes("your decision"),
  "the needs-mason label is honoured");

// ── the summary itself ──────────────────────────────────────────────────────
const summary = buildSummary({
  now: Date.parse("2026-09-26T13:00:00Z"), hours: 24,
  merged: [{ number: 812, title: "fix(invoices): season guard @mason" }],
  changes: [
    { heading: "the season guard is live", appliedLive: true },
    { heading: "docs tidy", appliedLive: false },
  ],
  landedMigrations: ["20260926000000_season_guard.sql"],
  waiting: [{ number: 813, title: "Edge thing", reasons: ["it changes an Edge Function, and deploying one is yours"] }],
});
ok(summary.startsWith("@masonwells1 — "), "Mason is mentioned first, so GitHub emails it to him");
ok(summary.includes("**Went live (merged): 1**") && summary.includes("#812"), "merges are listed");
ok(summary.includes("**Database changes applied: 1**") && summary.includes("the season guard is live"), "applies are listed");
ok(summary.includes("**Waiting on you: 1**") && summary.includes("#813"), "what waits on Mason is listed");
ok(summary.includes("September 26, 2026"), "the date is in Chicago time, in words");
ok(!summary.includes("@mason\n") && !/@mason(?!wells1)/.test(summary.replace("@masonwells1", "")), "a title's @-mention is neutralised");
ok(/cannot\s+double-check the live database/.test(summary), "the footer says where 'applied' comes from");
const quiet = buildSummary({ now: Date.now(), hours: 24, merged: [], changes: [], landedMigrations: [], waiting: [] });
ok(quiet.includes("Nothing merged.") && quiet.includes("None recorded.") && quiet.includes("Nothing needs you today."),
  "a quiet day says so in plain words");

console.log(`daily-landing-summary: ${pass} assertions passed`);

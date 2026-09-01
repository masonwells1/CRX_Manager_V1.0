#!/usr/bin/env node
// Mutation tests for the pending-set preflight.
//
// The central case is the real 2026-08-26 incident, reproduced exactly: the
// older security migration 20260825190000_quote_version_restore_trust_boundary
// tracked on main and unapplied, the newer 20260826150000_fix_save_job_comment_refusal_count
// being applied, the live ledger topping out at 20260820120000. The guard must
// REFUSE. A guard that has only ever been observed passing has not been tested.
//
// The allow cases are load-bearing too: a check that refuses everything would
// pass every deny case and still be useless — and worse, it would be turned off.
// The false-positive cases below are the ones that decided the design (renumbered
// rows, pre-baseline history), measured against the real ledger on 2026-08-26.
//
// Run: node .claude/hooks/migration-pending-lib.test.mjs

import assert from "node:assert/strict";
import {
  migrationStem,
  migrationSlug,
  fileStamp,
  orderingStamp,
  appliedIndex,
  hasAheadOfPendingMarker,
  checkPendingMigrations,
} from "./migration-pending-lib.mjs";

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }
function denies(verdict, fragment, msg) {
  assert.equal(verdict.ok, false, `${msg} — expected a refusal, got ok=${verdict.ok}`);
  assert.ok(
    String(verdict.reason || "").includes(fragment),
    `${msg} — refusal did not mention ${JSON.stringify(fragment)}; got: ${String(verdict.reason).slice(0, 300)}`);
  pass++;
}
function allows(verdict, msg) {
  assert.equal(verdict.ok, true, `${msg} — expected ok, got refusal: ${String(verdict.reason).slice(0, 300)}`);
  assert.ok(!verdict.abstained, `${msg} — expected a real pass, got an abstention: ${verdict.abstainReason}`);
  pass++;
}
function abstains(verdict, fragment, msg) {
  assert.equal(verdict.ok, true, `${msg} — abstention must be ok:true so the caller distinguishes it`);
  assert.equal(verdict.abstained, true, `${msg} — expected an abstention`);
  assert.ok(
    String(verdict.abstainReason || "").includes(fragment),
    `${msg} — abstention did not mention ${JSON.stringify(fragment)}; got: ${verdict.abstainReason}`);
  pass++;
}

const BASELINE = "20260727174805"; // supabase/baselines/manifest.json, format_version 3

// ---------------------------------------------------------------------------
// Name decomposition — the shapes the live ledger actually produces
// ---------------------------------------------------------------------------
ok(migrationStem("supabase/migrations/20260825190000_quote_version.sql") === "20260825190000_quote_version",
  "stem strips path and .sql");
ok(migrationSlug("20260825190000_quote_version") === "quote_version", "slug drops one stamp");
// The renumbered shape: version prefix wrapping the original filename.
ok(migrationSlug("20260728182141_20260728123224_secdef_pricing_reads_office_only")
  === "secdef_pricing_reads_office_only", "slug drops BOTH stamps of a renumbered row");
ok(migrationSlug("deactivation_revokes_auth_access") === "deactivation_revokes_auth_access",
  "slug of a timestamp-less legacy ledger name is the name itself");
ok(fileStamp("20260826150000_fix.sql") === "20260826150000", "fileStamp reads the leading stamp");
ok(fileStamp("no_stamp_here.sql") === null, "fileStamp returns null with no leading stamp");

// Day-precision legacy names are dates, not junk. Both of these are on main today,
// and treating them as undated made the guard abstain on every apply.
ok(orderingStamp("20260210_fix_rls_critical_issues.sql") === "20260210000000",
  "an 8-digit legacy date pads to a comparable stamp");
ok(orderingStamp("20260826150000_fix.sql") === "20260826150000", "a full stamp is unchanged");
ok(orderingStamp("undated_hotfix.sql") === null, "a name with no leading date has no ordering stamp");

// appliedIndex must index EVERY stamp in a name, not just the leading one — a
// renumbered row's disk file matches the trailing one.
{
  const { stamps, slugs } = appliedIndex(["20260728182141_20260728123224_secdef_pricing"]);
  ok(stamps.has("20260728182141") && stamps.has("20260728123224"), "appliedIndex captures both stamps");
  ok(slugs.has("secdef_pricing"), "appliedIndex captures the slug");
}

// ---------------------------------------------------------------------------
// THE INCIDENT — 2026-08-26, reproduced from the live facts
// ---------------------------------------------------------------------------
const INCIDENT = {
  name: "20260826150000_fix_save_job_comment_refusal_count",
  sql: "COMMENT ON FUNCTION public.save_job IS 'twelve refusals';\n",
  // Live ledger high-water on the morning of 2026-08-26, before the bad apply.
  appliedNames: [
    "20260819232000_draw_down_cutover_barrier",
    "20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals",
  ],
  // Tracked on origin/main: the security migration is there and is NOT applied.
  trackedFiles: [
    "supabase/migrations/20260819232000_draw_down_cutover_barrier.sql",
    "supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql",
    "supabase/migrations/20260825190000_quote_version_restore_trust_boundary.sql",
    "supabase/migrations/20260826150000_fix_save_job_comment_refusal_count.sql",
  ],
  baselineHighWater: BASELINE,
};

{
  const v = checkPendingMigrations(INCIDENT);
  denies(v, "20260825190000_quote_version_restore_trust_boundary",
    "the 2026-08-26 sequence must be refused, naming the migration it would strand");
  denies(v, "Apply the older migration(s) FIRST",
    "the refusal must say what to do instead");
  assert.deepEqual(v.pending, ["20260825190000_quote_version_restore_trust_boundary"]);
  pass++;
}

// Same sequence, correct order: apply the OLDER one. Nothing older is pending.
allows(
  checkPendingMigrations({ ...INCIDENT, name: "20260825190000_quote_version_restore_trust_boundary" }),
  "applying the older migration first is exactly right and must pass");

// Once the security migration IS applied, the newer one goes in clean.
allows(
  checkPendingMigrations({
    ...INCIDENT,
    appliedNames: [...INCIDENT.appliedNames, "20260825190000_quote_version_restore_trust_boundary"],
  }),
  "with the pending migration applied, the newer one must pass");

// ---------------------------------------------------------------------------
// The override — distinct marker, substantive reason required
// ---------------------------------------------------------------------------
ok(hasAheadOfPendingMarker("-- ordering-guard: ahead-of-pending parked pending owner sign-off").marked,
  "a substantive reason unlocks the marker");
ok(!hasAheadOfPendingMarker("-- ordering-guard: ahead-of-pending ok").marked,
  "a token reason does NOT unlock the marker");
ok(!hasAheadOfPendingMarker("-- ordering-guard: ahead-of-pending").marked,
  "a bare marker does NOT unlock the guard");

// The replay marker must NOT unlock this guard. Reusing it would collapse two
// different decisions into one, which is the whole reason this marker exists.
denies(
  checkPendingMigrations({
    ...INCIDENT,
    sql: "-- ordering-guard: intentional-replay this is a deliberate replay of an older file\n",
  }),
  "MIGRATION PENDING-SET GUARD",
  "the intentional-replay marker must NOT unlock the pending-set guard");

{
  const v = checkPendingMigrations({
    ...INCIDENT,
    sql: "-- ordering-guard: ahead-of-pending the quote migration is parked pending Mason's OK\n",
  });
  ok(v.ok === true && v.allowedBy?.startsWith("ahead-of-pending:"),
    "the ahead-of-pending marker unlocks the guard and records why");
}

// ---------------------------------------------------------------------------
// FALSE POSITIVES — the cases that decided the design, from the real ledger
// ---------------------------------------------------------------------------

// A RENUMBERED migration is applied under a new version while the snapshot keeps
// its ORIGINAL stamp in the name. Stamps can never agree; the slug does. Real
// row: disk 20260728182141_secdef_pricing_reads_office_only.sql, live name
// 20260728123224_secdef_pricing_reads_office_only.
allows(
  checkPendingMigrations({
    name: "20260830120000_new_work",
    sql: "select 1;",
    appliedNames: ["20260728123224_secdef_pricing_reads_office_only"],
    trackedFiles: ["supabase/migrations/20260728182141_secdef_pricing_reads_office_only.sql"],
    baselineHighWater: BASELINE,
  }),
  "a renumbered-but-applied migration must NOT be reported as pending");

// PRE-BASELINE history: impossible stamps, applied under unrelated versions. Real
// example: 20260332000000 — month 33. 448 files look unapplied by stamp; the
// baseline floor is what makes the check usable at all.
allows(
  checkPendingMigrations({
    name: "20260830120000_new_work",
    sql: "select 1;",
    appliedNames: ["20260820120000_something"],
    trackedFiles: [
      "supabase/migrations/20260332000000_ancient_fake_month.sql",
      // Day-precision legacy names, both present on main today.
      "supabase/migrations/20260207_gap_analysis_fixes.sql",
      "supabase/migrations/20260210_fix_rls_critical_issues.sql",
      "supabase/migrations/20260510999999_ancient_sentinel.sql",
    ],
    baselineHighWater: BASELINE,
  }),
  "pre-baseline files must NOT be reported as pending, whatever their stamps look like");

// AMBIGUOUS SLUG (Codex P2, PR #502). The slug fallback above is only sound when
// a slug names exactly ONE tracked file. Two files sharing a slug with only one in
// the ledger makes "this slug is applied" true of the pair and false of the
// individual — so an unconditional match marked the unapplied one as applied and
// deleted it from the pending set, stranding it. Duplicate slugs are real history
// here (20260718225511 / 20260718230000 supplier_price_evidence_phase1b and two
// more pairs), all below the baseline today, so this was latent, not live.
{
  const shared = [
    "supabase/migrations/20260801120000_shared_slug.sql",
    "supabase/migrations/20260805120000_shared_slug.sql",
  ];
  // EXACT-STAMP SIBLING → the twin is PENDING, not ambiguous (Codex P2 round 2).
  // 20260801120000 matches its own stamp, so that ledger row is spoken for and
  // cannot also vouch for 20260805120000. The evidence is conclusive, and calling
  // it "ambiguous" would be both wrong and unfixable — renaming the candidate
  // cannot resolve a pair the candidate is not part of.
  {
    const v = checkPendingMigrations({
      name: "20260830120000_new_work",
      sql: "select 1;",
      appliedNames: ["20260820120000_anchor", "20260801120000_shared_slug"],
      trackedFiles: shared,
      baselineHighWater: BASELINE,
    });
    denies(v, "20260805120000_shared_slug",
      "an exact-stamp sibling makes its twin definitively pending, not ambiguous");
    assert.deepEqual(v.pending, ["20260805120000_shared_slug"]);
    assert.ok(!v.abstained, "conclusive evidence must not abstain");
    pass++;
  }

  // GENUINE ambiguity: the ledger knows the slug but by slug ALONE — no stamp
  // distinguishes which of the two files ran. Only here is a shrug honest.
  {
    const v = checkPendingMigrations({
      name: "20260830120000_new_work",
      sql: "select 1;",
      // A renumbered row: slug matches, stamp matches neither tracked file.
      appliedNames: ["20260820120000_anchor", "20260731090000_shared_slug"],
      trackedFiles: shared,
      baselineHighWater: BASELINE,
    });
    abstains(v, "share a slug",
      "slug-only ledger evidence for a shared slug is genuinely ambiguous");
    assert.deepEqual(v.ambiguous, ["20260801120000_shared_slug", "20260805120000_shared_slug"]);
    pass++;
  }

  // The marker must not paper over a genuine ambiguity: `ahead-of-pending` states
  // an intent about a queue the operator can SEE, and this queue cannot be seen.
  abstains(
    checkPendingMigrations({
      name: "20260830120000_new_work",
      sql: "-- ordering-guard: ahead-of-pending stepping over the shared-slug pair on purpose\n",
      appliedNames: ["20260820120000_anchor", "20260731090000_shared_slug"],
      trackedFiles: shared,
      baselineHighWater: BASELINE,
    }),
    "share a slug", "the ahead-of-pending marker does NOT unlock a slug ambiguity");

  // Both applied by stamp → no ambiguity to report. Without this the fix could be
  // abstaining on every shared slug, which would block real work.
  allows(
    checkPendingMigrations({
      name: "20260830120000_new_work",
      sql: "select 1;",
      appliedNames: ["20260801120000_shared_slug", "20260805120000_shared_slug"],
      trackedFiles: shared,
      baselineHighWater: BASELINE,
    }),
    "a shared slug whose files are BOTH applied by stamp is not ambiguous");

  // The real pairs on main are all pre-baseline, so they must stay silent — this is
  // what keeps the fix from refusing every apply from the day it lands.
  allows(
    checkPendingMigrations({
      name: "20260830120000_new_work",
      sql: "select 1;",
      appliedNames: ["20260820120000_anchor", "20260718225511_supplier_price_evidence_phase1b"],
      trackedFiles: [
        "supabase/migrations/20260718225511_supplier_price_evidence_phase1b.sql",
        "supabase/migrations/20260718230000_supplier_price_evidence_phase1b.sql",
      ],
      baselineHighWater: BASELINE,
    }),
    "the real pre-baseline duplicate-slug pairs stay below the floor and stay silent");
}

// An ascending batch of NEW migrations applied in the right order must pass at
// every step — the false positive that the first ordering guard shipped with.
{
  const batch = [
    "supabase/migrations/20260901120000_step_one.sql",
    "supabase/migrations/20260901130000_step_two.sql",
    "supabase/migrations/20260901140000_step_three.sql",
  ];
  const appliedSoFar = ["20260820120000_baseline_work"];
  for (const [i, file] of batch.entries()) {
    allows(
      checkPendingMigrations({
        name: migrationStem(file),
        sql: "select 1;",
        appliedNames: [...appliedSoFar, ...batch.slice(0, i).map(migrationStem)],
        trackedFiles: batch,
        baselineHighWater: BASELINE,
      }),
      `ascending batch step ${i + 1} must pass`);
  }
}

// The candidate itself being tracked-and-unapplied is not an objection to itself.
allows(
  checkPendingMigrations({
    name: "20260826150000_only_me",
    sql: "select 1;",
    appliedNames: ["20260820120000_prior"],
    trackedFiles: ["supabase/migrations/20260826150000_only_me.sql"],
    baselineHighWater: BASELINE,
  }),
  "the migration being applied must not count itself as pending");

// ---------------------------------------------------------------------------
// FAIL CLOSED — every unknown is an abstention, never a silent pass
// ---------------------------------------------------------------------------
abstains(
  checkPendingMigrations({ ...INCIDENT, name: "fix_save_job_comment_refusal_count" }),
  "no 14-digit timestamp", "an untimestamped candidate must abstain, not pass");

abstains(
  checkPendingMigrations({ ...INCIDENT, trackedFiles: [] }),
  "could not be read", "an empty tracked set must abstain, not pass");

abstains(
  checkPendingMigrations({ ...INCIDENT, trackedFiles: null }),
  "could not be read", "a missing tracked set must abstain, not pass");

abstains(
  checkPendingMigrations({ ...INCIDENT, baselineHighWater: undefined }),
  "high-water is missing", "a missing baseline high-water must abstain, not pass");

abstains(
  checkPendingMigrations({ ...INCIDENT, baselineHighWater: "not-a-version" }),
  "high-water is missing", "a malformed baseline high-water must abstain, not pass");

abstains(
  checkPendingMigrations({ ...INCIDENT, appliedNames: ["legacy_name_with_no_stamp"] }),
  "no applied migration carries", "an unstampable applied set must abstain, not pass");

// A post-baseline file with no stamp cannot be ordered against anything. It must
// not be silently skipped — skipping is how a pending migration goes unseen.
abstains(
  checkPendingMigrations({
    ...INCIDENT,
    trackedFiles: [...INCIDENT.trackedFiles, "supabase/migrations/undated_hotfix.sql"],
  }),
  "carry no 14-digit", "an unstamped tracked file must abstain, not be skipped");

console.log(`migration-pending-lib.test.mjs: ${pass} assertions passed`);

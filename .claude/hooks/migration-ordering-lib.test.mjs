#!/usr/bin/env node
// Tests for the migration ordering preflight (docs/audits/2026-08-08-foundation-ultra-review.md §2).
//
// The central case is the real 2026-07-15 revert: an OLDER file applied after a
// newer one silently discarded a security guard. The second-most important case
// is the false positive that the first draft of this module had — comparing
// against files on disk instead of the applied ledger, which both Codex and
// CodeRabbit caught on PR #348 and which would have blocked a correct ascending
// batch of new migrations.

import assert from "node:assert/strict";
import {
  normalizeMigrationName,
  migrationTimestamp,
  hasIntentionalReplayMarker,
  checkMigrationOrdering,
} from "./migration-ordering-lib.mjs";

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  void label;
}

// ---------------------------------------------------------------------------
// normalizeMigrationName — the "B7 class" ledger-name variants
// ---------------------------------------------------------------------------
check("strips a path", () => {
  assert.equal(
    normalizeMigrationName("supabase/migrations/20260714220000_hardening.sql"),
    "20260714220000_hardening"
  );
});

check("strips .sql", () => {
  assert.equal(normalizeMigrationName("20260714220000_hardening.sql"), "20260714220000_hardening");
});

check("collapses the doubled version prefix from the real revert row", () => {
  // The exact shape recorded on 2026-07-15.
  assert.equal(
    normalizeMigrationName("20260715134618_20260714185130_gate_batch_prepay_admin"),
    "20260714185130_gate_batch_prepay_admin"
  );
});

check("handles empty and nullish input", () => {
  assert.equal(normalizeMigrationName(""), "");
  assert.equal(normalizeMigrationName(null), "");
  assert.equal(normalizeMigrationName(undefined), "");
});

check("reads the timestamp through the doubled prefix", () => {
  // Must resolve to the FILE's own timestamp, not the ledger version that
  // wrapped it — reading the wrapper is what makes a replay look forward.
  assert.equal(
    migrationTimestamp("20260715134618_20260714185130_gate_batch_prepay_admin"),
    "20260714185130"
  );
});

check("returns null when there is no timestamp", () => {
  assert.equal(migrationTimestamp("ad_hoc_fix"), null);
});

check("keeps the version timestamp for a ledger name that has none of its own", () => {
  // Many real ledger rows carry a timestamp-less name, e.g. version
  // 20260727174805 / name deactivation_revokes_auth_access. The refresh script
  // re-attaches the version as a prefix; that shape must NOT be collapsed away
  // (the collapse rule only fires on <ts>_<ts>_...), or the row silently stops
  // constraining ordering. Codex P1, PR #348.
  const joined = "20260727174805_deactivation_revokes_auth_access";
  assert.equal(migrationTimestamp(joined), "20260727174805");
  assert.equal(normalizeMigrationName(joined), joined);
});

check("a timestamp-less applied row still blocks an older migration once versioned", () => {
  const res = checkMigrationOrdering({
    name: "20260714185130_gate_batch_prepay_admin",
    sql: "SELECT 1;",
    appliedNames: ["20260727174805_deactivation_revokes_auth_access"],
  });
  assert.equal(res.ok, false);
  assert.equal(res.newestApplied, "20260727174805");
});

// ---------------------------------------------------------------------------
// The replay marker
// ---------------------------------------------------------------------------
check("marker requires a substantive reason", () => {
  assert.equal(hasIntentionalReplayMarker("-- ordering-guard: intentional-replay ok").marked, false);
  assert.equal(
    hasIntentionalReplayMarker("-- ordering-guard: intentional-replay restoring a dropped index").marked,
    true
  );
});

check("no marker at all is not marked", () => {
  assert.equal(hasIntentionalReplayMarker("SELECT 1;").marked, false);
  assert.equal(hasIntentionalReplayMarker("").marked, false);
});

// ---------------------------------------------------------------------------
// The defect this exists to prevent
// ---------------------------------------------------------------------------
check("BLOCKS the real 2026-07-15 out-of-order replay", () => {
  const res = checkMigrationOrdering({
    name: "20260714185130_gate_batch_prepay_admin",
    sql: "CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(...)",
    appliedNames: ["20260714220000_shared_idempotency_and_hold_hardening"],
  });
  assert.equal(res.ok, false);
  assert.equal(res.timestamp, "20260714185130");
  assert.equal(res.newestApplied, "20260714220000");
  assert.match(res.reason, /FORWARD-ONLY/);
});

check("an explicit marked replay is allowed through", () => {
  const res = checkMigrationOrdering({
    name: "20260714185130_gate_batch_prepay_admin",
    sql: "-- ordering-guard: intentional-replay restoring an index dropped by hand\nSELECT 1;",
    appliedNames: ["20260714220000_shared_idempotency_and_hold_hardening"],
  });
  assert.equal(res.ok, true);
  assert.match(res.reason, /intentional replay/);
});

// ---------------------------------------------------------------------------
// The false positive the first draft had (Codex + CodeRabbit, PR #348)
// ---------------------------------------------------------------------------
check("does NOT block a correct ascending batch of NEW migrations", () => {
  // All four of the 2026-08-08 migrations exist on disk, and NONE is applied.
  // Applying the earliest one first must be allowed — the disk-based first
  // draft refused this, which would have blocked its own sibling migrations.
  const applied = ["20260807220323_log_customer_fact_rpc"];
  for (const name of [
    "20260808150100_restore_batch_apply_prepayments_actor_guard",
    "20260808150200_cancel_order_zeroes_quantity_remaining",
    "20260808150300_revoke_inventory_truncate_and_mark_payments_dead",
    "20260808150400_round_money_to_whole_cents",
  ]) {
    const res = checkMigrationOrdering({ name, sql: "SELECT 1;", appliedNames: applied });
    assert.equal(res.ok, true, `${name} must be allowed`);
    applied.push(name); // as it would be, once applied
  }
});

check("abstains when the applied ledger is unknown", () => {
  // No snapshot must never be read as a pass on the merits.
  for (const appliedNames of [[], null, undefined]) {
    const res = checkMigrationOrdering({
      name: "20260101000000_anything",
      sql: "SELECT 1;",
      appliedNames,
    });
    assert.equal(res.ok, true);
    assert.equal(res.abstained, true);
  }
});

check("abstains when applied rows carry no parseable timestamp", () => {
  // The library abstains; the APPLY GUARD is what turns this into a block. Pinned
  // here so the two halves of that contract stay honest about which is which.
  const res = checkMigrationOrdering({
    name: "20260101000000_anything",
    sql: "SELECT 1;",
    appliedNames: ["deactivation_revokes_auth_access", "initial_schema"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.abstained, true);
});

check("abstains on a name with no timestamp", () => {
  const res = checkMigrationOrdering({
    name: "ad_hoc",
    sql: "SELECT 1;",
    appliedNames: ["20260808150400_round_money_to_whole_cents"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.abstained, true);
});

check("re-applying the newest applied migration is not an ordering violation", () => {
  // Same-timestamp re-apply is an idempotency question, not an ordering one.
  const res = checkMigrationOrdering({
    name: "20260808150400_round_money_to_whole_cents",
    sql: "SELECT 1;",
    appliedNames: ["20260808150400_round_money_to_whole_cents"],
  });
  assert.equal(res.ok, true);
});

check("compares against applied names carrying ledger-format noise", () => {
  // The applied side must normalize too, or the real revert row reads as
  // version 20260715134618 and the replay slips through as "forward".
  const res = checkMigrationOrdering({
    name: "20260714185130_gate_batch_prepay_admin.sql",
    sql: "SELECT 1;",
    appliedNames: ["supabase/migrations/20260714220000_shared_idempotency_and_hold_hardening.sql"],
  });
  assert.equal(res.ok, false);
});

console.log(`migration-ordering-lib: ${passed} assertions passed`);

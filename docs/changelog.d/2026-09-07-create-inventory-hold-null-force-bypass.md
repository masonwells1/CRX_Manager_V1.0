## 2026-09-07 — NULL `p_force` bypassed the admin contract AND the capacity guard on `create_inventory_hold`

An independent `gpt-5.6-sol` high-effort review of PR #624 returned `BLOCKERS` with one HIGH
finding. It was verified against the real source and then against a real PostgreSQL container,
and it is real.

### The defect

`20260908130000_bind_create_inventory_hold_receipt_to_intent.sql` fingerprinted
`COALESCE(p_force, false)` but passed the **raw nullable `p_force`** to the wrapped body. That
body (the live pre-20260905 hold body, unchanged) tests the flag with bare `IF p_force` and
`AND NOT p_force`. SQL three-valued logic makes an explicit NULL invisible to both:

- `IF p_force THEN` → `IF NULL` takes the ELSE path, so `FORCE_REQUIRES_ADMIN` and
  `FORCE_REQUIRES_REASON` never fire.
- `IF v_todays_free - p_quantity < 0 AND NOT p_force` → `true AND NULL` is NULL, not true, so
  `INSUFFICIENT_HOLD_INVENTORY` never raises.
- `CASE WHEN p_force THEN 'WARNING: Hold created with admin override (…)'` → falls to the plain
  `'Hold created'` message, so the override leaves no trace in the activity feed.

An active sales rep posting `p_force: null` could therefore book an **unlimited over-capacity
hold** with no admin authorization, no force reason, and no audit warning. Separately, the
`COALESCE` in the fingerprint made `null` and `false` collapse to the same receipt even though
they behaved differently — a request that forces and a request that does not would have shared
one idempotency key.

**This hole is pre-existing on live.** It is in the production body today; the candidate did not
introduce it. What the candidate did was carry it forward while adding a security wrapper around
it. Applying this migration now *closes* it, because the rename makes the impl `postgres`-only
and the wrapper becomes the only entrypoint `authenticated` can reach.

### The fix

Normalize once in the wrapper and read the normalized value at both consumers:
`v_force boolean := COALESCE(p_force, false)`, used for the fingerprint and for the delegated
call. The wrapped body is not edited. A new `POSTFLIGHT_FORCE_NORMALIZATION` assertion fails the
apply if either consumer ever goes back to reading raw `p_force`.

### Proof observed — by execution, not assertion

Three container runs of
`scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs` (network-disabled
PostgreSQL 17 built from the 2026-07-27 production baseline plus 76 replayed migrations):

1. **Fix in place** — `CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS`,
   `pre_chain=FAIL pre_race=1_hold_loser_errors legacy_receipt=REFUSED post_chain=PASS
   post_race=1_hold_loser_replays rerun=PASS`.
2. **Raw delegation restored, postflight left in place** — the apply itself aborts with
   `POSTFLIGHT_…: create_inventory_hold does not normalize p_force before fingerprinting and
   delegating`. The new assertion is load-bearing.
3. **Raw delegation restored AND postflight neutered** — the chain reaches the new smoke case and
   fails with `SMOKE_FAIL: NULL force was accepted -- the rep booked an over-capacity hold`. This
   is the run that proves the vulnerability is genuinely exploitable on real schema and that the
   new test detects it rather than passing vacuously.

Also: the new smoke case asserts a NULL-force call leaves no hold, no receipt, and zero
`WARNING: Hold created with admin override%` activity rows. Static mutation tests in
`src/lib/createInventoryHoldIntentBinding.test.ts` cover the declaration, both consumers and the
postflight. Full suite and typecheck re-run after the change.

### Not verified

The live apply and everything downstream of it. The migration is still **NOT applied**. The
2026-09-06 read-only production preflight predates this edit — the pinned live-body md5 and
argument list are untouched by it, since only the new wrapper body changed, but the preflight
must be re-read immediately before any apply regardless.

## 2026-09-05 - Serialize create_inventory_hold on its idempotency key (local candidate, NOT applied)

**What changed.** New migration `supabase/migrations/20260905210000_bind_create_inventory_hold_receipt_to_intent.sql`,
a LOCAL CANDIDATE that has NOT been applied live and is NOT merged. It renames the live
`create_inventory_hold` body to `_create_inventory_hold_intent_impl_20260905` (executable only by
`postgres`) and installs a same-signature public wrapper that: requires a signed-in caller and refuses a
forged `p_performed_by`; gates on an ACTIVE admin/sales_rep profile with a NULL-safe predicate (the live
body's `v_role NOT IN (...)` let a caller with no profile row through); REQUIRES `p_idempotency_key`;
fingerprints the request (product, customer, quantity, hold type, expiry, notes, force, force reason);
calls `check_idempotency_intent`, which takes the per-key advisory lock BEFORE any mutation and either
replays the bound receipt or refuses a changed request / other actor / pre-migration receipt; then calls
the renamed body and binds the receipt to the actor and fingerprint.

**Reviewer-driven hardening (same day).** The security reviewer found no blockers but two HIGH items, both
fixed: the preflight now REFUSES to apply (`PREFLIGHT_LEGACY_RECEIPTS`) while any unexpired receipt written
by the old body still exists, instead of only printing a notice, because after the swap such a receipt
would lock its operator out of creating any hold for up to 24 hours and would disclose the committed
result before the actor check. This is the same rule the section-9 receiving wrapper uses. Both preflight
and postflight now also pin the full argument list INCLUDING DEFAULTS (the body hash cannot see defaults),
the helper checks run before the hash so a missing helper is named, and the postflight asserts that
`check_idempotency_intent` itself is still not executable by anon, authenticated or service_role. The drift
reviewer found no blockers and recomputed both pinned body hashes as exact against the production dump.

**Why.** The Codex push-proof for the inventory frozen-retry branch reported a HIGH: the live body reads its
receipt with a plain SELECT before the stock lock and writes it after the hold with ON CONFLICT DO NOTHING,
so two overlapping same-key calls both insert. Measured on the real schema, the live BEFORE INSERT
receipt guard (20260714230000 / 20260716160000) rolls the loser back with
`IDEMPOTENCY_CONCURRENT_REPLAY_RETRY`, so the table ends with ONE hold, but the losing caller is told its
hold FAILED although the winner created exactly that hold. A browser that reads that as a definitive
refusal releases its key, and the next click mints a new key and a second hold. After this migration the
loser waits and replays the winner's receipt: one hold, both callers get the same `hold_id`.

**Also in this change.** `src/lib/sqlRoleGateNullFailOpen.test.ts` drops the `create_inventory_hold|v_role`
allowlist entry (its comment claimed the parked_010 body was never applied; the 2026-07-27 production
schema dump proves it IS live, body sha256 `3c86421e…`). New contract test
`src/lib/createInventoryHoldIntentBinding.test.ts` (guard order, ACLs, pins; 20 mutation-negatives). New
rolled-back chain `scripts/smoke/smoke-create-inventory-hold-intent-binding.sql`, new real-schema prover
`scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs`, and a `create_inventory_hold`
spec in `scripts/smoke/smoke-specs.json`. Docs: `docs/reference/rpc-functions.md`,
`docs/reference/migration-history.md` row 917, `docs/workflows/INVENTORY_RULES.md`.

**Proof observed.** `node scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs` in a
network-disabled Supabase PostgreSQL 17 container built from the checked-in 2026-07-27 baseline plus all 75
later migrations: baseline body sha256 matches the pin; the chain FAILS against the live body; a
two-session same-key race against the live body leaves 1 hold with the loser erroring
`IDEMPOTENCY_CONCURRENT_REPLAY_RETRY`; with that winner's unbound receipt still live the candidate REFUSES
(`PREFLIGHT_LEGACY_RECEIPTS: 1 …`) and leaves the live body and catalog untouched; after the receipt is
expired the candidate applies; the chain passes (`SMOKE_PASS_ROLLBACK`); the same race leaves 1 hold, both
sessions succeed with the same `hold_id`, the receipt is bound to the actor; the candidate re-applies
cleanly. Printed
`CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS pre_chain=FAIL pre_race=1_hold_loser_errors legacy_receipt=REFUSED post_chain=PASS post_race=1_hold_loser_replays rerun=PASS`.
Full vitest suite (353 files), typecheck, and build pass.

**Not verified.** Nothing ran against production. The installed live body was NOT re-read from the live
database in this session; the pin rests on the checked-in production dump and the baseline ledger. The
preflight fails closed if the live body hash or argument list differs from the pins, or if any unexpired
pre-migration hold receipt exists (apply in a quiet window). The manual docs' "Last verified" stamps were
deliberately not bumped for the same reason, so the doc-drift freshness rows stay red on this branch until
a read-only live check is approved. The apply itself, the post-apply
invariant sweeps, and the browser flow against the applied wrapper remain to be done after Mason approves
the apply.

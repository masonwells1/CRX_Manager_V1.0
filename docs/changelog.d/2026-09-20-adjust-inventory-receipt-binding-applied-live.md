## 2026-09-20 — `adjust_inventory` receipt binding APPLIED LIVE

`supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql` was applied to
production (`rhyzpcqhnizqbxphqdkr`) on Mason's explicit in-chat approval ("apply 727"), closing
**CRX-IDEM-01**. Live ledger version `20260920052149`; ledger went 1003 → 1004 rows.

### What it closes

The live `adjust_inventory` read its idempotency receipt FIRST — before `auth.uid()`, before the
`p_performed_by` check, and before the admin-role check. Any caller holding an unexpired adjustment
key was handed that adjustment's `product_id` and `new_quantity` whatever their role. No new stock
change was reachable that way; it was a read of someone else's result.

It also refuses NULL/NaN/infinite deltas (`INVALID_ADJUSTMENT_QUANTITY`). PostgreSQL sorts NaN above
every number, so the old body's `p_delta = 0` and `v_new_qty < 0` checks both passed a NaN, which
was then written into `inventory.quantity_available` — a column with no CHECK constraint.

### Gates, in order

- Exact-SHA `gpt-5.6-sol`/high review of the candidate: **CLEAN**, no blocker or high-severity
  findings (verified by exact-match on the terminal verdict token, not the exit code).
- `scripts/write-apply-proofs.mjs`: **both** charters CLEAN — `rls-security-reviewer` and
  `migration-drift-reviewer`, each with a `tokens used` run marker proving Codex actually ran.
- Ordering snapshot refreshed to the live 1003 names in this worktree first; the gate abstains
  without it, and the primary checkout's copy was 4 rows stale (999, captured 2026-09-05).
- `scripts/apply-migration-file.mjs --confirm`, queryHash `f309ad89…`, whole file in one
  transaction. HTTP 201.

### Preflight observed immediately before the apply

Migration absent from the live ledger by name; the intent binding absent from the installed body;
the cutover trigger absent; and **ZERO** unexpired or NULL-expiry unbound `adjust_inventory`
receipts — the `PREFLIGHT_LEGACY_RECEIPTS` abort condition was clear.

### Postflight — read from the live catalog, NOT from `APPLY OK — HTTP 201`

Ledger row present; exactly ONE `adjust_inventory` overload; owner `postgres`; SECURITY DEFINER;
`search_path=public, pg_temp`; body carries `check_idempotency_intent`, `request_fingerprint` and
`INVALID_ADJUSTMENT_QUANTITY`; **`INSUFFICIENT_ROLE` precedes `check_idempotency_intent` in
`prosrc`** — the ordering that is the whole point of the change; ACL anon `false`, authenticated
`true`, service_role `true`; trigger `refuse_unbound_adjust_inventory_receipt_20260911` enabled,
`tgtype=7` (BEFORE INSERT FOR EACH ROW) on `idempotency_keys`; `check_idempotency_intent` still not
executable by anon.

### Cutover residual

The known gap is a keyless old-body call during the apply, which touches neither the lock nor the
trigger. The documented detection check found **ZERO** `adjusted` `inventory_transactions` rows and
ZERO `adjust_inventory` receipts of either kind in the apply window, so it did not trigger. Nothing
to inspect.

### Documentation corrected in the same change

- `docs/reference/migration-history.md` row 929 → APPLIED, with the ledger version and the
  postflight evidence; the ordering note near the top no longer calls `20260911120000` pending.
- `docs/reference/rpc-functions.md` → the live `adjust_inventory` contract, with the old
  replay-on-key-alone behaviour recorded as history.
- `docs/manual/CURRENT_STATE.md` → the 09-14 "none of these is applied" reading is now superseded
  twice, and the ledger boundary moved.
- `src/hooks/useUnresolvedIntent.ts` (comments only) — it asserted, from a 2026-09-08 live reading,
  that `adjust_inventory`, `create_inventory_hold` and `save_blend_recipe` all "really do replay on
  the key alone". Re-read live on 2026-09-20: the first two now bind actor + fingerprint; only
  `save_blend_recipe` still does. The guard is still required for all three — a NEW key sidesteps
  the binding entirely, because the binding only compares requests arriving under the SAME key.

### Flagged, NOT fixed here — stale "replays on the key alone" comments elsewhere

The apply makes that phrase false for `adjust_inventory` wherever it still appears. Corrected in
`src/hooks/useUnresolvedIntent.ts` (two places — the header contract note and the double-apply
rationale at the `acknowledgement escape` block, the second caught by CodeRabbit after the first was
fixed alone). Still stale, and deliberately left to their owning lane rather than widened into here:

- `src/components/inventory/BatchAdjustModal.tsx` (~L62)
- `src/hooks/useUncertainMutationIntent.test.ts` (~L742, ~L1146)
- `src/components/inventory/BatchAdjustModal.retry.test.tsx` (~L74)
- `src/lib/gauntletFrontendSafetyGuards.test.ts` (~L208)
- `src/components/integrity/IntegrityCleanupPanel.tsx` (~L110) — confirm which RPC it means first

Row 930 records this wording as owned by PR #624, which rewrites those files. Their test assertions
still pass, so this is comment drift rather than a behavioural break — but the comments now describe
a server contract that changed underneath them.

### Fleet parser: an applied migration was being reported as pending

Codex raised this on delivery 8 and it verified. `.claude/hooks/worktree-awareness-lib.mjs`
(`localCandidateMigrationPathsFromHistory`, the `LOCAL CANDIDATE … NOT APPLIED` matcher) reads the
history row's status token literally, and that library deliberately has **no** settled-detector — PR
#437 tried twice to add one and was blocked both times, so the status token is the only thing that
can retire a row. Row 929's `20260908140000_number_generators_year_chicago` still carried the pending
wording after applying live at ledger version `20260920051333`, so fleet and worktree checks counted
it as parked work.

Proven by running the real parser against the real `migration-history.md`: **9** rows classified
pending, one of them an applied migration. After settling row 929's status token: **8** rows, zero
false pendings. The first attempt at that edit still failed the probe, because the explanatory prose
quoted the old pending wording inside the same cell and the matcher fired on the quotation — the
retiring edit must not restate it anywhere in the row.

### Not verified

No UI exercise of an adjustment against production; the postflight is catalog-level plus the
rolled-back smoke chain. The migration file itself was not edited, per the standing rule that an
applied migration's bytes — including its header — stay exactly as reviewed.

### Rollback

A NEW forward migration that re-emits the pinned previous body AND drops
`refuse_unbound_adjust_inventory_receipt_20260911`. Restoring the body while leaving the trigger
would fail every keyed adjustment closed, because `save_idempotency` writes unbound receipts.

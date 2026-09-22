## 2026-09-21 — two parked commission migrations refuse a surviving legacy transfer overload by name

**What changed.** Two LOCAL CANDIDATE migrations that replace
`public.transfer_job_to_invoice(uuid, uuid, text)` now each run a named check, after their lock
statements and before their existing preflight:

- `supabase/migrations/20260914100500_commission_dates_follow_chicago_business_day.sql` raises
  `PREFLIGHT_LEGACY_OVERLOAD`.
- `supabase/migrations/20260914100800_bind_transfer_invoice_intent.sql` raises
  `TRANSFER_INVOICE_INTENT_PREFLIGHT: legacy transfer_job_to_invoice(uuid, uuid) overload is present`.

Each check refuses the apply if the legacy `(uuid, uuid)` overload exists and leaves that function
untouched. Neither file drops it. On live the check passes:
`20260515999999_drop_legacy_transfer_job_to_invoice_overload` removed that overload in May, and a
read-only `pg_proc` query on 2026-09-21 found exactly one `public.transfer_job_to_invoice`, the
`(uuid, uuid, text)` signature.

**Why.** Before the planned live apply, the exact-file `gpt-5.6-sol` high `migration-drift-reviewer`
returned BLOCKERS on both files: the historical `(uuid, uuid)` overload was not handled. Each file
already refused any extra overload through its generic overload count, but did not name this one.
A first fix on this branch added `DROP FUNCTION IF EXISTS public.transfer_job_to_invoice(uuid, uuid)`.
The `gpt-5.6-luna` xhigh review then found that an unconditional drop turns a drift refusal into a
silent deletion of a function whose owner, body and grants are unknown. The drop was replaced by the
named refusal. A surviving copy is left for a human to inspect.

**Also.** `scripts/smoke/prove-commission-migration-plan-order.mjs` pinned the live ordering
high-water at `20260908120000_close_pr535_live_gaps` (read 2026-09-13). Live moved to
`20260911120000_bind_adjust_inventory_receipt_to_intent` on 2026-09-20, so the pin is updated to that
2026-09-21 live read. The cohort already sorts above it, so nothing is restamped.

**Live state when this was written.** Mason approved applying `20260914100100`–`20260914100600` in
this session. Four were applied live on 2026-09-21 and verified from the live catalog:

| File | Ledger version |
|---|---|
| `20260914100100_next_invoice_number_year_chicago` | `20260921141423` |
| `20260914100200_commission_history_report_replay_guard` | `20260921141451` |
| `20260914100300_refuse_stale_commission_payment_recipient` | `20260921141740` |
| `20260914100400_enforce_commission_payment_business_date` | `20260921141901` |

`20260914100500`, `20260914100600`, `20260914100800` and `20260914100900` are **not applied**. This
change marks the four applied rows in `docs/reference/migration-history.md` as applied live. The
boundary block, `CURRENT_STATE.md`, `KNOWN_ISSUES.md`, the schema registry and the
`LIVE_HIGH_WATER_ROW` pin in `scripts/smoke/prove-commission-migration-plan-order.mjs` are updated in
one records change once the cohort finishes.

**Proof observed.**

- `node scripts/smoke/prove-transfer-invoice-intent-binding.mjs` → `TRANSFER_INVOICE_INTENT_BINDING_PROOF_PASS`
  (disposable PostgreSQL 17, the real edited `20260914100800`). A new case plants the legacy
  overload and asserts the apply refuses with the named message and leaves the overload in place.
  Deleting only the named check from the file makes that case fail: the generic count refuses
  instead, with `transfer function overload drift detected`.
- The exact named-check block from `20260914100500`, run in a disposable PostgreSQL 17: it passes
  with only the three-argument function present, and refuses with `PREFLIGHT_LEGACY_OVERLOAD` when
  the two-argument overload is planted, which survives the refusal.
- `node scripts/smoke/prove-transfer-invoice-intent-binding-static.mjs` → `TRANSFER_INVOICE_INTENT_STATIC_PROOF_PASS`.
- `node scripts/smoke/prove-commission-dates-chicago.mjs` and
  `node scripts/smoke/prove-document-dates-chicago.mjs` → `ALL PHASES PASSED` (the real edited
  `20260914100500`).

**Not verified.** Neither edited file has been applied anywhere but disposable containers.

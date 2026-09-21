## 2026-09-21 — the parked Chicago-date cutover also drops the legacy two-argument transfer overload explicitly

**What changed.** `supabase/migrations/20260914100500_commission_dates_follow_chicago_business_day.sql`
(still a LOCAL CANDIDATE, not applied live) gains one statement after its writer-drain locks and
before its first preflight:

```sql
DROP FUNCTION IF EXISTS public.transfer_job_to_invoice(uuid, uuid);
```

This is the same statement, for the same reason, that
`docs/changelog.d/2026-09-21-transfer-intent-explicit-legacy-overload-drop.md` added to
`20260914100800`. `20260914100500` is the file that first replaces
`transfer_job_to_invoice(uuid, uuid, text)` in the cohort. The exact-file `gpt-5.6-sol` high
`migration-drift-reviewer` returned BLOCKERS on it twice on 2026-09-21 (14:2x and 14:34Z): the
historical `(uuid, uuid)` overload "is not dropped" before this replacement. The same charter had
returned CLEAN on these exact bytes earlier that day, so its verdict on this point is not stable.

The claim is false on the facts, exactly as for `20260914100800`.
`20260515999999_drop_legacy_transfer_job_to_invoice_overload` removed that overload in May. A
read-only live `pg_proc` query on 2026-09-21 returns exactly one public `transfer_job_to_invoice`,
the `(uuid, uuid, text)` signature, with body md5 `78b827f8509a2740ea9879364747c372`, the exact
preimage this file expects. The file's own preflight (`PREFLIGHT_OVERLOAD ... refusing to guess
which carries the date`) already refuses unless exactly one overload exists. On live the new
statement is a no-op. The preflight still refuses any other extra overload of each coordinated
writer.

The apply gate needs a CLEAN machine verdict and must not be self-certified. The rule used for
`20260914100800` was applied again: one re-check, then fix rather than keep re-running.

**Also in this change.** `scripts/smoke/prove-transfer-invoice-intent-binding.mjs` gains a positive
case. It plants a legacy `(uuid, uuid)` overload immediately before the successful cutover apply,
then asserts the apply exits 0, the overload is gone, and exactly one public overload remains. The
case was mutation-checked: deleting only the `DROP` line from `20260914100800` makes that apply fail
with `TRANSFER_INVOICE_INTENT_PREFLIGHT: transfer function overload drift detected`. CodeRabbit had
raised that ordering concern on PR #753, then withdrew it after re-checking the statement order and
the mutation result.

**Live state when this was written.** Mason approved applying `20260914100100`–`20260914100600` in
this session. Four were applied live on 2026-09-21 and each was verified from the live catalog:

| File | Ledger version |
|---|---|
| `20260914100100_next_invoice_number_year_chicago` | `20260921141423` |
| `20260914100200_commission_history_report_replay_guard` | `20260921141451` |
| `20260914100300_refuse_stale_commission_payment_recipient` | `20260921141740` |
| `20260914100400_enforce_commission_payment_business_date` | `20260921141901` |

The apply stopped before `20260914100500` because of the BLOCKER above. `20260914100500`,
`20260914100600`, `20260914100800` and `20260914100900` are **not applied**. The
migration-history rows, the boundary block, `CURRENT_STATE.md`, `KNOWN_ISSUES.md` and the schema
registry are updated in one records change once the cohort finishes, against the final live state.
Until then, re-read the live ledger by name before any apply, as the repository already requires.

**Proof observed.**

- `node scripts/smoke/prove-commission-dates-chicago.mjs` → `ALL PHASES PASSED` (disposable
  PostgreSQL 17, the real edited file).
- `node scripts/smoke/prove-document-dates-chicago.mjs` → `ALL PHASES PASSED` (disposable
  PostgreSQL 17, the real edited file).
- `node scripts/smoke/prove-transfer-invoice-intent-binding-static.mjs` → `TRANSFER_INVOICE_INTENT_STATIC_PROOF_PASS`.
- `node scripts/smoke/prove-transfer-invoice-intent-binding.mjs`, with the new planted-overload case,
  → `TRANSFER_INVOICE_INTENT_BINDING_PROOF_PASS`. It fails as designed with the `100800` `DROP`
  removed.

**Not verified.** Neither edited file has been applied anywhere but disposable containers. Each
still needs a fresh CLEAN apply proof and runs only under Mason's in-chat approval.

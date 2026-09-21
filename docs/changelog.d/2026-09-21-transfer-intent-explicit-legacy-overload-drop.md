## 2026-09-21 — the parked transfer-intent wrapper now drops the legacy two-argument overload explicitly

**What changed.** `supabase/migrations/20260914100800_bind_transfer_invoice_intent.sql` (still a
LOCAL CANDIDATE, not applied live) gains one statement between its `idempotency_keys` lock and its
preflight:

```sql
DROP FUNCTION IF EXISTS public.transfer_job_to_invoice(uuid, uuid);
```

On live this does nothing. `20260515999999_drop_legacy_transfer_job_to_invoice_overload` removed
that overload in May, and a read-only `pg_proc` query on 2026-09-21 found exactly one
`public.transfer_job_to_invoice`, the `(uuid, uuid, text)` signature. The preflight still counts
exactly one public overload afterward, so any other extra overload still refuses the apply.

**Why.** Before the planned live apply of the commission cohort, the exact-file
`gpt-5.6-sol` high `migration-drift-reviewer` charter (run by `scripts/write-apply-proofs.mjs`)
returned BLOCKERS on two independent runs with the same claim: the historical `(uuid, uuid)`
overload is never dropped, so it "could continue resolving" two-argument calls. That claim is false
against the corpus and against live (above). The reviewer inspects files that declare the function
and did not credit the separate May drop. The apply gate needs a CLEAN machine verdict and must not
be self-certified or re-run until it passes. Stating the removal in the file that replaces the
function answers the finding without changing live behaviour, so it was fixed rather than argued.
The `rls-security-reviewer` charter returned CLEAN on both runs.

**Also.** `scripts/smoke/prove-commission-migration-plan-order.mjs` pinned the live ordering
high-water at `20260908120000_close_pr535_live_gaps` (read 2026-09-13). Live moved to
`20260911120000_bind_adjust_inventory_receipt_to_intent` on 2026-09-20, so with a fresh local
snapshot the prover's equality assertion failed. It told us to re-read live, and that was done. The
pin is updated to the 2026-09-21 live read (1004 rows / 997 names, `max(version)` `20260920052149`).
The cohort already sorts above it, so nothing is restamped.

**Proof observed.**

- `node scripts/smoke/prove-transfer-invoice-intent-binding-static.mjs` → `TRANSFER_INVOICE_INTENT_STATIC_PROOF_PASS`.
- `node scripts/smoke/prove-transfer-invoice-intent-binding.mjs` → `TRANSFER_INVOICE_INTENT_BINDING_PROOF_PASS`
  (disposable PostgreSQL 17, `--network none`, applying the real edited file). Its existing
  falsification mutant that plants a four-argument overload is still refused with
  `transfer function overload drift detected`.
- `node scripts/smoke/prove-commission-migration-plan-order.mjs` →
  `COMMISSION_MIGRATION_PLAN_ORDER_PROOF_PASS postgres=17 parked=7 ... tail=applies` and
  `COMMISSION_HISTORY_PROOF_PASS postgres=17 ... replayed=79`, a PostgreSQL 17 replay of the whole
  parked plan including the edited file.
- A disposable PostgreSQL 17.10 check of the statement itself: with only the defaulted three-argument
  function present, the `DROP` is a no-op and that function survives and still answers. With a stale
  two-argument overload beside it, only the two-argument one is removed, and a two-argument call then
  resolves to the three-argument function through its default.

**Not verified.** Nothing here touched the live database except read-only catalog and ledger
queries. The edited file has not been applied anywhere but disposable containers, and its live apply
still needs fresh proofs and Mason's explicit in-chat approval.

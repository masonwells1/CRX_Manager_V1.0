## 2026-09-14 - Transfer intent guard table gets RLS; reset scanner reads `+++` correctly

PR: #638 (delivery PR after #696)

CodeRabbit's review of delivery PR #696 at `b1f0055b2` raised three findings.

- **Parked migration `20260908130800_bind_transfer_invoice_intent.sql` (not applied).**
  Its autocommit transaction-guard TEMP table now enables Row Level Security with a
  deny-all policy in the same file, matching the rule that every created table carries
  RLS and a policy. The owning migration role is exempt from its own table's RLS, so the
  marker insert still runs, and under autocommit the file still refuses before any
  shared-state change. Proof observed: the disposable PostgreSQL 17 behavioural proof
  (`prove-transfer-invoice-intent-binding.mjs`) and the static proof pass.
- **Test-only reset scanner.** `count+++ /re/` is `count++ + /re/`, but the previous
  postfix rule read the last two operators as postfix and left the regex text visible
  as evidence. Only an exact `++` or `--` now reads as postfix. The new `+++` and `---`
  cases failed first with `expected 'recovery' to be null`; 24/24 after.
- **Smoke fixture products: not changed.** The machine-fee chain is the production
  rollback smoke; it reuses governed catalog products because a directly inserted
  Product has no governed cost basis, and it fails closed with `SMOKE_SETUP` when none
  qualifies. Answered on the #696 thread.

No SQL is applied and no production behaviour changes.

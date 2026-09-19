## 2026-09-14 - Silence a stale job-transfer reconciliation, close a regex-after-division scanner gap, and correct three PR #697 doc claims

Delivery: SOURCE/UI-ONLY. No SQL statement in any migration changed and nothing was applied.

- `src/pages/JobDetail.tsx`: when a Transfer to Invoice result cannot be verified, the
  reconciliation state and its error toast now run only while the operator is still on the
  same job. Before, a result that arrived after moving to another job raised the old job's
  toast over the new one. `setTransferring(false)` still always runs.
- `src/__tests__/idempotency-reset-order.test.ts`: the reset-order scanner read the `/` after a
  division operator as division, so a regex such as `value / /getIdempotencyBindingRejection/`
  stayed visible and could excuse a reset. A division `/` now lets a regex start, while the
  closing `/` of an already-masked regex still reads as the end of an operand.
- `scripts/smoke/prove-commission-migration-plan-order.mjs`: the parked-set size check now
  compares against the parked list itself (7 files) instead of the historical rename list plus one.
- Docs: the 2026-09-08 ledger capture in `docs/reference/migration-history.md` is labelled a
  point-in-time snapshot; row 928 now separates the migration's 5-second lock wait from the
  request's statement timeout, marks the 8-second value as the file's own assumption (no
  independent repo record), and notes the 3-second post-lock budget is unenforced (issue #669);
  the 2026-09-08 changelog names PR #638's delivery PRs without pinning a stale number.

Proof observed: both new tests failed before their fixes (`expected 'recovery' to be null`;
the recovery toast was called after navigating away) and pass after. The four named test
targets passed 78 of 78; typecheck and eslint were clean;
`prove-commission-migration-plan-order.mjs` printed `COMMISSION_MIGRATION_PLAN_ORDER_PROOF_PASS
postgres=17 parked=7`; the transfer static proof and `check-doc-drift.mjs` passed.

## 2026-09-07 — the job-save credit check now survives the post-commit early returns

`JobDetail`'s save handler commits in stages: `save_job` writes the job row, then two
fallible sub-writes follow — the crew/loader `.update()` and the override applicator
assignment. Each has its own catch that toasts `Job created, but …` and RETURNS, precisely
because the row HAS committed and a retry from `/jobs/new` would mint a SECOND job.

`warnIfOverCreditLimit` sat BELOW both of those returns, on the save-success path. So on
either backstop a job was booked for a customer who may be over their credit limit with no
operator warning and — the durable half — no `notifyCreditLimitExceeded` -> `notifyAdmins`
row. A credit control that leaves no trace is absent, not weakened.

**Pre-existing, not a #611 regression.** #611 fixed a DIFFERENT suppression of the same
call (it had gated the success-path check behind a still-on-this-job test). Neither
backstop ever reached the check, on main before #611 either. Both catches deliberately
preserve other post-commit work on the way out — they still write the override audit, still
clear `isDirty`, still move the operator onto the saved job — so this reads as an omission
from that list rather than a trade-off anyone made.

### Change

`src/pages/JobDetail.tsx` — the call moves UP to the commit point, immediately after
`assertRpcResult` confirms `save_job` returned a job id, above every early return. One call
site rather than a copy at each exit: it cannot double-fire and cannot be forgotten when a
third exit is added. Same reasoning as the `notifyDisplacedApplicators` hoist directly
above it, and the shape `QuoteBuilder` already uses. It stays fire-and-forget and stays
UNGATED by `stillOnThisJob()` for the #611 / CRX-ENTITY-003 reason: it touches no page state
and writes a durable row.

Kept **create-only**, deliberately and now commented as such. `check_customer_credit_limit`
sums the customer's UNPAID INVOICES (`supabase/migrations/20260712130000_credit_limit_count_unposted.sql`)
— jobs are not invoices, so an UPDATE cannot change the figure it computes. Running it per
update would mint a duplicate admin notification on every save for an over-limit customer
and train admins to ignore the alert.

No SQL, no migration, no schema change.

### Proof observed

- New test in `src/pages/JobDetail.staleLoad.test.tsx`: the post-commit crew/loader write
  rejects with an FK error, the handler takes the backstop, and the credit RPC plus the
  durable notification still fire exactly once each.
- **Falsified before trusted.** With `src/pages/JobDetail.tsx` reverted to `origin/main`
  and the test kept, the run fails on the credit assertion with the production symptom —
  `check_customer_credit_limit` never called — while the backstop-toast assertion still
  passes, proving the test really travels the early-return path rather than the success path.
- Full suite green after the fix: 356 files, 5065 passed / 123 skipped.
- `tsc --noEmit` clean; `eslint` clean on both changed files; `npm run build` succeeded.

### Not verified

Not exercised against live Supabase — the proof is the mocked page-level path, not a real
over-limit customer in production. The second backstop (the override applicator assignment)
is covered by the same hoist but is not separately tested; both exits are now BELOW the call
site, so neither can reach a state where the check has not already run.

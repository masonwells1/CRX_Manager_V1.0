## 2026-09-03 - Make commission history immutable

- Replaced the unapplied commission report candidate's reads of mutable commission and payment
  state with append-only earned-state snapshots and signed post/void settlement events, stored as
  bigint cents with frozen reconciliation labels.
- Preserved paid cash independently from current earned state, including an explicit negative
  outstanding balance when a later cancellation or soft deletion removes the earning.
- Added RLS, private database-owned recorders, RESTRICT lineage, immutable update/delete/truncate
  guards, exact replay checks, and fail-closed ACL/policy/trigger postconditions for both ledgers.
- Strengthened the rollback proof to verify the real post RPC stamps its fields before any fixture
  manipulation, prove prior-date stability across later changes, and mutation-test the defects
  found by Claude review.

The migration is still a local candidate and has not been applied to production.

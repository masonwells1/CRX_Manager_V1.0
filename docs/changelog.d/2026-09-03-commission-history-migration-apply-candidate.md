## 2026-09-03 - Prepare commission history migration apply candidate

- Isolated the exact ledger-backed commission migration, rollback smoke, proof harness, and
  documentation. The Reports page is already wired to these RPCs, so a live apply changes the
  available date range without requiring a separate frontend release.
- The candidate records dated void/cancellation evidence, stable reporting labels, admin-only
  aggregate/detail RPCs, and a writer-locked cheap-window precondition.

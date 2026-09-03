## 2026-09-03 - Prepare commission history migration apply candidate

- Isolated the exact ledger-backed commission migration, rollback smoke, proof harness, and
  documentation from the held-back frontend so every pre-apply repository guard can remain green.
- The candidate records dated void/cancellation evidence, stable reporting labels, admin-only
  aggregate/detail RPCs, and a writer-locked cheap-window precondition.

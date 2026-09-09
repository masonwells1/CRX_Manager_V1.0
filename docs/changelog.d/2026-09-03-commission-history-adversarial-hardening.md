## 2026-09-03 - Harden the commission history apply proof

- Pin the exact live function bodies before replacement and the exact candidate bodies on replay.
- Refuse partial columns, altered grants, FK/trigger drift, and same-named weakened CHECK constraints.
- Prove the migration lock blocks payment posting, payment-item creation, and commission cancellation
  in concurrent database sessions, and mutation-test a non-conflicting lock mode.

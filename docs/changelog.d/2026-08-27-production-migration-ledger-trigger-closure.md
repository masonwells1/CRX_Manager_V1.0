## 2026-08-27 — Production migration ledger-trigger closure

Exact-commit adversarial review proved that an otherwise definition-only migration could create a
destructive trigger on `supabase_migrations.schema_migrations` and have the wrapper's own guaranteed
ledger insert fire it. The automated path now rejects every trigger statement and every direct
reference to the protected migration schema.

As independent defense in depth, the locked transaction requires the live ledger table to have no
user-defined triggers before candidate SQL and checks the same invariant again immediately before
the ledger insert. Regression coverage includes the exact destructive trigger-function sequence.

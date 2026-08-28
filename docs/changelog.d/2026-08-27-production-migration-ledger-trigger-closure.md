## 2026-08-27 — Production migration ledger-trigger closure

Exact-commit adversarial review proved that an otherwise definition-only migration could create a
destructive trigger on `supabase_migrations.schema_migrations` and have the wrapper's own guaranteed
ledger insert fire it. The automated path now rejects every trigger statement and every direct
reference to the protected migration schema.

As independent defense in depth, the locked transaction requires the exact reviewed global
ledger-order trigger before candidate SQL and immediately before the ledger insert, while rejecting
unexpected or additional user-defined triggers. Regression coverage includes the exact destructive
trigger-function sequence.

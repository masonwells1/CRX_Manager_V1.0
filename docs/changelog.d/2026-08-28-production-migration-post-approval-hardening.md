## 2026-08-28 — Production migration post-approval hardening

The production migration workflow now rechecks the protected `production-database` environment
after Mason's approval and before any production secret is used. Freeze cleanup now retries with
bounded exponential backoff, and batch failures retain Git diagnostics.

The source-only global migration-ledger guard now rejects impossible calendar timestamps. Its
replica-mode proof allocates a valid historical timestamp so the new validation is exercised
without weakening the ordering check. No migration was applied in this change.

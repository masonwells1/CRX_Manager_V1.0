## 2026-09-03 - Harden commission-history final review guards

- Accept PostgreSQL's schema-qualified rendering of the admin-only RLS policy in replay and post-apply drift checks.
- Expand the rollback smoke proof to confirm a rejected pre-order payout leaves no orphan payment header.
- Keep trusted migration reviewers read-only while enabling the restricted native Windows sandbox they need to inspect local migration files.

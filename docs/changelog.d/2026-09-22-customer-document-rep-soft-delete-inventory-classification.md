## 2026-09-22 - soft_delete_customer_document: idempotency inventory classification

PR #766 CI failed `test:contracts`, because the mutator inventory discovered the parked
`soft_delete_customer_document`. The generated types, which reflect live, do not declare it yet.
It is now listed in `MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY`, the bucket for a PR migration that is
not yet live. That bucket's own test proves the migration body really enforces the key. The entry
moves to `MUTATING_RPCS_WITH_IDEMPOTENCY` at the post-apply live type regeneration.

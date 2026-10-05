## 2026-09-22 - soft_delete_customer_document: PR #770 review fix

CodeRabbit (minor, CHANGES_REQUESTED) on the registered chain: it asserted only that
`authenticated` cannot execute `check_idempotency_intent` directly. A stray grant to `anon` or
`service_role` would coexist with that denial, so the chain could pass while the helper's
owner-only ACL was violated. It now checks all three roles.

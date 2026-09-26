## 2026-09-22 - soft_delete_customer_document: PR #771 review fixes

CodeRabbit (CHANGES_REQUESTED) on the changelog record, all three valid:

- **(Major)** The original entry still published the two-argument signature. It now states
  `soft_delete_customer_document(p_document_id uuid, p_customer_id uuid, p_idempotency_key text
  DEFAULT NULL)`, that the customer is required, and that it is bound in both the authorization
  predicate and the idempotency fingerprint.
- **(Major)** The same entry's prerequisite list still named `20260914100450`. It now names
  `20260914100700` (#764's restamp), `20260914100800` and `20260914100900`, and dates the
  `100500`/`100600` applies as 2026-09-22 UTC.
- **(Minor)** The Sol-gate entry announced CLEAN without binding it to a commit. It now names the
  heads it was clean on (`1789c72b3`, then `8069cd45a`) and states plainly that those proofs are
  void for the current head, that a later round changed the signature, and that the gate is still
  required before merge or apply.

No SQL, prover or application code changed in this round.

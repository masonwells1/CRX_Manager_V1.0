## 2026-09-23 - soft_delete_customer_document: PR #776 review fixes

CodeRabbit (CHANGES_REQUESTED), three Minor findings, all valid. This is the only round since the
candidate was written that changed its SQL.

- **The `22023` exception handler was wider than the refusal it exists for.** The wrapper around
  `check_idempotency_intent` catches `SQLSTATE '22023'` and re-raises
  `IDEMPOTENCY_INTENT_MISMATCH` with no DETAIL, because the helper's DETAIL carries the committed
  receipt, which names a document and customer the caller may no longer be allowed to see.
  Catching the whole SQLSTATE would relabel any *other* `22023` the helper might later raise as an
  intent mismatch, presenting an internal fault as a client replay error. The handler now matches
  `SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%'` and re-raises anything else unchanged.

  Read from the **live installed definition** on 2026-09-23 rather than from a migration copy: the
  helper's only `22023` raises are its two `IDEMPOTENCY_INTENT_MISMATCH` branches, and
  `IDEMPOTENCY_ACTOR_MISMATCH` and `IDEMPOTENCY_CROSS_OP_KEY_REUSE` carry no ERRCODE (P0001). So
  this changes no behaviour today; it prevents a future mislabel.

- **`docs/changelog.d/...-review-round6.md`** dated the `20260914100500`/`100600` applies
  2026-09-21. The ledger versions are `20260922015509` and `20260922020038`, so it now says
  2026-09-22 UTC and names them, matching the other records.

- **`docs/manual/CURRENT_STATE.md`** abbreviated two prerequisites as `100800` and `100900`. Apply
  order is load-bearing, so it spells `20260914100800` and `20260914100900` in full.

Proof: the prover re-ran end to end to `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS` against the
edited SQL, including the replay paths the handler governs (same key replays; a different document
raises `INTENT_MISMATCH`; another rep raises `ACTOR_MISMATCH`), the registered chain, and both
mutation tests. `check:docs`, `test:correction-guards`, `lint` and `tsc --noEmit` all pass.
Because the SQL changed, `rls-security-reviewer` and `migration-drift-reviewer` were re-run on the
edited file; their verdicts are recorded with the commit.

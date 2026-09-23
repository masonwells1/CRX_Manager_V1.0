## 2026-09-22 - soft_delete_customer_document: PR #772 review fixes

CodeRabbit (CHANGES_REQUESTED, five Minor findings) on the smoke chain, the prover's skip guard
and two records. All five were valid and all five are fixed; no migration SQL changed.

- **The smoke chain could pass on an empty result.** Every success check used `<>`, and in
  PL/pgSQL `NULL <> x` is NULL, which does not enter the `IF`. A function returning `{}`, a result
  missing `document_id`/`customer_id`, or a row with `deleted_by` NULL would have satisfied the
  chain. All comparisons are now `IS DISTINCT FROM`.
- **The chain's replay check could not detect a rewrite**, although its own comment claimed it
  did. `now()` is fixed for a whole transaction, so a second `UPDATE` inside the chain writes the
  same `deleted_at` and a timestamp comparison cannot distinguish a replay from a rewrite. The
  chain now captures the row's `ctid` after the first call and requires it to be unchanged after
  the replay: an `UPDATE` always writes a new tuple version, so the `ctid` moves even inside one
  transaction. The prover's own step 4 already caught this across committed transactions; the
  registered chain now does too. The replay check also compares the whole receipt object rather
  than one key.
- **The prover's skip guard missed a quoted schema name.** `touchesCustomerDocumentSurface`
  matched `public.customer_documents` but not `"public"."customer_documents"`, so a policy or
  grant added later to the one optionally-skipped migration in that spelling would not have
  forced the skip decision to be re-checked. The schema qualifier is now quotable, and the
  self-test asserts three quoted-schema spellings trip the guard.
- **`docs/manual/CURRENT_STATE.md`** said Remove is restored when `20260921180000` applies. Both
  steps are required: the migration *and* the separate page change. Until the page deploys it
  keeps issuing the direct `UPDATE` the rep's RLS policy refuses. The entry now names both.
- **The PR #767 record dated the `100500`/`100600` applies 2026-09-21.** The ledger versions are
  `20260922015509` and `20260922020038`, so the entry now says 2026-09-22 UTC, and notes that its
  `20260914100450` prerequisite was later corrected to `20260914100700` after #764's restamp.

Proof: the real-schema prover re-ran end to end, including the registered chain and the mutation
test that requires the chain to FAIL when the customer-scope predicate is removed.

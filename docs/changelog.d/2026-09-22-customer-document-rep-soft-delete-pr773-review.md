## 2026-09-22 - soft_delete_customer_document: PR #773 review fixes

CodeRabbit (CHANGES_REQUESTED, two Minor findings), both valid. No migration SQL changed.

- **An unfailable assertion in the prover, the same class as the previous round's two.** Step 9's
  leftover-row check used `filename LIKE '[[]SMOKE]%'`. PostgreSQL `LIKE` treats only `%` and `_`
  as wildcards, so that bracket-class idiom is a LITERAL prefix `[[]SMOKE]` and could never match
  the `[SMOKE]-mine.pdf` rows the chain inserts. The count was always `0`, so "the chain rolled
  back" passed even if rows survived. It now uses `starts_with(filename, '[SMOKE]')`, and a
  preceding self-check asserts the matcher accepts both filenames the chain inserts and rejects a
  non-SMOKE name — so a future rewrite cannot silently return to a pattern that matches nothing.
- **Two KNOWN_ISSUES entries described the same bug.** The 2026-09-21 discovery entry still said
  the fix "belongs in its own change", which is now written and parked. It points at the
  2026-09-22 entry, names the candidate as the design it anticipated, states that Remove needs
  both the migration and the separate page deploy, and says not to track the issue from there.

Proof: the prover re-ran end to end to `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS`, including
the new matcher self-check, the registered chain, and the two mutation tests that require the
chain and step 5 to FAIL when the assignment and customer-scope predicates are removed.

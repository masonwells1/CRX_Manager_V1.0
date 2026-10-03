## 2026-10-02 - soft_delete_customer_document: the ordering hold has lifted

Read-only live ledger check 2026-10-02: all four field-season migrations the hold waited on are
live - `20260914101000` (`20261002201451`), `20260914101100` (`20261002201523`), `20260914101200`
(`20261002201542`) and `20260914101300` (`20261002201609`). The hold Mason set on 2026-09-26 has
therefore lifted, and `20260921180000_soft_delete_customer_document_rpc` now proceeds under the
autonomous-landing rule (CodeRabbit APPROVED on the final head, an exact-SHA `gpt-6-sol` review,
green checks, the migration-apply-guard proofs).

PR #800 merged `main` (#841, #855, #856, #857, #864; no conflicts) and the real-schema prover was
re-run on the result: "ordering-hold predecessors replayed: 4/4", 101 applied post-baseline
migrations replayed, `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS before=rls_refused
fix=rep_removes replay=bound no_new_access=true admin=ok reapply=ok mutation=detected`.
`migration-access-lib.mjs` classifies the file as neither access-changing nor data-rewriting, so it
needs no owner approval. Row 936, its addendum, `KNOWN_ISSUES.md` and `CURRENT_STATE.md` now say
the hold has lifted.

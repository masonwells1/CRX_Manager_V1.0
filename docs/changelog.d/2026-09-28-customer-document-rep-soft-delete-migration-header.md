## 2026-09-28 - soft_delete_customer_document: migration header states the hold and auto-landing gates

The Codex connector on PR #800 (`520970fee`) found that the STATUS line at the top of
`20260921180000_soft_delete_customer_document_rpc.sql` still said the file needed Mason's explicit
in-chat approval to apply. That contradicted his 2026-09-27 decision ("auto is fine"), already
recorded in `CURRENT_STATE.md` and `KNOWN_ISSUES.md`, so anyone reading the SQL first would stall
the delivery for an approval that is no longer required.

The header now says: do not apply until `20260914101300_finish_generic_field_invoice_cutover` is
confirmed in the live ledger (Mason's 2026-09-26 ordering hold); after that, it applies under the
autonomous-landing rule with no separate ask, behind CodeRabbit APPROVED on the final head, a fresh
exact-SHA `gpt-6-sol` review, green required checks and the migration-apply-guard proofs.

Comment-only; no SQL statement changed. The real-schema prover was re-run on the edited file and
passed.

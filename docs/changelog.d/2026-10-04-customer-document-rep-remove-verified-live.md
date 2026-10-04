## 2026-10-04 - Sales-rep document Remove verified on the live site

The rep document Remove fix's main path is confirmed on croprxsolutions.app. Signed in as the test
sales rep `[E2E] Test Rep` (created by Mason for this check) on the fake customer `[E2E] Remove Test`
assigned to that rep, a throwaway PDF was uploaded and then removed from the Documents tab. The page
showed "Document removed", the file stayed gone after a refresh, the `customer_documents` row reads
removed by `[E2E] Test Rep`, and `activity_feed` holds the matching `document_removed` entry.
Before the fix the same action was refused with "new row violates row-level security policy".

**Not verified on live:** this was one happy path for one assigned, active rep. The refusal paths
(a rep removing a document of a customer not assigned to them, a deactivated rep, a stale page whose
customer was reassigned mid-removal), the retry and replay behaviour of the idempotency key, an
admin's removal through the new path, and removal of office- or system-uploaded documents were not
exercised live. All but the last are covered by the real-schema prover
(`scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs`) and the page's unit tests.
Neither suite removes a document whose `source` is `office` or `system` (the prover seeds every
row with `source = 'rep'`, `uploaded_by` an admin; the page tests use one fixture with no `source`),
so that case remains unverified. The function itself reads neither `source` nor `uploaded_by`.

`KNOWN_ISSUES.md` moves the issue to FIXED and `CURRENT_STATE.md` drops it from the open list.
Fix: `20260921180000_soft_delete_customer_document_rpc` (PR #800) plus the page change (PR #875).

## 2026-10-04 - Sales-rep document Remove verified on the live site

The rep document Remove fix is confirmed end to end on croprxsolutions.app. Signed in as the test
sales rep `[E2E] Test Rep` (created by Mason for this check) on the fake customer `[E2E] Remove Test`
assigned to that rep, a throwaway PDF was uploaded and then removed from the Documents tab. The page
showed "Document removed", the file stayed gone after a refresh, the `customer_documents` row reads
removed by `[E2E] Test Rep`, and `activity_feed` holds the matching `document_removed` entry.
Before the fix the same action was refused with "new row violates row-level security policy".

`KNOWN_ISSUES.md` moves the issue to FIXED and `CURRENT_STATE.md` drops it from the open list.
Fix: `20260921180000_soft_delete_customer_document_rpc` (PR #800) plus the page change (PR #875).

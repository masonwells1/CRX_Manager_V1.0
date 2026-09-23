## 2026-09-22 - Documents tab Remove sends the customer

`soft_delete_customer_document` gained a required `p_customer_id` after the review round on the
parked `20260921180000`. The page now sends this page's `customerId` with the document id, which
restores the scope its old direct UPDATE had through `.eq('customer_id', customerId)`, and a page
test asserts it. The server refuses a mismatch with `CUSTOMER_DOCUMENT_NOT_FOUND`, so a stale
`documentToDelete` from a customer the page no longer shows cannot be removed. `src/types/supabase.ts`
carries the new argument; it is regenerated from live after the apply.

This PR still merges only AFTER the migration is applied live: `rpcFixtureLiveDiff` correctly fails
while the page calls a function that is not live.

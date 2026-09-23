## 2026-09-21 - Parked soft_delete_customer_document RPC so sales reps can remove customer documents

**Bug.** The Documents tab's Remove action (`CustomerDocuments.tsx` `handleDelete`) set
`deleted_at`/`deleted_by` with a direct UPDATE on `public.customer_documents`. For a sales rep
PostgreSQL refuses it ("new row violates row-level security policy"), with or without RETURNING,
because it checks an UPDATE's new row against the SELECT policies and
`customer_documents_rep_select` requires `deleted_at IS NULL`. Admins are unaffected. Live held 0
customer documents on 2026-09-21, so nobody has hit it.

**Change (parked, not applied live).** New migration
`20260921180000_soft_delete_customer_document_rpc.sql` adds one SECURITY DEFINER function,
`soft_delete_customer_document(p_document_id uuid, p_customer_id uuid, p_idempotency_key text
DEFAULT NULL)` (the customer argument was added in the 2026-09-22 review round and is REQUIRED;
see `2026-09-22-customer-document-rep-soft-delete-specialist-reviews.md`). It allows active admins
(any customer) and active sales reps (only customers assigned to them) to soft-delete one active
document of the customer named in the call. It requires a key and binds the receipt to the actor,
the customer and the document through `check_idempotency_intent`. Every missing, already-removed,
wrong-customer or unassigned case returns the same `CUSTOMER_DOCUMENT_NOT_FOUND`, and the function is executable only by `authenticated`. No
table policy, trigger or data changes. `guard_customer_document_update` still enforces immutability
and `deleted_by = auth.uid()`. A policy change was rejected because it would let reps read removed
documents.

**Apply order.** The stamp sorts above every parked candidate still above the live high-water:
`20260914100700` (#764, the restamp of the old `20260914100450`, same table, independent) and the
commission files `20260914100800` and `100900`. `100500` and `100600` applied live on 2026-09-22
UTC. It applies only after those three, or it would strand them. Applying it
needs Mason's explicit approval.

**Frontend.** The page change that calls the RPC ships in a separate PR held until the function is
live. Merging it earlier would break Remove for admins too, and `rpcFixtureLiveDiff.test.ts`
blocks that merge.

**Proof.** `node scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs` builds the
2026-07-27 baseline plus the 95 applied post-baseline migrations (the 2 parked commission files
`100800` and `100900` skipped, and PR #761's file skipped once it is on disk) in a throwaway Supabase PostgreSQL 17 container. It then runs as `authenticated`:
- **Before:** the rep's direct UPDATE is refused by RLS and the admin's succeeds.
- **After:** the assigned rep removes the document with `deleted_by` set to the rep, and the
  same-key replay returns the same result without rewriting the row.
- **Key misuse:** the same key on another document is `IDEMPOTENCY_INTENT_MISMATCH`, and another
  rep using it is `IDEMPOTENCY_ACTOR_MISMATCH`.
- **Refusals:** unassigned, removed and missing documents are all `CUSTOMER_DOCUMENT_NOT_FOUND`.
  Driver and deactivated rep are `INSUFFICIENT_ROLE`, a blank or over-255-character key is
  refused, and anon and service_role are denied.
- **Locks:** a removal waits while another session holds the rep's profile row (a deactivation in
  progress) or the customer row (a reassignment in progress). A removal is permanent, since the
  guard trigger blocks every edit to a removed row, so these races are closed rather than accepted.
- **No other change:** the removed row stays hidden from reps, the rep's direct UPDATE is still
  refused, and editing notes still works.
- **Admin, re-apply and mutation:** the admin removes any customer's document, and the file
  re-applies cleanly. An extra `metabase_ro` grant makes the re-apply fail its exact-ACL
  postflight. A mutation run with the assignment check deleted lets the unassigned rep
  through, so the refusal assertion is proven to test the check.

Result: `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS`.

**Not verified.** Not applied to or tested against live. The page has not been clicked through in
a browser against a database that has the function.

**Side finding (not changed).** Live table grants on `customer_documents` give `authenticated`
DELETE, TRUNCATE, REFERENCES and TRIGGER, which is broader than the `SELECT, INSERT, UPDATE` the
original migration intended. That is likely Supabase default privileges. Row rules still block
DELETE, and TRUNCATE is not reachable through the API. Recorded for a separate review.

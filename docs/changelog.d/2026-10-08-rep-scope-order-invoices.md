## 2026-10-08 - Order invoices scoped to the calling sales rep (migration written, NOT applied)

**Status: written and proven in a container; NOT applied to the live database.** Applying
`supabase/migrations/20261008120000_scope_order_invoices_to_rep.sql` needs Mason's explicit approval,
because it changes what sales reps may do. Until then live behaves as before.

**What changes (Mason, 2026-10-06: a sales rep bills only customers assigned to them and only under
their own name; admins are unrestricted).** The migration re-emits only the two public wrappers
`create_invoice_from_order` and `create_split_invoices_from_order`, starting from their verbatim live
bodies (read-only md5s re-read 2026-10-09: `a1a91643…` and `398030fb…`):
- For a sales rep, before any lock, idempotency lookup or claim, invoice number or write: the order's
  customer (and, for a split, every field billing owner the split could bill) must be assigned to the
  rep (`CUSTOMER_SCOPE_DENIED`), and the salesman the invoice will record,
  `COALESCE(p_salesman_id, orders.salesman_id)`, must be NULL or the rep (`SALESMAN_SCOPE_DENIED`).
- Each wrapper re-checks the invoices it actually returns, which closes the race between the
  unlocked pre-check and the order lock and scopes an idempotent replay.
- The split wrapper gets the CRX-LIFE-001 type allow-list (`ORDER_INVOICE_TYPE_NOT_ALLOWED`) before
  its claim, so a refused `field_application` split no longer draws an invoice number.
- No rows changed, no GRANT/REVOKE (same OIDs, owner, `search_path`, ACL; the postflight proves it).
  New wrapper md5s: `78c3444e301aec889d39dac8dceeb11c` / `adf183df988ab9507f845fbccd91a8ee`.
- `complete_delivery` is unchanged: a rep's refused auto-split falls back to `needs_split_billing` +
  admin notification and the delivery still completes.

**App:** `src/lib/errorSanitizer.ts` now shows "You can only create invoices under your own name" for
`SALESMAN_SCOPE_DENIED` and a plain message for `ORDER_INVOICE_TYPE_NOT_ALLOWED`; both codes added to
`RpcErrorCodes` in `src/lib/db.ts`. No screen changes.

**Proof (container, not live).** `node scripts/smoke/prove-order-invoice-rep-scope-real-schema.mjs`
passes (`ORDER_INVOICE_REP_SCOPE_PROOF_PASS`): baseline + 103 replayed migrations with live md5
fidelity; the bug reproduced before (a rep invoices another rep's customer, names another rep who can
then read the invoice, splits another rep's allocated order, auto-bills another rep's customer by
completing a delivery; an admin `field_application` split burns a number); autocommit and drifted-
preflight refusals; every refusal with no number drawn and nothing written; own-customer and admin
cases still work with exact replay; deliveries by admin, rep, driver; the related chains; re-apply
refused; seven mutations, including two real two-session races that show what the post-checks catch.
New container-only chain `scripts/smoke/smoke-order-invoice-rep-scope.sql` (spec
`order_invoice_rep_scope`); `smoke-backfill-refuse-split-billing.sql` now also fails if a refused
`field_application` split draws an invoice number. The CRX-LIFE-001 prover
(`npm run proof:order-invoice-type-gate`) reads that chain as it stood at `342135561`, so it still
passes. Static test: `src/lib/orderInvoiceRepScopeMigration.test.ts`.

**Found on the way and recorded as open in KNOWN_ISSUES (not fixed here):** `complete_delivery`'s
non-allocated auto-invoice is not rep-scoped; order-RPC invoices would be numbered `INV-` (latent);
the terminal-order guard refuses any landlord split through the order split engine, for admins too
(latent); and two registered chains (`smoke-financial-scope-and-delivery-aggregate.sql`,
`smoke-split_invoices_jsonb_fix.sql`) fail on `main` for unrelated stale-fixture reasons.

**Still to do before landing:** add the `proof:order-invoice-rep-scope` npm script (left out of this
unattended run because `package.json` edits need a human prompt), `/migration-review`, Luna rounds,
PR, CodeRabbit, Sol last, then Mason's yes for the apply.

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
preflight refusals; every refusal with no number drawn, and (held-lock check) before the
idempotency claim and the order lock; own-customer and admin cases still work with exact replay;
deliveries by admin, rep, driver; the related chains; re-apply refused; sixteen mutations (a)-(p),
including four real two-session races that show what the post-checks' customer and salesman legs
catch.
New container-only chain `scripts/smoke/smoke-order-invoice-rep-scope.sql` (spec
`order_invoice_rep_scope`); `smoke-backfill-refuse-split-billing.sql` now also fails if a refused
`field_application` split draws an invoice number, except against the exact pre-candidate split
wrapper (LF md5 `398030fb…`, what live runs until the apply), where it accepts the old CHECK refusal
and prints a `SMOKE_NOTE` - so the registered chain stays runnable against live before the apply, and
the CRX-LIFE-001 prover (`npm run proof:order-invoice-type-gate`) runs it from disk unchanged. Static
test: `src/lib/orderInvoiceRepScopeMigration.test.ts`.

**Review round 1 (2026-10-09) fixes.**
- **Apply order is a hard manual gate (HIGH).** PR #889's `20261007150000`..`20261007150200` must be
  applied live BEFORE this file; applying this one first raises the high-water above them and strands
  them. The pending-set guard reads only files on `origin/main`, so it cannot enforce this while #889
  is unmerged. Stated in the migration's ORDERING header, migration-history row 938, KNOWN_ISSUES and
  CURRENT_STATE. Re-read the live ledger immediately before applying.
- **Live pins re-read** (read-only, 2026-10-09 08:29:43 UTC): all seven preflight pins, both wrapper
  ACLs and overload counts match (recorded in row 938).
- **Accepted residual corrected:** a post-check refusal draws an invoice number, and a sales rep (not
  only an admin) can open that window by editing `field_billing_defaults` (live RLS allows any rep).
  Impact: numbering gaps only. Documented in the migration header, rpc-functions and KNOWN_ISSUES.
- Migration: status-neutral first line (apply status lives only in migration-history), a comment
  next to each `CREATE OR REPLACE` pointing at the postflight ACL proof, and a `.gitattributes`
  `text eol=lf` pin. Function bodies are unchanged, so both postflight md5s are unchanged.
- Prover: a held-lock ordering check (a second session holds the order row and the key's claim
  advisory lock; every refusal still returns its own error under a 3 s `lock_timeout`), with four
  mutations that move the scope pre-check or the type gate after the claim or the order locks and
  are caught as lock timeouts; a new fixture (rep A's order allocated to a field owned by rep B's
  customer, step 5b) plus mutations removing each owner branch of the split pre-check; salesman-leg
  races and mutations for both post-checks; a misc_charge allow check plus a narrowed-gate mutation;
  every preflight pin group shown to refuse on its own drift; the exact auto-split call repeated
  directly after each delivery fallback to show it was refused for the right reason; a negative
  control for the read-leak probe; an admin split replay. Deviations recorded in the prover: the two
  stale chains are not repaired here (the admin split replay is asserted directly instead), and
  mutation (g) is an order-customer race, because a landlord-only race cannot create an invoice
  under the lineage guard.

**Found on the way and recorded as open in KNOWN_ISSUES (not fixed here):** `complete_delivery`'s
non-allocated auto-invoice is not rep-scoped; order-RPC invoices would be numbered `INV-` (latent);
the terminal-order guard refuses any landlord split through the order split engine, for admins too
(latent); and two registered chains (`smoke-financial-scope-and-delivery-aggregate.sql`,
`smoke-split_invoices_jsonb_fix.sql`) fail on `main` for unrelated stale-fixture reasons.

**Still to do before landing:** add the `proof:order-invoice-rep-scope` npm script (left out of this
unattended run because `package.json` edits need a human prompt), `/migration-review`, Luna rounds,
PR, CodeRabbit, Sol last, then Mason's yes for the apply.

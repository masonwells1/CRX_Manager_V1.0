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
  New wrapper md5s: `78c3444e301aec889d39dac8dceeb11c` / `0ff1b8aee5be9d885b5d4c55253b03e9` (split md5 after the Codex P1 fix below; was `adf183df988ab9507f845fbccd91a8ee`).
- `complete_delivery` is unchanged: a rep's refused auto-split falls back to `needs_split_billing` +
  admin notification and the delivery still completes.

**App:** `src/lib/errorSanitizer.ts` now shows "You can only bill invoices under your own name" for
`SALESMAN_SCOPE_DENIED` and a plain message for `ORDER_INVOICE_TYPE_NOT_ALLOWED`; both codes added to
`RpcErrorCodes` in `src/lib/db.ts`. No screen changes.

**Proof (container, not live).** `node scripts/smoke/prove-order-invoice-rep-scope-real-schema.mjs`
passes (`ORDER_INVOICE_REP_SCOPE_PROOF_PASS`): baseline + 103 replayed migrations with live md5
fidelity; the bug reproduced before (a rep invoices another rep's customer, names another rep who can
then read the invoice, splits another rep's allocated order, auto-bills another rep's customer by
completing a delivery; an admin `field_application` split burns a number); autocommit and drifted-
preflight refusals; every refusal with no number drawn, and (held-lock check) before the
idempotency claim and the order lock; own-customer and admin cases still work with exact replay;
deliveries by admin, rep, driver; the related chains; re-apply refused; twenty-four mutations
(a)-(x), including four real two-session races that show what the post-checks' customer and salesman
legs catch, a replay whose salesman changed, the split's `orders.salesman_id` fallback (w) and a split
replay after the customer was reassigned (x). Last run 2026-10-09 (final fixer round, below): PASS.
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

**Review round 2 (2026-10-09) fixes.**
- **Not fixed, needs Mason (HIGH, deferred):** `complete_delivery`'s auto-invoice for an order without
  field allocations still bypasses the rule (a rep completing another rep's customer's last delivery
  gets a draft for that customer). It needs a business decision and its own reviewed migration on
  `_complete_delivery_authorized_impl`, so this change does NOT make the rule hold system-wide; the
  migration header, KNOWN_ISSUES and CURRENT_STATE now say so.
- **Apply order is now enforced by the file (MED):** the preflight refuses with
  `PREFLIGHT_PR889_NOT_APPLIED` unless all four PR #889 migrations are in the ledger by name (the name
  `scripts/apply-migration-file.mjs` records; its version is the apply time). If #889 is renumbered or
  dropped, that check changes with it.
- **Prover replays #889 (MED):** its two schema migrations (`20261007150000`, `20261007150050`) are
  replayed before the candidate (from disk once #889 is on the base, else from #889's head
  `6f05ddbe3`), all four are recorded in the container ledger, and the external-billing and
  deleted-order triggers are asserted present, so every result is proven on the schema live will have.
  **Found for PR #889:** on its schema the registered chain
  `smoke-govern-invoice-order-money-lifecycle.sql` stops at `ORDER_DELETED_LINES_LOCKED` (it plants a
  line and a delivery on a soft-deleted order, which #889's `20261007150050` now refuses), before and
  after this candidate alike. This prover checks that identical failure and also runs the chain with
  #889's three deleted-order lock triggers disabled inside its own rolled-back transaction, where it
  passes before and after. #889 should update that chain's fixture.
- **Stronger pins:** the public `complete_delivery` wrapper (md5 `a1e9a043…`), `is_sales_rep`'s
  volatility, owner and `search_path`, and eight more uuid scope columns (16 in all, re-read live).
  The wrapper bodies are unchanged, so both postflight md5s are unchanged.
- **Prover additions:** a replay after an admin changed the invoice's salesman (only the post-check's
  salesman leg can refuse it; mutation (o) shows it returns the invoice without that leg); the
  held-lock ordering mutations now hold one lock at a time (claim-only for (h)/(j), order-only for
  (i)/(k)) and check the exact refusal when restored, plus (v) for the cifo pre-check; per-leg
  mutations (q) cifo salesman pre-check, (r) COALESCE fallback, (s) split salesman pre-check, (t) the
  order-customer owner leg (new fixture, step 5c) and (u) the billing-default filter (new allow case:
  a field billed 100% to the rep's customer); a missing order for both wrappers; 16 more preflight
  drift cases (overloads, owner, strictness, volatility, security mode, `search_path`, implementation
  ACLs, a second scope column, #889 missing from the ledger); three postflight mutants (two wrong body
  pins, and a late split type gate with a matching pin) that roll the apply back; the
  idempotency-lock helpers (`check_idempotency`, `_claim_bound_lifecycle_idempotency`) pinned to live;
  the admin-notification count read from the data. The proof line now says the two stale chains
  assert nothing.
- **Wording:** `SALESMAN_SCOPE_DENIED` now reads "You can only bill invoices under your own name"
  (`save_invoice` also raises it on edits); the `db.ts` comment names its real origin; the chain spec
  no longer reads as if its row check proves ordering; the migration header no longer says a
  `field_billing_defaults`-only race reaches the post-check (the lineage guard refuses it).
- **Recorded deviations from the design:** the split-billing chain keeps its md5 carve-out (accepts the
  burned number only for the exact pre-candidate body `398030fb…`, printing `SMOKE_NOTE`) instead of the
  design's `chainSource()` pin of the old chain in the CRX-LIFE-001 prover; it is deliberate, so the
  registered chain stays runnable against live before the apply, and this prover asserts the note is
  absent after the apply. If a later change restores that exact body, the chain's burn check turns off
  with a note, not silently. The two stale chains are still not repaired (follow-up).
- **Refuted (Luna MED):** "a zero-share field owner can slip through the split post-check". The
  post-check covers every invoice written; a zero-share owner gets no invoice, and the lineage guard
  refuses any order invoice whose customer is not the order's, so no unassigned customer can be
  billed. Mason's rule is about who is billed.
- **Deferred:** the split wrapper not requiring an idempotency key (pre-existing; KNOWN_ISSUES; later fixed, see the Codex P1 section below), a rep
  replacing an order's named salesman with themselves (a Mason decision; KNOWN_ISSUES), the
  `CRX_REP_SCOPE_NOT_IN_TRANSACTION` transaction-id branch (not reachable: a leftover marker table makes
  the file's own `CREATE TEMP TABLE` fail first), the NULL-uid path, and a scope column changing type
  rather than name.

**Final fixer round (2026-10-09, prover-skeptic MEDs).** Function bodies unchanged (md5s
`78c3444e…` / `adf183df…` still pinned).
- **Split salesman fallback now tested.** New fixture: rep A's own allocated order whose
  `orders.salesman_id` is rep B. Chain step 6b and prover FIX step 6b: rep A's split with
  `p_salesman_id` NULL is `SALESMAN_SCOPE_DENIED` with no number drawn, also while the order row and
  the key's claim lock are held. BEFORE shows the old body recorded rep B through the fallback.
  Mutation (w) makes the split pre-check read only `p_salesman_id`: the chain then fails at step 6b on
  the burned number, the call draws a number, and with only the claim lock held it times out (it got
  past the pre-check); restored, refused first.
- **Split post-check on the replay path.** Rep A splits their own allocated order, the order's
  customer is reassigned to rep B (as postgres, rolled back), rep A replays the key:
  `CUSTOMER_SCOPE_DENIED` (FIX). With the reviewed body the PRE-check refuses this first, and the
  order's customer cannot be moved to get past it (`ORDER_CUSTOMER_LINEAGE_LOCKED` once invoices
  exist, observed in the container), so mutation (x) isolates the post-check: without the split
  owner pre-check the post-check alone still refuses the replay; without both, the replay returns the
  reassigned customer's invoices. Mutation (g) also shows that with only the post-check removed the
  pre-check still refuses it. (Deviation from the requested shape - "remove only the post-check" -
  because that alone cannot change the outcome on this path.)
- **The split-billing chain's md5 carve-out is now marked TEMPORARY.** It stays (it keeps the
  registered chain runnable against live before the apply), but the chain header, the branch itself,
  its `SMOKE_NOTE`, the spec, the prover and KNOWN_ISSUES now say it must be removed in a follow-up
  right after `20261008120000` is applied: delete the `v_split_pre_gate` branch so only the strict
  no-number check remains, and drop the prover's `SPLIT_PRE_GATE_NOTE` checks. **Follow-up owed after
  the apply; tracked as an OPEN line in the KNOWN_ISSUES rep-scope entry.**
- Proof: `node scripts/smoke/prove-order-invoice-rep-scope-real-schema.mjs` PASS
  (`ORDER_INVOICE_REP_SCOPE_PROOF_PASS ... mutations=a-x_detected`), `npm run
  proof:order-invoice-type-gate` PASS, plus the vitest, typecheck, lint and doc-drift checks.

**Codex P1 on PR #891 (2026-10-09): the split wrapper now requires its idempotency key.** The Codex
GitHub reviewer flagged that the re-emitted `create_split_invoices_from_order` still accepted a NULL
or blank `p_idempotency_key`: it skipped the claim (`_bind_completed_lifecycle_idempotency` returns at
once for NULL) and still created invoices with no receipt, so a caller that lost the response could
not replay safely. Earlier reviewers (rls-security, compliance, Luna) raised the same item and it was
deferred as pre-existing; it is fixed now because this migration re-emits the function and the CRX
hard rule requires mutating RPCs to enforce the key.
- **Callers checked first (live read-only, 2026-10-09).** Live `pg_proc` has one SQL caller,
  `_complete_delivery_authorized_impl`, which passes `COALESCE(p_idempotency_key,
  p_delivery_id::text) || ':autosplit'` after locating the delivery by id (never NULL or blank). The
  one app caller, `OrderDetail.tsx` `handleCreateInvoice`, passes a `useIdempotencyKey` key. No edge
  function or `cron.job` calls it. No real caller changes behaviour.
- **Change.** The split wrapper's first statement is the exact check `create_invoice_from_order`
  makes first (same condition, `22023`): `IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order`
  for a NULL, empty or all-whitespace key, before the role gate, any lock, claim, invoice number or
  write. The rest of the body is unchanged. The postflight now also refuses a split body whose key
  check is missing or not first. New split wrapper md5: `0ff1b8aee5be9d885b5d4c55253b03e9` (was
  `adf183df…`); the cifo md5 is unchanged (`78c3444e…`).
- **Proof.** Prover BEFORE: rep A's NULL-key split of their own order bills it (one invoice, a number
  drawn, no receipt, no claim) and the NULL-key retry cannot return it. FIX: NULL, empty and
  whitespace keys are refused for rep A, an admin and a driver (so before the role gate), and with the
  order row and the key's claim lock held (so before any lock or claim), with no number, receipt or
  claim. New chain step 7b. New postflight mutant (key check moved after the scope pre-check, pin
  matched). Mutation (y): without the check the NULL-key split bills again, the chain fails at step 7b
  and FIX's NULL-key check fails; restored, refused first. The `KNOWN_ISSUES` entry is now FIXED,
  PENDING APPLY.

**Found on the way and recorded as open in KNOWN_ISSUES (not fixed here):** `complete_delivery`'s
non-allocated auto-invoice is not rep-scoped; order-RPC invoices would be numbered `INV-` (latent);
the terminal-order guard refuses any landlord split through the order split engine, for admins too
(latent); and two registered chains (`smoke-financial-scope-and-delivery-aggregate.sql`,
`smoke-split_invoices_jsonb_fix.sql`) fail on `main` for unrelated stale-fixture reasons.

**Still to do before landing:** add the `proof:order-invoice-rep-scope` npm script (left out of this
unattended run because `package.json` edits need a human prompt), `/migration-review`, Luna rounds,
PR, CodeRabbit, Sol last, then Mason's yes for the apply.

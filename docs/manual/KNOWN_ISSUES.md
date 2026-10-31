# Known Issues — what is open today

**Last verified:** 2026-10-30 for KI-81 and the quote-expiry rules only (main `1567b768` + local replay, not live); other evidence retains its stated dates.

**Shipment reconciliation: 2026-10-27 (America/Chicago).** Compared all 68 PRs in the October 25–27 UTC merge query with `main` at `fe258c2fe`, current source and the live read-only migration ledger. KI-15 is closed; KI-30's completed category/vendor work is removed from its open scope; KI-47/KI-52/KI-72 are narrowed. The [audit record](../audits/2026-10-27-shipped-work-reconciliation.md) lists every PR and the evidence limits. All other open and accepted risks remain; this is not a fresh full security audit.

**KI-18 verified: 2026-10-29 (America/Chicago)** for KI-18 only: read-only live function definitions confirm `generate_quote_number`, `generate_order_number`, `create_rebate_claim`, and `generate_ticket_number` still take the year from `current_date`. The live ledger includes `20261028185500_order_edit_and_number_concurrency` (version `20261029143642`); its blend-ticket generator retains the same year rule. PR #1181 is still an unapplied candidate and is not part of this check. KI-18 stands. The rest of the file was last verified 2026-10-25; evidence for each re-check is in its PR changelog and timestamped live-ledger captures in [migration history](../reference/migration-history.md). Earlier verification notes are preserved in [the archive](archive/verification-notes-2026-10.md).
Every "applied live" statement not re-read since is the older record's claim, marked as such.

This file is the short list of things that are genuinely open, or that someone decided to live with. Everything
else (fixed, merged, retired, long write-ups, the evidence trail, old section numbers like §0d, §4b, F06) is
preserved word for word in
[`docs/manual/archive/KNOWN_ISSUES-history-2026-10.md`](archive/KNOWN_ISSUES-history-2026-10.md)
(the whole previous file, ~7,000 lines, unchanged). Comments in code or docs that cite an old section number
resolve there.

**How to read an entry.** *Severity* is HIGH / MED / LOW. *Area* groups the list. *Owner* is a named person only
where a record says so; "unassigned" means nobody is working on it. "Mason decision" means the fix is waiting on
a business or risk call that only he can make. *Status* is one of:
**OPEN** (confirmed still present on `main`), **PARTIAL** (some of it fixed, the rest open),
**ACCEPTED** (Mason decided to live with it; reason given), **UNVERIFIED** (could not be confirmed either way in
this pass; treat as open until someone checks).

**Where other facts live (not here).** Applied-migration ledger, row counts and high-water mark:
`docs/reference/migration-history.md`. Current status: `CURRENT_STATE.md`. Settled decisions: `DECISION_LOG.md`.

**Update rules.** When a finding is found, fixed, or decided, edit THIS file (do not start another issue list).
A fixed item is removed from here and its text (with the PR or migration that fixed it) is appended to the
archive. Do not re-fix something listed here as ACCEPTED without a new decision from Mason.

---

## Summary

| Status | Count |
|---|---|
| Open or partly open entries (KI-15 closed; several entries bundle related items and UNVERIFIED sub-items) | 52 |
| Accepted by Mason (KI-60 to KI-71, KI-79, KI-80) | 14 |
| Closed as FIXED, with proof (bottom of file and archive) | 7 |

Highest-priority open items, in order: KI-01 (an applicator keeps field access after the assignment ends,
part C; the functions and tables were fixed live 2026-10-26 and 2026-10-27 UTC, parts A and B), KI-02 (cost and
margin: the table-level lock is live since 2026-10-25; the server-function audit is still owed), KI-10 (about 69 functions still replay a saved answer on the retry
key alone), KI-04 (tools with no permission rule run without a prompt), KI-18 (UTC/browser-clock season can
suppress the pre-harvest safety warning).

---

## Security and access

### KI-01 — Drivers and applicators can read every customer's fields and some money totals
**HIGH · PARTIAL · security · Mason approval needed to narrow permissions; parts A and B applied live, part C not started**
Until 2026-10-26 02:10 UTC (9:10 PM Central, 2026-10-25), any signed-in account, including drivers and applicators, could call database functions that
returned every customer's field boundaries, owners, billing splits, balances and the company-wide overdue list,
because the functions never checked who was asking. Until 2026-10-27 02:05 UTC (9:05 PM Central, 2026-10-26),
applicators could also read every field-table row, not only the fields of the jobs they were sent to. Proven by
read-only impersonation on 2026-10-22. Planned as three parts: A (functions, PR #1065), B (tables, PR #1103),
C (the job route); A and B are applied live and merged; part C has no PR. Related lows: dispatched
applicators can read chemical cost; any sales rep can edit another rep's draft field-invoice billing; invoice
emails put the invoice number and date into HTML unescaped (`src/lib/emailService.ts:123-139`).
Status 2026-10-23: part A was written and not yet applied (`20261023090000_field_functions_require_field_access`,
history row 980). It adds `_can_see_field`, filters the two field-map lookups by it, makes the other field and money
functions office-only (plus three uncalled ones the review found), and was proven in a disposable copy of the
schema (`scripts/smoke/prove-field-functions-require-field-access-real-schema.mjs`): each applicator sees only
its assigned fields, everyone else none, office staff unchanged.
Status 2026-10-26: part A is APPLIED LIVE (02:10:16 UTC, 9:10 PM Central on 2026-10-25; ledger `20261026021016`,
history row 980) on Mason's own `I approve`, and PR #1065 merged as `9ad2cb000`. Re-checked live (read-only
impersonation, counts only): the real applicator gets 2 fields from the field-map lookup (its 2 open dispatches;
it was 5) and is refused the all-fields map; a driver gets 0; an admin gets all 5. Still open: the applicator
reads all 5 rows of the `fields` table directly (part B), and the whole-job applicator route has no end (part
C, KI-73). No in-app click-through as an applicator was done.
Status 2026-10-26 (Central): part B is APPLIED LIVE (2026-10-27 02:05:46 UTC, 9:05 PM Central on 2026-10-26;
ledger `20261027020546`, history row 985) on Mason's own `I approve`, and PR #1103 merged as `5d8af90c1`.
Re-checked live read-only: `_can_see_field` md5 matches the migration's postflight pin, and the field-table
SELECT policies gate applicators on it. Visible `fields` rows per role, computed from the live policy rules with
each active person's id substituted (not a signed-in test): admins (4) 5 of 5, sales reps (3) 5 of 5, the 1
active applicator 2 of 5 (the fields of the jobs they are dispatched to; it was 5), drivers (2) 0, entity
recipients (2) 0. Still open: access does not end when the assignment ends (part C, KI-73). No in-app
click-through as an applicator was done. Part B also widened `_can_see_field` to every field of a dispatched job,
so the earlier gap where an applicator sent to one field of a split job got no weather centroid on Job Detail
should be gone (not checked in the app; 0 split assignments live, 2026-10-22).

### KI-02 — Product cost and margin: server functions not yet fully audited
**MED · PARTIAL · security/money · follow-up audit unassigned**
Mason decided cost and margin are admin-only. Screens and report functions were changed (migrations
`20261019010000`, `20261019230000`) and purchase-order cost is locked (`20261021140000`, `20261021141000`,
PR #980). **The column lock is live:** `20261022101000_cost_columns_admin_only` (PR #1089, applied 2026-10-25
22:34 UTC on Mason's in-chat approval, ledger `20261025223447`). Neither signed-in users (`authenticated`, admins
included) nor signed-out visitors (`anon`) can read or write a cost, profit or margin column directly on
`products`, `quotes`, `quote_items`, `quote_versions`, `orders`, `order_items`, `invoices`, `invoice_items`, `jobs`,
`job_chemicals`, `blend_ticket_products` or `commissions` (read live after the apply: 0 of 30 such columns readable
by either role; the server-only `service_role` key is unchanged); admins read cost through `get_admin_cost_fields`.
Two residuals stay accepted by Mason (2026-10-21): commission amount and rate together imply profit, and below-cost
refusals let a rep narrow a cost by trial and error. Includes the older sub-items "reps can recover
application-service cost" and "retire the old `admin_set_application_service_cost` function" (no caller left in
`src/`; no DROP migration exists).
Still open (Mason, 2026-10-25, kept out of the column lock): column grants cannot limit owner-rights (SECURITY
DEFINER) functions. The 45 signed-in-executable ones whose body names a cost field were read live on 2026-10-25,
but 22 more that reach cost only through inner helper functions (`create_quote_version`, `save_invoice`,
`price_order`, `save_job` and others) are not yet traced, nor are definer functions that serialize a whole row to
JSON (`to_jsonb`/`row_to_json`), and nothing re-checks function bodies after a later change. Owed: audit those call
chains, and add a standing DB invariant sweep that flags any signed-in-executable function returning cost, profit or
margin to a non-admin. The same follow-up makes the cost-lock proof script record each ledger-only migration once
(CodeRabbit, PR #1089).

### KI-03 — Reps do not yet have the decided invoice and commission-split scoping
**MED · OPEN · security/money · Mason decided, build unassigned**
Mason decided reps may see all invoices read-only but only act on their own, and that only admins may change
commission splits on jobs, quotes and orders. Neither is built: no migration widens rep invoice reads or adds
own-name checks (`INVOICE_SCOPE_DENIED`) to the full set of invoice actions any active rep can call today on any
invoice id: `unpost_invoice`, `unpost_invoice_group`, `transfer_invoice_to_job`, `consolidate_draft_invoices`,
`update_field_app_applied_info`, `update_field_app_invoice_billing`, `save_field_app_invoice` (existing invoice) and
the `invoice_shares_insert` policy (checked live 2026-10-13: no ownership test); screens must also hide Edit/Post
on other reps' invoices, and payments and prepay/credit application stay open to reps. Any rep can
still change a commission split on a job, quote or order (only the customer default is protected). Any rep can
also roll over any rep's quote.

### KI-04 — Connected tools with no permission rule run without a prompt
**HIGH · PARTIAL · tooling-guards/security · unassigned**
`.claude/hooks/migration-apply-guard.mjs:59` answers "allow" for every connected tool except migration apply, so
any connector tool without an explicit ask/deny rule runs without confirmation. Vercel deploy tools and Supabase
secret/branch tools were covered in PR #940; the email-send tool and any connector added later are not (no rule
in `.claude/settings.json`; a user-level rule was not checked). Two smaller hook gaps from closed PR #605 remain.

### KI-05 — A sales rep can write RUP register rows for an invoice that was never posted
**MED · OPEN · security/money · unassigned**
`generate_rup_sales_records` (latest body `20260707040000`) checks the caller's role but not that the invoice is
posted, so a rep can add restricted-use-pesticide register rows for a draft. PR #927 hid register reads from
reps but explicitly left this function unchanged. Live had 0 register rows when last checked (older record's claim).

### KI-06 — Financial audit log can point at hard-deleted records
**HIGH (per older record) · UNVERIFIED · database/money · Mason (migration decision)**
Some audit-trail rows refer to invoices or payments that were later hard-deleted and carry no snapshot of what
the record was. Newer invoice deletes are soft; hard-delete paths for payments and the admin override remain.
No snapshot/guard migration was found, but the live row count could not be checked.

### KI-07 — Other small security gaps
**MED/LOW · mixed · unassigned**
- `profiles` still grants `TRUNCATE`/`TRIGGER` to signed-in users (no revoking migration found; confirmed live
  read-only 2026-10-25 with `has_table_privilege('authenticated', ...)`) — OPEN, LOW-MED.
- Customer-document post-apply check (browser storage policies removed, Documents tab still works) was never
  recorded; and a removed document cannot be reopened even by an admin — UNVERIFIED, LOW.
- Three older "reps work any customer" leftovers: signed-in rep click-through of `customer-document-files`
  still owed — LOW.
- A staff viewer can mint a temporary photo link (Mason accepted this, see accepted list KI-60).
- 12 live SECURITY DEFINER functions set `search_path` to `public, extensions, pg_temp`, which the written rule
  (`public, pg_temp`, or an exactly empty path with fully-qualified names) does not cover: `fields_acre_authority_guard`,
  `find_overlapping_fields`, `get_field_dashboard`, `get_field_geojson`, `get_fields_geojson_by_ids`,
  `get_fields_with_geojson`, `get_job_fields_with_geojson`, `get_job_proof_data`, `save_field_geometry`,
  `save_field_polygons`, `set_field_boundary`, `set_field_override_acres` (read-only `execute_sql`, 2026-10-26 UTC; same 12 re-read
  2026-10-25 10:52 PM Central).
  They need `extensions` for PostGIS. Either document a PostGIS exception to the rule or schema-qualify the
  PostGIS calls and drop `extensions` from the path. Promised to CodeRabbit on PR #1065 (thread 4373018174) — LOW.

---

## Money

### KI-10 — About 69 live functions replay a saved result matched on the retry key alone
**HIGH on money paths · PARTIAL · money/inventory/database · unassigned (batch 3 remainder is next)**
When a user retries an action with a saved "retry key", these functions return the first call's saved answer
without checking that the retry is for the same person and record. Nothing is double-charged; a reused key with
a different target gives a false "success" on the wrong record. Fixed on `main`: batch 1 (`20261016060000`,
PR #942), batch 2 (`20261016140000`, PR #951), batch 3a (`20261019200000`, PR #954), batch 3b (`20261019235000`,
PR #967). Remaining: `unpost_invoice`, `price_order`, `update_order_items`, `save_field_app_invoice`, rebate
claims, `close_accounting_period`, notification RPCs and about 55 MED/LOW functions (batch 4). No open PR.
Batch 4 includes `mark_inventory_row_verified` (MED, added 2026-10-23, PR #1042 follow-up 3; Mason: "batch it"):
it matches its saved result on key and operation only, so a reused key with a different `p_inventory_id`, or from
another admin, returns the first call's result. `IntegrityCleanupPanel.tsx` mints a fresh key per click, so no
screen reaches it today. Fix with the batch wrapper as in `20261016140000`, with a real-schema prover.

### KI-11 — Browser screens throw away or share their retry key (double-apply risk)
**HIGH on money paths · PARTIAL · money · unassigned**
On a lost reply the app should retry with the same key. Many screens discard the key too early or keep it across
different records, so a retry could double-apply or replay another record's result. About 14 spots were fixed
(PR #584); a dozen-plus remain (`KNOWN_UNFIXED_SITES` in `src/__tests__/idempotency-reset-order.test.ts:246`:
JobDetail, QuoteBuilder, BlendTicketDetail, PrepayWorkspacePanel, FinanceChargePreviewModal and others). The
`PrepaymentManagerPanel` item may now be covered server-side by KI-10 batch 1 (not confirmed). The automatic
scanner for this is acknowledged as a weak tripwire.

### KI-12 — Quote "Convert to Order" can leave an accepted quote with no order
**MED (latent) · CAUSE FIXED, LIVE 2026-10-27 (To-Do 1.3; PR #1105 merged as `f1503ba91`) · money/inventory/UI · Mason to decide about one real accepted quote with no order (Q-2026-2059)**
QuoteBuilder used to save the quote as Accepted (releasing its inventory holds) before creating the order, so a
failed second step left an accepted quote with no order. It now calls `convert_quote_to_order` on the sent or
revised quote, which marks it accepted in the same transaction as the order; a failure leaves the quote as it was
(proof: `scripts/smoke/smoke-convert-sent-quote-in-one-step.sql`). A direct `quotes.status` update by an owning
rep can still flip a quote to accepted without an order (the column is writable); that path is not in the app. Candidate fix: `20261029090000` (PR #1200, not applied) refuses it at commit (`QUOTE_ACCEPTED_WITHOUT_ORDER`).
Q-2026-2059 (accepted, no order, no draws; seen 2026-10-25) predates the fix and is untouched.
**The December pre-booking flow had the same gap** (raised by Maksym, checked in the code 2026-10-26): a
Planned Program quote reserves its stock with holds (`create_planned_holds`), and the trigger
`release_holds_on_quote_status_change` (latest in `20260706030000`) frees every active hold when the status becomes
Accepted. The same fix covers it: whole Convert to Order and Book as Order both now reach `convert_quote_to_order`
with no Accepted save first, so the hold release and the new order are one transaction and a failed conversion
keeps the pre-booked stock reserved. Partial Order (`draw_down_quote`) never flipped the status first. Two small database clean-ups (extra `quote_sections` privileges and a loose
`_below_cost_reason_from_json` parser) and a display-only profit mismatch are also recorded; the fixes exist only
on closed PR #397.

### KI-13 — Returns never reduce already-earned commission; commission rules unbuilt
**MED · OPEN · money · Mason decision exists (2026-08-09), not built**
Commission clawback on returns has no function or migration on `main`. Also open: `commission_payments.total_amount`
is stored as dollars with decimals (checks force clean cents, but the column breaks the integer-cents rule;
MED); two money columns (`commissions_order_profit_whole_cents_chk`, `quotes_total_cost_whole_cents_chk`) can still
hold sub-cent values, adding the checks is Mason's call (LOW-MED); the old name-reuse guard trigger
`trg_guard_recipient_name_reuse` is deliberately kept until all app versions send person IDs, so renaming someone
can make old splits refuse to save (LOW-MED).

### KI-14 — Transfer-created field invoices are always Net 30
**MED · OPEN · money · unassigned**
`20260914100500` lines ~2587 and 2820 stamp invoice date + 30 days regardless of the customer's terms. The post
path was not traced.

### KI-16 — Sub-cent and rounding gaps
**MED/LOW · mixed · money · unassigned**
- `baseUnitOfRate` (`src/lib/chemCalculator.ts:559`) drops everything after `/`, so "oz/cwt" reads as "oz".
  Saving a job with such a unit is refused by the database (`20260820120000`, PR #446, applied live per the older
  record); `_close_quote_as_applied`, the recipe-pricing path and the blend-ticket path (refuses only at billing)
  can still create such lines. MED.
- A zero-width character pasted into a rate unit makes a blend ticket un-invoiceable (fails closed; staff must
  retype). `normalize_rate_unit` does not strip invisible characters. LOW-MED.
- A job chemical line's per-unit COST is still rounded to whole cents when it is converted from the product's
  stock unit to the rate's unit (`reconcileChemAutofillUnits`, and `save_job`'s cost fill in `20261019230000`):
  $5/GAL is 3.90625¢/oz, saved as 4¢, so 400 oz shows $16.00 of cost against $15.625 and the job's margin is off
  by that much. The PRICE is no longer rounded (2026-10-23: left blank unless exact). Cost is not billed. LOW-MED.
- Split-acre shares are rounded to 2 decimals, so totals can differ from the field's acres by cents. UNVERIFIED
  (current body of `derive_customer_shares_from_fields` not located).
- Quote Builder's line math (`recalcItem`, `catalogPricePerAcre` in `src/lib/quoteCalc.ts`) multiplies and rounds
  in dollars, not integer cents. Found by CodeRabbit on PR #1078 (2026-10-23) and deferred: moving it to cents
  changes rounding on every quote line, so it needs its own money PR. LOW.

### KI-17 — Blend-ticket linkage picks one order line per product
**MED · PARTIAL · money · automatic matching unassigned**
`link_blend_ticket_to_order` still takes `ORDER BY sort_order, id LIMIT 1`. The invoice side now refuses to guess
when tier prices differ and asks staff to pick (PRs #982, #995, #1020). Automatic matching or splitting across
tiers is not built; the linkage field is not used for money today.

### KI-18 — Dates and seasons follow the UTC clock or the browser clock
**MED (safety path) / LOW · OPEN · money/UI · unassigned (fix the JobDetail one first)**
- Quote, order and rebate-claim numbers take their year from UTC (`generate_quote_number`, `generate_order_number`,
  `create_rebate_claim`); on 31 Dec 6 pm–midnight Chicago they get next year's number. Blend-ticket numbers
  (`generate_ticket_number`) follow the same rule. Cosmetic. LOW.
- `invoices.season` defaults to `current_season()` = UTC date, and the blend-ticket path uses it
  (`20261020210000:1050,1227`): about five hours each 30 Sept evening can stamp the next season. LOW.
- Client season reads use the browser clock (`src/utils/season.ts:14`). The important one is the pre-harvest-
  interval warning in `src/pages/JobDetail.tsx:1449`: a wrong season at the 1 October boundary can silently
  suppress the warning. MED (safety).
- Two AR-aging views bucket a 30-day-old invoice differently; invoice dates have no future-date limit; three
  filters cut the day at UTC midnight. UNVERIFIED (PR #991 fixed the AR strip; the rest not re-checked). MED.

### KI-19 — Accounting-month close: 26 other callers lack the month lock
**HIGH-risk lane, dormant · PARTIAL · money · unassigned**
Vendor-bill and vendor-payment edits are safe against a close (`20260730114102`, `20260730124308`,
`20260731001654`). About 26 other `check_period_open` callers do not take the same lock, so a simultaneous edit
could slip past a close. No month is closed live (older record's claim), so it is dormant.

### KI-20 — Shelved or disabled money features
**MED · OPEN · money · unassigned / Mason**
- Prepay bulk-apply is hard-disabled with `PREPAY_BULK_APPLY_DISABLED` (`20260620200000`) because it could
  double-spend credits; real fix needs the shelved redesign. Per-invoice apply works.
- The earmark engine (`docs/roadmap/shelved-earmark-engine/`) is shelved for a full redesign (Mason, 2026-06-14);
  do not apply.
- Split billing: per-delivery split of a partly delivered order is blocked by independent rounding losing cents
  (Goal 3 pieces landed in PR #1010, per-delivery case not confirmed). UNVERIFIED. Negative-quantity credits and
  reopening a saved split set are not supported (fail closed). LOW.
- Auto-draft invoice does nothing when an applicator completes a job; policy is Mason's, switch is off. MED, dormant.
- Two commission design choices wait on Mason (do blend tickets create commissions; may applicators see a job's
  commission split). UNVERIFIED, LOW.

### KI-81 — Two invoice paths read a quote line's current price, not the price the customer was sent
**MED · OPEN (found 2026-10-25, To-Do 1.2 follow-up) · money · unassigned (Mason, 2026-10-27: fix later, not now)**
The sent-price lock (`20261027040000`, live since 2026-10-27, ledger `20261027123725`) gates Convert, Partial Order and Schedule Job, which copy quote prices into
orders and job lines. Two later paths read `quote_items.price_per_unit` live instead (read from live bodies
2026-10-25): `create_invoice_from_blend_ticket` (through `set_blend_ticket_product_quote_price` /
`_blend_quote_pick_valid_20261020`, or the first line of the job's quote section) and the field-application
invoice (`_save_field_app_invoice_impl_20260714`, `resolve_field_app_chemical_price`, which take the first quote
line on the field with no status, customer or deleted filter). After a revision that changed a price and was not
re-sent, either can bill the unsent price (with the candidate `20261029120000`, PR #1203, a price change recorded by `save_quote` is the agreed price and needs no re-send); the field-application lookup can also take a draft, declined or deleted
quote's price. Fix: read the price from the version last sent (or refuse like the lock), with a real-schema proof.

### KI-82 — The open quote screen can show a stale cost for a line it just saved
**LOW · FIX IN REVIEW (Taha, branch `taha/quote-saved-line-cost`; found 2026-10-27, Sol review of PR #1105) · money (display only)**
After Save, `src/pages/QuoteBuilder.tsx` records a new line's saved id and stored price but does not load the
cost the database recorded for that line (`quote_items.cost_at_quote_cents`). If the product's cost changed after
the page loaded, the Cost, Profit and Margin shown to an admin can differ from the saved figures until the page is
reloaded. Saved prices, costs and totals are correct; PDFs never show cost. Fix: refresh each saved line's recorded
cost after a save, and prove it on the live screen.
The fix re-reads each saved line's recorded cost (and, for a line whose cost moved, the product's cost
today) through `get_admin_cost_fields` after an admin's save, without marking the quote changed; proven on a
local replay's screen (a new line added after its product's cost rose shows the recorded cost after Save).

---

## Inventory and deliveries

### KI-25 — A customer receipt that fails to send after a delivery completion is not retried
**MED · OPEN (deliberately deferred) · UI/database · unassigned (next Goal 5/6 change)**
After completion the phone sends the receipt email. If signal drops between, the delivery is complete with no
receipt; the driver is warned and the office can resend by hand. A queue table plus scheduled sender was designed
and not built (needs a new Edge Function deploy). No `delivery_receipt_queue` exists in `supabase/`.

### KI-26 — Delivery completion-evidence leftovers
**LOW · OPEN · UI/database/process · Mason for the access-policy item**
Following `20261022075000` (PR #1024): old app versions are refused until reloaded; offline completions queued
before the change go to review; old completed deliveries have no proof stored; some old proof scripts fail;
abandoned signature files stay stored; file contents are not inspected. Owed: a real-phone airplane-mode test, and
Mason's approval to narrow four older signature policies.

### KI-27 — An expired uncertain request locks its dialog
**MED · OPEN · UI/inventory · unassigned (PR #624 closed)**
If a stock receive/adjust or vendor-bill save loses its reply and 23 hours pass, the dialog locks in that browser
with a "do not submit again" message and no way to dismiss it (`src/hooks/useUncertainMutationIntent.ts:69`). Fix
is an admin-only "I checked, clear this" control.

### KI-28 — Jobs assigned to a non-applicator never reach the dispatch board
**MED · OPEN · database · unassigned**
The sync triggers (`20260707020000:231,296`) require an active applicator; re-activating the person later does not
add the job back. A detection sweep exists (`scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql`);
the write-path fix is not built. Older record counted 0 missing rows live.

### KI-29 — Field-mode and inventory data decisions waiting on Mason
**LOW-MED · UNVERIFIED · inventory/process · Mason**
Five products still flag until counted (Mason chose not to count); returns/voids on Chem Man-billed deliveries stay
allowed; six partially fulfilled orders and three stuck deliveries need a business call; 19 negative inventory rows
must only be fixed from physical counts; the Order page still offers whole-order invoicing on 33 orders (server
refuses, no double bill); live-data cleanups (eight SEED commission batches, PO-2026-0008/0015, an E2E zero-item
invoice, five empty deliveries). Counts are older records' claims, not re-measured.

### KI-30 — Customer/vendor/product data hygiene waiting on Mason
**LOW-MED · UNVERIFIED · database/process · Mason / unassigned**
**Vendor-name merges and category remap are closed** (Mason 2026-10-25, recorded in PR #1100; To-Do 0.12/0.16). That read-only check found no duplicate vendor names and all 595 active products in the intended 11 categories. **Still open:** junk-row deletes and remaining live-data cleanup need Mason's decisions (they change history or delete real rows). About 105 of 204 stored EPA registration numbers are wrong (MED, compliance data; the
`LabelDataQuality` screen exists, data entry is not done). CRM has no data entered; 146 of 150 customers lack a
sales rep (older counts).

### KI-31 — Field Setup and field-save loose ends
**LOW · OPEN · UI/database · unassigned**
After saving a boundary the page does not refresh total acres, so a later attribute-only save can revert legacy
acres; deleting every drawn polygon of a multi-part field falls back to the old boundary
(`src/pages/FieldSetup.tsx:572`). `save_field` reports success for a missing id (`20260729222311:80`, no `FOUND`
check).

### KI-32 — Scale limits: some lists and pickers are still row-capped
**MED · PARTIAL · UI/database · Mason (Goal 4)**
Most lists now page through every row (PRs #959, #1017, #1048). The order, job and purchase-order pickers now search
the database, and cycle-count locations read every row (PR #1048). Still capped: Customers (1000), Jobs (500),
Crop Programs (500), Dispatch Board (500); a Jobs `.or(id.in)` URL-size risk; the blend-ticket scanner Edge
Function (needs a deploy). Per the PR #1048 note, also left for later: the Invoice Detail customer picker and Bulk
PO Import products (open PRs #1018/#1021 at the time), Label Data Quality, Product Detail choice lists, bulk import
name matching, and the Field Customer Assignment dropdown. A customer-name search looks through only the first 50
matching customers (alphabetical) without saying so. Past a cap, a record cannot be chosen.

---

## Database and release process

### KI-35 — Live ledger vs files on `main` is checked only by noticing
**MED · UNVERIFIED · process/database · unassigned**
Nothing automatically compares migrations applied live with migration files on `main` (four past mismatches). The
live ledger also has older entries with no file (ACCEPTED, pre-existing drift; see KI-62).

### KI-36 — A table lock does not serialize the OLD body of a replaced function
**MED (rule) · ACCEPTED as guidance (same as KI-61) · database · Mason (2026-09-03)**
See KI-61. The rule is not yet in the migration checklist (`docs/workflows`); it lives only in the archive entry.

### KI-37 — Parked migration draft with a fragile membership rule
**LOW · OPEN · database · unassigned**
Parked draft `20260813060000_require_completed_delivery_before_invoice_post` (staging folder, history row 877,
NOT APPLIED) selects functions by searching their body for the word "posted", which in one function is only in a
comment. Nothing is wrong today because it is unapplied.

### KI-38 — Edge Function error alerting fails quiet
**LOW · OPEN · tooling/process · Mason (deploy approval)**
`supabase/functions/_shared/sentry.ts:60` defines `validateSentryDsnOrThrow()` but nothing calls it; a missing key
logs `[SENTRY_MISCONFIG]` and drops the alert. Failing loudly needs the key confirmed and eight function deploys.

### KI-39 — Customer-facing PDF polish
**LOW · OPEN · UI · unassigned**
Long section notes on quote PDFs overprint the items table (`src/lib/quotePdf.ts:190-191`); the year-over-year
"Change" colour in the year-end PDF never shows (`src/lib/yearEndSummaryPdf.ts:295`).

### KI-40 — CRM Phase 5 (AI receptionist) preconditions
**LOW · OPEN (future work) · database · unassigned**
Five prerequisites before building an automated phone receptionist (service-callable customer summary, service
document ingestion, provenance-trigger handling, transcript purge, a citing design question). Not a live defect.

### KI-41 — Product roadmap items deliberately deferred
**LOW · OPEN · process · unassigned**
Grower portal; OCR auto-fill of re-entry/pre-harvest intervals (held back as a compliance risk); offline-recovery
items (photo/signature persistence, idempotent email replay) and a real-phone offline test (MED, UNVERIFIED).

### KI-83 — The `idempotency_keys` table has no TypeScript type
**LOW · FIX IN REVIEW (Taha, branch `taha/idempotency-keys-type`; found 2026-10-27, migration-drift review of `20261027040000`; predates it) · database**
`idempotency_keys` is the internal table where database functions record a retry key and its saved answer, so a
repeated request returns the first result instead of acting twice. Many functions write to it (including the
quote save re-emitted by `20261027040000`), and every column they write is in `.claude/schema-registry.json` and in
the generated `src/types/supabase.ts`, but the shared hand-written types in `src/types/index.ts` have no interface
for it. Two screens read one column of it directly (`QuickDeliveryModal.tsx` and `InvoiceDetail.tsx` check that
`request_fingerprint` exists), so nothing is broken; the gap only means the migration review's TypeScript
cross-check, which reads `src/types/index.ts`, cannot confirm those writes. Fix: confirm with the
`typescript-types-drift-reviewer` whether to add an interface or record the table as intentionally untyped.
The fix adds `IdempotencyKey` to `src/types/index.ts` with the eight registry columns, as that reviewer's
CHECK 1 asks for every table a screen reads with `.from(...)`.

### KI-85 — Four sweep fingerprints went stale when the sent-quote price lock applied
**MED · OPEN (correction written 2026-10-28 on the PR #1165 branch; not yet reviewed, merged or confirmed by a live sweep) · database/sweeps · Mason authorized the fix 2026-10-28 (To-Do 11.12)**
The live db-invariant sweeps run after PR #1119 (2026-10-27, all 29 predicates, adjudicated `complete: true`)
returned `ok: false` with 4 unallowlisted rows. All four functions were rewritten by `20261027040000_quote_sent_price_lock`
(PR #1105, applied 12:37 UTC), whose PR did not update their reviewed fingerprints. The sweep after row 991 that
morning was 29/29 clean. Two are `actor-forgery` rows: `save_quote` and `convert_quote_to_order` (their
`allowlist.json` entries pin `_save_quote_below_cost_impl_20260810` and `_convert_quote_to_order_below_cost_impl_20260810`
bodies that no longer match live). Two are `quote-versions-rpc-owned` rows: the body pins of
`_create_quote_version_owner_impl` and `_restore_quote_version_owner_impl`. None touches PR #1119's objects. Not yet
known: whether the rewritten bodies still hold the actor binding and the database-owned quote-version write rule;
that needs a reading of each live body before re-pinning. Until it is fixed, **every post-apply sweep will show these
same 4 rows**: compare against this list, and treat any OTHER unallowlisted row as new. Fix: read the four live bodies,
then re-pin in `scripts/db-invariant-sweeps/allowlist.json`, the `quote-versions-rpc-owned` predicate and its test,
through the security ship path; never re-pin a body that lost its guard. Done = a full live sweep adjudicates `ok: true`.
2026-10-28 reading and correction (PR #1165 branch): an independent RLS review read all four live bodies and found the
actor binding, strict actor-mismatch refusal, active-role gates, private-function EXECUTE restrictions and the
quote-version trust-marker route intact, so these were stale fingerprints, not defects. The correction re-pins the
`save_quote` and `convert_quote_to_order` dependency digests and the two quote-version body pins from live; the
`convert_quote_to_order` exception also gets a second, separately reviewed entry for the candidate body of
`20261027080400` (any active rep may convert; the actor stays bound), so the sweep is clean both before and after
that migration applies. The candidate digest was captured from a disposable PostgreSQL replica that first reproduced
every live digest. Still open until: review, merge, and a fresh live sweep after the candidate migration is applied.

---

## Tooling, guards and CI (affect the agents and the build, not customers)

### KI-45 — Hold-latch helper-report edge cases
**MED · OPEN · tooling-guards · unassigned**
PR #1084 fixed the four recognized helper-report frames that were falsely latching the session. A helper report in another text shape can still be mistaken for Mason's words (`.claude/hooks/prompt-source-lib.mjs`, text-shape rules only); message-origin support is still needed for a complete fix. Further narrowing is in open PR #1152, not counted as shipped here.

### KI-46 — A review proof can be rewritten through its Windows 8.3 short name
**MED · OPEN · tooling-guards/security · Mason (owner action)**
The saved "Sol review passed" file can be addressed via an old-style short name the guard does not recognise.
Turning off short names is a reversible system change that only Mason should make; the durable fix is to
authenticate proof contents. CodeRabbit's backstop was removed 2026-10-19, which raises exposure.

### KI-47 — Hook bypasses that remain
**MED/LOW · mixed · tooling-guards · unassigned**
- Autopilot approves these destructive spellings (`.claude/hooks/autopilot-lib.mjs:214-216`; reproduced by calling
  `autopilotDecision`, re-confirmed by a reviewer): `rm -Rf`, `rm -r -f`, `rm --recursive --force`,
  `Remove-Item -Recurse`, `git clean --force -d`, `git branch -d -f` and `git commit -n`. A fix sits on branch
  `claude/autopilot-recursive-delete-alias-20260907` (18,131-command sweep) but must be rebuilt on current `main`.
  MED.
- Bare `git clean` with a config override is not covered (`bash-safety-lib.mjs:280`). LOW.
- `review-proof-guard`: the `GIT_EXTERNAL_DIFF` separate-export form and `gh` download over a protected path are
  unblocked (item 1 fixed in PR #530). Capped by Mason's 2026-09-01 decision. LOW.
- `git config core.hooksPath` is now refused by the Claude hook (#530) but the Codex side and a CI assertion are
  missing; CI still blocks anything reaching `main`. MED.
- The push guard does not treat `core.hooksPath` or shell-form `credential.helper` as dangerous
  (`codex-push-lib.mjs:1209-1217`). MED.
- `stop-verify` PROOF matching is text-based, so a fabricated PROOF line passes. LOW.
- Nine enforcement-file patterns are missing from the `.claude/settings.json` `ask` list (F3). Probably
  superseded by Mason's "fewer prompts" direction (#956, #974); needs a decision to close or cut down. LOW.

### KI-48 — Migration-apply protections and checks with known holes
**HIGH (per older record, exposure reduced) · OPEN · tooling-guards · Mason (capped review loop)**
- Ahead-of-pending marker (parked after review round 12): the proof-folder scan in `migration-apply-lib.mjs:956-975`
  has no deadline, so a slow run past the hook limit could let an apply proceed unchecked; the marker is not bound
  to a file digest. Exposure reduced because applies go through the guarded script.
- Three apply protections exist only on closed PR #364's branch. OPEN.
- The migration-ordering check reads a local snapshot of applied migrations and cannot see applies from another
  checkout (`applied-snapshot-invalidate.mjs`); Supabase's ledger is the backstop. LOW-MED.
- The migration-drift reviewer's overload check sees only authored history, not the live catalog
  (`.claude/agents/migration-drift-reviewer.md` CHECK 2). Deferred by Mason. MED.
- Whole-body hash pins on the quote-version trust chain must be updated in the two live files together (the applied migration `20260826220000` keeps its own apply-time copy) (ACCEPTED, KI-63).

### KI-49 — Codex review tooling
**HIGH (per older record), mitigated · OPEN · tooling-guards/process · wiring a hook needs Mason's approval**
Running raw `codex review <scope>` from the repo root self-recurses, kills its own process and exits 0, which can
record a false "clean" review; the wrapper `node scripts/write-codex-push-proof.mjs` avoids it, nothing blocks the
raw form. Also: the Codex `/import` feature writes corrupted `source-command-*` adapters (commit blocker fixed,
importer cannot be turned off; since 2026-10-30 the sync warning names `--archive-imported`, which moves them to a
restorable archive, and a later import can bring new copies back; deferred, not solved: an external filesystem change
during archive creation can leave an empty directory after a rejected operation. Existing file content is retained,
and the destination is fixed under shared Git storage); `sync-agent-workflows.mjs` has thirteen
recorded limitations (lexical-only containment, junction/symlink and path-case edge cases; Mason: record, don't
patch); the guard-claim ratchet misses claims inside template strings and files outside the hook folders. Codex can
show two Stop prompts on one stop (Mason's global reminder plus the project proof check); they check different
things, and removing the duplicate needs a separate change to the global hook. Codex's guard still refuses a
single-quoted search alternation near a protected file (use double quotes or separate simple reads), and a batched
double-quoted search when the command holds shell syntax that could change how quotes pair, such as `$`, `%`, `!`, a
comment or `\"`, even when harmless (the guard's scan is deliberately conservative, not a parser; the full list is in
`docs/reference/agent-guardrails.md`; drop the comment or run the reads separately). Deferred, not solved: this change
does not establish source-content integrity for every shared hook. Runtime trust status and the guard's explicit
protected-file list are separate checks; scripts outside that list do not gain its write protection.

### KI-50 — Cloud (web/mobile) sessions cannot push or back up memory
**MED · ACCEPTED · tooling-guards · Mason (2026-08-04: leave as is)**
A credential proxy rewrites git addresses and the guards refuse (safe failure); deliver from the cloud with GitHub
tools. `scripts/backup-claude-memory.mjs:476` refuses the same way.

### KI-51 — Supplier-pricing Phase 3C containment and time-bombs
**MED · OPEN · tooling-guards · unassigned**
The trusted containment check is not a required check on `main` (rules: Vercel, Lint/Type/Test/Build, SQL
Migration Validation). The first-push ancestry cap is 4,096 commits (`scripts/check-supplier-pricing-phase3-private-artifacts.mjs:25`);
`main` has 3,032 and grows ~200/month, so about five months until every new branch push is blocked; raise it before
then. Byte/candidate scan budgets (3 GiB, 100,000) need re-measuring. Maintenance watch.

### KI-52 — Tests and tooling hygiene
**LOW · OPEN · tooling-guards · unassigned**
Page-render tests flake in the full suite (latest fix #1062; fixed case by case); `scripts/fleet-status.mjs` lacks
the fsmonitor override; `live-testdata-lib.mjs` read-side false positives were addressed by PR #1143 (merged 2026-10-27), which keeps executable DML guarded; new instances still need individual reproduction;
`scripts/land-pr.mjs:167` prints a `gh pr merge --squash --auto` command the merge guard refuses;
`src/lib/rlsContracts.test.ts:148-160` comment still says "NOT APPLIED" for `20260813080000`; the Phase 3
return-policy concurrency prover can't reach its chain (UNVERIFIED; PR #1110 repaired three different provers and does not establish this one's result); no static guard catches invoice-type leaks or
direct-URL edit-lock bypasses (MED, UI); extra live-sweep predicates (concurrency hotspot, more money identities)
not written; Gauntlet V2 Phase 2 unfinished (no staging database, E2E switched off, 44 page-render skips,
counts not re-measured); `docs/reference/gotchas.md` has no "gross margin means markup" note.
Further small LOW notes from the 2026-10-13 branch salvage, carried from the archive and not re-checked: invoices
created through the order functions would be numbered INV- instead of CS-/MC- (latent; 0 of 12 live order
invoices affected); the smoke chain `smoke-split_invoices_jsonb_fix.sql` is stale; on the bulk order import,
Escape on the below-cost prompt also closes the Import Orders dialog while the upload continues out of sight
(`src/components/orders/BulkOrderImport.tsx`; a fix sits on closed PR #350's branch); the return-credit prover
is pre-apply and two test hardenings were not carried; GraphQL ref updates are not inspected locally (the
server-side ruleset is the boundary).
`src/types/supabase.ts` cannot be swapped wholesale for a fresh live type generation (checked 2026-10-26): the
generator drops hand-kept entries (the `invoice_postable_version` computed field on `invoices_postable`, which
`InvoiceDetail`, `Invoices`, `OfficeCockpit` and `OrderDetail` select; nullable columns on table-returning reports
such as `get_quote_versions`), so the typecheck fails, and it adds about 60 live helpers the file lacks, which
moves two `rpcContracts.test.ts` classifications. Records PRs add only the entries their migration changes, compared
against a live generation.

### KI-84 — The split-billing backfill smoke chain fails on current `main`
**LOW · OPEN · tooling/smoke · unassigned (Mason, 2026-10-27: noted, not now)**
`scripts/smoke/smoke-backfill-refuse-split-billing.sql` stops before `SMOKE_PASS_ROLLBACK` on a current-main
database. It completes a delivery with a direct `UPDATE`, which 20261022075000 now refuses
(`COMPLETION_EVIDENCE_REQUIRED`). It also needs the versioned `post_invoice_group` branch, using the pattern in
`smoke-field-app-split-penny-exact.sql`. This is a test gap, not a customer defect: the refusal it proves stays
live, and `prove-quote-customer-row-version-real-schema.mjs` still runs the chain in its old form on the July
catalog (#1110). Done = the chain passes on main and still fails first against 20261006200000 (CRX-LIFE-001).

---

## Accepted risks (Mason decided to live with these; do not re-open without a new decision)

| ID | What | Why accepted |
|---|---|---|
| KI-60 | A permitted staff member can mint a temporary link to a private photo | Mason, option A, 2026-10-14 |
| KI-61 | A `LOCK TABLE` in a migration does not stop an already-running call of the OLD function body | Mason 2026-09-03; both instances applied with zero activity; future migrations of that shape need a quiet rollout and a concurrency proof |
| KI-62 | Live migration ledger has older entries with no file on `main` | Pre-existing drift, not new |
| KI-63 | Quote-version trust chain has live pins in two files (`quote-versions-rpc-owned.sql`, `quoteVersionWriteBoundary.test.ts`); migration `20260826220000` keeps its apply-time pin copy | Intentional friction; a live-pin change must update both live files, while the applied migration stays unchanged |
| KI-64 | All agents share Mason's admin GitHub identity; the manual merge override is fenced only by command matching | Mason declined a separate non-admin credential twice (2026-09-01) |
| KI-65 | The write-time actor-binding guard is bypassable by design limits | Capped by decision 2026-09-01; real controls are Codex review and post-apply sweeps |
| KI-66 | `review-proof-guard` denies destructive commands that spell out a worktree path | Mason "document, don't fix" 2026-08-20; use relative paths |
| KI-67 | `sync-agent-workflows --write` overwrites an unusable manifest; the `.agents/` drift sweep reads disk, not the git index | Mason 2026-09-03 |
| KI-68 | `adjust_inventory` accepts a retry key with control characters; a suspended second tab can resend a stale batch adjustment | Mason accepted 2026-09-20 / 2026-09-13; no caller can produce it; revisit if duplicate adjustments appear |
| KI-69 | Return-credit behaviours staff will see (late return credits stay in the current season; a funding invoice can't be deleted until the credit is voided) | Mason policy 2026-08-26 |
| KI-70 | Proof-file self-attestation; migration-source provenance closes the quiet path only; shell string-reconstruction bypasses; worktree awareness is a session-start snapshot; `npm --prefix/--workspace` escapes the script-body guard; Edge Functions and ~130 legacy reads exempt from check lint rules | Accepted residuals under the "honest mistakes, not malicious agent" model |
| KI-71 | Renaming/deactivating a profile named in a commission split fails closed; PWA needs two reloads after a deploy; ExcelJS tests slow on a cold cache; JobDetail save test must re-click | Deliberate / expected behaviour |
| KI-79 | A saved quote line forgets whether its acres were typed or filled in from the section's field (`save_quote` stores the acres, not the source; Quote Builder's `acres_source` lives only in the browser). Totals stay correct. After reopening, switching a section's field leaves those lines' acres as they were and shows "This section's saved lines keep their acres. Check them against the new field." Options weighed 2026-10-23: (1) keep as is, no cost; (2) store a typed/field flag on `quote_items`: a migration plus changes to `save_quote` (a money RPC) and every quote-copy path (duplicate, versions, rollover, template), which fall back to today's warning if they drop it; (3) save each line's field link and have the server recompute acres: a large `save_quote` rewrite, highest risk | Mason chose option 1, keep as is (2026-10-23, #1060 follow-up); revisit if reps report wrong acres after switching fields |
| KI-80 | A job line priced from a product's tier price is not re-checked when that tier price is later removed or the customer's tier changes; it is re-checked (`job_chemicals_price_required`, #1060) only when the line is next edited | Mason declined the re-check (2026-10-23, #1060 follow-up): rare case |

---

## Additional open details (carried from the archive after the Luna cross-check; not re-verified in this pass)

These sub-items belong to the numbered entries above. They were found missing or blurred when a second reviewer
(Luna) compared this file with the old one. Each is an open or accepted limitation as the old file recorded it.

### KI-72 — A fix merged on `main` whose last steps are still pending (moved here from "closed")
**MED · PARTIAL · security/money · Mason**
CRX-LIFE-001, reps creating a `field_application` invoice through the order
pipeline: fix merged (PR #885, `20261006200000`, applied live per the old record). Two proof gates remain: the 29th
live-sweep predicate (`quote-versions-rpc-owned`) was declined at its prompt, and the live smoke chains need
Mason's REAL-DATA-OK.

Purchase order copy (To-Do 0.15, PR #1114 merged 2026-10-27): the PDF download is built. Migration `20261027070000` is absent from the live ledger read 2026-10-27; PR #1147's email snapshot/retry fixes merged 2026-10-27; the service still needs deployment. The
**Email PO Copy (to mason@croprxsolutions.com) stays off until Mason approves deploying the `send-email`
edge function** (the live function answers "Unknown email_type: purchase_order").

### KI-73 — More field-access holes (extends KI-01; To-Do row 11.4, plus row 11.7)
**HIGH · PARTIAL · security · Mason approval to narrow permissions**
- FIXED LIVE 2026-10-26 02:10 UTC (9:10 PM Central, 2026-10-25) by part A (PR #1065, history row 980, ledger `20261026021016`): `global_search` let any
  signed-in user search customer names and contacts, order/invoice/delivery numbers and farm names, and
  `get_notes_for_entity` let any signed-in user with a record ID read its team notes. Now search returns nothing
  to field roles and notes follow the linked record (`get_notes_for_entity` runs as the caller, checked live). `team_notes` itself still admits every active profile, so the Team Board shows field roles every note;
  Mason decided 2026-10-23 to keep that for now (To-Do row 11.11, `DECISION_LOG.md`).
- Every active account reads every `customer_addresses` row (To-Do row 11.7; HIGH).
- FIXED LIVE 2026-10-27 02:05 UTC (9:05 PM Central, 2026-10-26) by part B: drivers could read every customer's
  billing splits and spray-record field/acres data through `field_billing_defaults` and
  `application_record_fields` (MED); both now admit only office staff and applicators who can see the field.
- Whole-job applicators keep access to completed, cancelled and soft-deleted jobs indefinitely, and dispatch access
  can survive a job deletion; affected functions include `start_job` and `complete_job` (HIGH; part C, not
  started). Part A's `_can_see_field` already ends whole-job access when `jobs.deleted_at` is set, for the
  field-map lookups only.
- FIXED LIVE 2026-10-27 02:05 UTC (9:05 PM Central, 2026-10-26) by part B (PR #1103, history row 985, ledger
  `20261027020546`): applicators read every `fields` row, and `field_polygons`, crop history, obstacles and
  `field_app_locations` followed the same rule (HIGH; 5 of 5 rows live for the real applicator on 2026-10-25,
  Central). After the apply the 1 active applicator sees 2 of 5 fields, drivers and entity recipients 0, admins
  and sales reps 5 of 5 (computed read-only from the live policy rules, not a signed-in test). Part B also closed: the
  `field_billing_defaults`/`application_record_fields` driver reads above; direct `field_polygons` writes by any
  applicator (made office-only); `field_app_locations`/`_shares` reads (office-only); and
  `get_job_billed_customers` letting any applicator through on a job with no whole-job applicator (NULL gate).
  Mason decided 2026-10-25 that someone sent to a job sees the entire job (`DECISION_LOG.md`), so part B also
  widens `_can_see_field`'s dispatch leg to every field of the dispatched job and keeps the job pages job-wide;
  that resolves the split-job report mismatch a per-field view would have caused. Left after part B: anon reads
  of `application_record_fields` now error instead of returning nothing (LOW, fails closed; three other field
  tables already did); a crew member
  whose role is driver keeps the crew job and its map but not the field tables (by design).
- Opposite gap: dispatch-only applicators cannot read their assigned fields' shares, application records and
  details, attachments, or job-attachment photos (LOW). Mason's 2026-10-25 decision (they see the entire job and
  ticket) means these should be widened to the dispatch route too; not built.

### KI-74 — More cost exposure and prerequisites (extends KI-02)
**HIGH/MED · OPEN · security/money · Mason**
`blend_recipe_items` and cost fields reachable through field-billing and dispatch paths remain readable (HIGH).
Commission amount plus rate can reveal a rep's profit, and Quick Receive reveals which open PO line is cheaper
(MED). The computed field `invoice_post_version` reads the whole invoice row, so revoking invoice columns can break
posting: the cost-column lock must ship with a column-safe version design in the same change (MED). **Done in
`20261022090000` (PR #1057, applied live 2026-10-23):** the version is a computed field, `invoice_postable_version`, on
the `invoices_postable` view (every column but `total_cost_cents`), the seven screens read it there, and the cost lock
(`20261022101000`, applied live 2026-10-25) dropped the `invoices` overload.

### KI-75 — Retry-key detail (extends KI-10, KI-11)
**HIGH on money paths · OPEN · money**
Still on the replay-binding list: `transfer_invoice_to_job`, `update_field_app_invoice_billing`, and the after-lock
race in `apply_credit_memo_to_invoice`. Screen-side: the `PrepaymentManagerPanel` split-check modal, JobDetail
reset-before-call defects the scanner cannot see, and payload-sensitive actions in FieldStop, DeliveryDetail and
OrderDetail.

### KI-76 — Quote, season, invoice and return details (extends KI-12, KI-14, KI-18, KI-20, KI-69)
**MED/LOW · OPEN · money**
- Quote re-save can still be refused when a save both deletes or switches a saved line and adds several new lines
  for the same product (LOW).
- `issue_return_credit` and the delivery-split functions can fall back to `current_season()` (UTC) (LOW).
- `get_customer_summary` and `operational_dashboard_summary` pick the season from the UTC `current_date`, so from 7 PM to midnight Central on 30 September they already count the new season (found by CodeRabbit on PR #1065, 2026-10-25; that PR keeps both bodies as live has them) (LOW).
- Transfer Net 30 (KI-14): the post path was not traced, so a later step might correct it (uncertain).
- Split billing: a split can bill any customer named in editable order allocations, field owners or billing
  defaults; whether that scope is intended is Mason's open decision (MED). Any rep can read another rep's
  split-return lines and prices under `return_items_select` (LOW).
- `create_invoice_from_order` copies a blank unit, so a mono-billed order line with no unit cannot get a return
  credit (MED). A return can go stale after an earlier return is cancelled or rejected (cancel and recreate); a
  concurrent split-invoice void can leave a requested return unreceivable; credits apply manually; multi-price
  billing is credited at an average price (MED, partly by design).
- KI-69 detail: voiding a return credit is not enough; the voided credit memo must be permanently deleted before the
  source invoice can be hard-deleted or re-saved.
- Whole-order invoice quantities and unit prices are not capped server-side (MED; quantities change when PR #1174 applies). Voiding a delivery whose invoice
  is posted leaves the invoice active (MED; changes when PR #1174 applies: the delivery then cannot be voided until the invoice is voided). Removing a product from a
  scheduled delivery can leave its drafted invoice unpostable, and lowering a quantity leaves the draft over the
  delivery quantity until staff edit it (MED). Freezing a soft-deleted order can block cancelling or voiding its
  completed delivery (reversal needs a reviewed migration) (LOW). Draft invoice CS-2026-0055 is deliberately left
  (the other delivery was billed in Chem Man) (LOW). Integrity checks page by offset, so concurrent inserts or
  deletes can make a run miss or repeat a row (LOW, accepted).

- PR #1174 also preserves physical quick-delivery and follow-up completion while an edited draft needs correction; posting still rechecks the whole bill. Its split generator conserves each source quantity exactly, and the order-line and product caps have no fractional tolerance.

### KI-77 — Lists, UI and CRM details (extends KI-26, KI-30, KI-32, KI-41)
**MED/LOW · OPEN · UI/database**
Still row-capped: the Invoice Detail customer selector, Bulk PO Import products, bulk-import name matching,
Label Data Quality choices, Product Detail choice lists (MED). Paging caveats: two identical reads can still miss
concurrent changes, load/count cost grows on large tables, more than 20 identical-name search results are hard to
reach, a trigram index may be needed (LOW). Commission Payments: an older refresh can report success after a newer
one fails (LOW). `SelectLocationsModal` map/list split stays 50/50 on tablets (LOW). CRM gaps: applicator-license
visibility on customer/prep-card/quote surfaces, a pre-quote pipeline, duplicate-customer detection, bulk
import/assignment of sales reps, outbound-email logging (MED). Offline recovery also lacks notification replay,
operation-specific conflict checks, automatic discovery of an office resolution on the device, a general
duplicate-action policy, and carries the risk of losing device-local work before reconnection (MED). Completion
evidence: photo proof is not tied to who took it, and storage-rule guarantees do not cover dashboard or
service-role tools (LOW).

### KI-78 — Tooling and guard details (extends KI-04, KI-46, KI-47, KI-48, KI-49, KI-50, KI-65, KI-68)
**MED/LOW · OPEN · tooling-guards**
- CodeRabbit label gate (#516), four items: stale requested state can survive an invalid ready event; checks can be
  stale after same-head invalidation; privileged workflow actions use mutable tags; merge guards do not bind
  approval to the recorded request marker or reviewer identity (MED; relevance lowered since CodeRabbit became
  advisory).
- PR #605 hook gaps: MultiEdit edits are not inspected by several hooks; non-canonical path spellings can bypass
  path-rule matching (LOW).
- Review-proof guard: besides the 8.3 short name, an interpreter can build the path, a hard link can expose the file
  outside the state directory, and an alias/junction can be swapped after the check (MED). A separate
  `export GIT_PAGER=...` can evade it, like `GIT_EXTERNAL_DIFF` (LOW).
- The three protections missing from closed PR #364: apply-time one-shot replay enforcement, fresh project-bound
  live evidence, and event-trigger/transitive-fanout coverage (HIGH per the old record, exposure reduced).
- Ahead-of-pending marker: the parked branch's file-digest binding is not rechecked at the end, and three refusal
  tests assert only exit status, so an uncaught crash passes them (LOW).
- Actor-binding guard (accepted, KI-65): hook and live sweeps share naming blind spots; rebinding, dynamic SQL and
  temp-table paths evade checks; helper delegation is not followed; migrations written outside hooked tools bypass
  the hook.
- `sync-agent-workflows.mjs` limits (KI-49): external symlink targets can pass; external `GIT_INDEX_FILE` can be
  ignored; case/Unicode staged paths can evade checks or collide; a directory-to-file change can make repair fail;
  unowned manifest paths can be deleted; fail-closed wiring lacks regression coverage; some prune tests never reach
  the prune loop; `source-command-` is treated as provenance; invalid UTF-8 can compare equal after replacement
  decoding (MED).
- Cloud sessions also fail the commit gates (not only push and backup); the only workaround is unverified (MED, KI-50).
- `inventory.quantity_available` has no CHECK constraint, so a pre-existing NaN can propagate (MED, KI-68). The
  parked control-character migration's postflight checks can be satisfied by a commented-out clause and no longer
  inspect the cutover-trigger body (LOW, only if that branch is resumed).

---

## Unverified items (could not confirm either way; treat as open until checked)

KI-06 (audit log), KI-07 (customer-document post-apply check), KI-16 (split-acre
rounding), KI-18 (AR-aging parts), KI-20 (per-delivery split, commission design choices), KI-29/KI-30
(live-data counts), KI-35 (ledger reconciliation), KI-41 (offline recovery), KI-52 (prover, live-testdata false
positives). Live-database facts need a read-only query by someone with access.

---

## Closed in this rewrite (each with proof; full original text is in the archive)

Entries 1–6 were closed during the original rewrite; their older proof records are retained. Entry 7 was closed by the 2026-10-27 reconciliation. That reconciliation checked the live migration ledger, but did not re-run the older behavioral proofs.

1. **Staff photo buckets were publicly readable** — `20261015230000_staff_photo_storage_access.sql` and
   `20261016030000_staff_photo_buckets_private.sql`, PRs #929 and #947 (buckets read `public = false` live
   2026-10-16 per the older record).
2. **Reps could name another salesperson on invoices, orders, blend tickets and quotes** —
   `20261014210000` (PR #928), `20261015130000` (PR #933), `20261015200000` (PR #938).
3. **Free-form invoice could name any product** — `20261021050000_from_scratch_invoices_charge_lines_only`, PR #983.
4. **Split billing could not bill a field owner who is not the order's customer** — `20261021150000` and
   `20261021155000`, PR #1010 (merge `d8dd88a6d`).
5. **Order total overwritten by an unrounded sum in `_update_order_items_impl`** — fixed 2026-08-09; later bodies
   (e.g. `20260914100500:2263`) set the rounded total.
6. **`review-proof-guard` node-preload / `-pe` eval bypass (item 1 of the executor-bypass entry)** — PR #530
   (merge `26e8a40d9`); items 2–3 stay open in KI-47.

7. **KI-15, stored-profit Reports tabs** — PR #1134 merged 2026-10-27 (`cef4e3015`); `Reports.tsx` now calls `get_profitability_report` for customer, product and month groups. The PR records real-data local-app proof and paging/failure tests. Full report approval remains To-Do 10.2. Original issue and closure evidence appended to the archive.

Also closed inside the old file's own headings before this rewrite (no new proof needed, see archive): the
Deliveries list scheduled-delivery gap (PR #964), smoke chains rotted by the PO cost lock, the regular invoice
editor posting old amounts, the filed-season date-edit guard, the last commission-cohort migration
`20260914100900`, and the `customer-document-files` v2 redeploy.

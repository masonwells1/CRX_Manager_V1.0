# Known Issues — what is open today

**Last verified: 2026-10-23 (America/Chicago)** against `main` at `62ca3b640` (code, migration files, merged
PRs). Live-database facts were NOT re-read for this rewrite (no database access in this pass): any "applied
live" statement below is the older record's claim, and every such claim is marked as such.

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
| Open or partly open entries (KI-01 to KI-52 and KI-72 to KI-78; several bundle related small items; includes the entries or sub-items marked UNVERIFIED) | 48 |
| Accepted by Mason (KI-60 to KI-71) | 12 |
| Closed as FIXED during this rewrite, with proof (bottom of file) | 6 |

Highest-priority open items, in order: KI-01 (field data readable by any signed-in user), KI-02 (cost and
margin still readable at the table level), KI-10 (about 69 functions still replay a saved answer on the retry
key alone), KI-04 (tools with no permission rule run without a prompt), KI-18 (UTC/browser-clock season can
suppress the pre-harvest safety warning).

---

## Security and access

### KI-01 — Drivers and applicators can read every customer's fields and some money totals
**HIGH · OPEN · security · Mason approval needed to narrow permissions; fix in flight as draft PR #1065**
Any signed-in account, including drivers and applicators, can call database functions that return every
customer's field boundaries, owners, billing splits, balances and the company-wide overdue list, because the
functions never check who is asking. Applicators can also read every field-table row, not only the fields
they were dispatched to. Proven by read-only impersonation on 2026-10-22. Planned as three parts: A (functions,
PR #1065 draft, not merged), B (tables), C (the job route). Parts B and C have no PR. Related lows: dispatched
applicators can read chemical cost; any sales rep can edit another rep's draft field-invoice billing; invoice
emails put the invoice number and date into HTML unescaped (`src/lib/emailService.ts:123-139`).

### KI-02 — Product cost and margin are still readable through table columns
**HIGH · PARTIAL · security/money · Mason (step 3 apply approval)**
Mason decided cost and margin are admin-only. Screens and report functions were changed (migrations
`20261019010000`, `20261019230000`) and purchase-order cost is locked (`20261021140000`, `20261021141000`,
PR #980). Still open: sales reps, drivers and applicators who query the database directly can read the raw cost
columns (product cost; quote, order and invoice line cost), and reps can infer cost by trial-and-error quote
prices. The final column lock waits on a supporting `invoices_postable` view (PR #1057, open) and then Mason's
approval. Includes the older sub-items "reps can recover application-service cost" and "retire the old
`admin_set_application_service_cost` function" (no caller left in `src/`; no DROP migration exists).

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
- `profiles` may still grant `TRUNCATE`/`TRIGGER` to signed-in users (no revoking migration found; live grants
  not checked) — UNVERIFIED, LOW-MED.
- Customer-document post-apply check (browser storage policies removed, Documents tab still works) was never
  recorded; and a removed document cannot be reopened even by an admin — UNVERIFIED, LOW.
- Three older "reps work any customer" leftovers: signed-in rep click-through of `customer-document-files`
  still owed — LOW.
- A staff viewer can mint a temporary photo link (Mason accepted this, see accepted list KI-60).

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
**MED (latent) · OPEN · money/inventory/UI · unassigned (Mason to decide about one real accepted quote with no order)**
`src/pages/QuoteBuilder.tsx:3419-3421` marks the quote Accepted (releasing its inventory holds) before the order
is created. If the second step fails the quote reads as converted but has no order and its holds are gone;
pressing Convert again recovers. Two small database clean-ups (extra `quote_sections` privileges and a loose
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

### KI-15 — Reports > Profitability reads stored order profit, not the server report
**MED · OPEN · money/UI · unassigned**
`src/pages/Reports.tsx:299-375` computes margins in the browser from `orders.total_profit` / `order_items.profit`;
the server report `get_profitability_report` (cost at time of sale) has no caller. Numbers can differ.

### KI-16 — Sub-cent and rounding gaps
**MED/LOW · mixed · money · unassigned**
- `baseUnitOfRate` (`src/lib/chemCalculator.ts:559`) drops everything after `/`, so "oz/cwt" reads as "oz".
  Saving a job with such a unit is refused by the database (`20260820120000`, PR #446, applied live per the older
  record); `_close_quote_as_applied`, the recipe-pricing path and the blend-ticket path (refuses only at billing)
  can still create such lines. MED.
- A zero-width character pasted into a rate unit makes a blend ticket un-invoiceable (fails closed; staff must
  retype). `normalize_rate_unit` does not strip invisible characters. LOW-MED.
- Split-acre shares are rounded to 2 decimals, so totals can differ from the field's acres by cents. UNVERIFIED
  (current body of `derive_customer_shares_from_fields` not located).

### KI-17 — Blend-ticket linkage picks one order line per product
**MED · PARTIAL · money · automatic matching unassigned**
`link_blend_ticket_to_order` still takes `ORDER BY sort_order, id LIMIT 1`. The invoice side now refuses to guess
when tier prices differ and asks staff to pick (PRs #982, #995, #1020). Automatic matching or splitting across
tiers is not built; the linkage field is not used for money today.

### KI-18 — Dates and seasons follow the UTC clock or the browser clock
**MED (safety path) / LOW · OPEN · money/UI · unassigned (fix the JobDetail one first)**
- Quote, order and rebate-claim numbers take their year from UTC (`generate_quote_number`, `generate_order_number`,
  `create_rebate_claim`); on 31 Dec 6 pm–midnight Chicago they get next year's number. Cosmetic. LOW.
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
Vendor-name merges, a 19-product category remap and ~20 junk-row deletes need his decisions (each changes history
or deletes real rows). About 105 of 204 stored EPA registration numbers are wrong (MED, compliance data; the
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

---

## Tooling, guards and CI (affect the agents and the build, not customers)

### KI-45 — A helper agent's report can latch, or clear, the hold
**MED · OPEN · tooling-guards · unassigned**
The hook that freezes outward actions when Mason says "stop" can mistake a helper's report containing that word
for his own words (`.claude/hooks/prompt-source-lib.mjs`, text-shape rules only). The complete fix needs Claude
Code to pass message origin.

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
- A `[E2E]` marker exempts a whole SQL batch (`.claude/hooks/live-testdata-lib.mjs:731`). MED.
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
- Whole-body hash pins on the quote-version trust chain must be updated in three files together (ACCEPTED, KI-63).

### KI-49 — Codex review tooling
**HIGH (per older record), mitigated · OPEN · tooling-guards/process · wiring a hook needs Mason's approval**
Running raw `codex review <scope>` from the repo root self-recurses, kills its own process and exits 0, which can
record a false "clean" review; the wrapper `node scripts/write-codex-push-proof.mjs` avoids it, nothing blocks the
raw form. Also: the Codex `/import` feature writes corrupted `source-command-*` adapters (commit blocker fixed,
importer cannot be turned off; Mason: keep visible, do not delete); `sync-agent-workflows.mjs` has thirteen
recorded limitations (lexical-only containment, junction/symlink and path-case edge cases; Mason: record, don't
patch); the guard-claim ratchet misses claims inside template strings and files outside the hook folders.

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
the fsmonitor override; `live-testdata-lib.mjs` read-side false positives (UNVERIFIED);
`scripts/land-pr.mjs:167` prints a `gh pr merge --squash --auto` command the merge guard refuses;
`src/lib/rlsContracts.test.ts:148-160` comment still says "NOT APPLIED" for `20260813080000`; the Phase 3
return-policy concurrency prover can't reach its chain (UNVERIFIED); no static guard catches invoice-type leaks or
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

---

## Accepted risks (Mason decided to live with these; do not re-open without a new decision)

| ID | What | Why accepted |
|---|---|---|
| KI-60 | A permitted staff member can mint a temporary link to a private photo | Mason, option A, 2026-10-14 |
| KI-61 | A `LOCK TABLE` in a migration does not stop an already-running call of the OLD function body | Mason 2026-09-03; both instances applied with zero activity; future migrations of that shape need a quiet rollout and a concurrency proof |
| KI-62 | Live migration ledger has older entries with no file on `main` | Pre-existing drift, not new |
| KI-63 | Quote-version trust chain is hash-pinned in 3 files (`quote-versions-rpc-owned.sql`, migration `20260826220000`, `quoteVersionWriteBoundary.test.ts`) | Intentional friction; a change must update all three |
| KI-64 | All agents share Mason's admin GitHub identity; the manual merge override is fenced only by command matching | Mason declined a separate non-admin credential twice (2026-09-01) |
| KI-65 | The write-time actor-binding guard is bypassable by design limits | Capped by decision 2026-09-01; real controls are Codex review and post-apply sweeps |
| KI-66 | `review-proof-guard` denies destructive commands that spell out a worktree path | Mason "document, don't fix" 2026-08-20; use relative paths |
| KI-67 | `sync-agent-workflows --write` overwrites an unusable manifest; the `.agents/` drift sweep reads disk, not the git index | Mason 2026-09-03 |
| KI-68 | `adjust_inventory` accepts a retry key with control characters; a suspended second tab can resend a stale batch adjustment | Mason accepted 2026-09-20 / 2026-09-13; no caller can produce it; revisit if duplicate adjustments appear |
| KI-69 | Return-credit behaviours staff will see (late return credits stay in the current season; a funding invoice can't be deleted until the credit is voided) | Mason policy 2026-08-26 |
| KI-70 | Proof-file self-attestation; migration-source provenance closes the quiet path only; shell string-reconstruction bypasses; worktree awareness is a session-start snapshot; `npm --prefix/--workspace` escapes the script-body guard; Edge Functions and ~130 legacy reads exempt from check lint rules | Accepted residuals under the "honest mistakes, not malicious agent" model |
| KI-71 | Renaming/deactivating a profile named in a commission split fails closed; PWA needs two reloads after a deploy; ExcelJS tests slow on a cold cache; JobDetail save test must re-click | Deliberate / expected behaviour |

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

### KI-73 — More field-access holes (extends KI-01; To-Do row 11.4, plus row 11.7)
**HIGH · OPEN · security · Mason approval to narrow permissions**
- `global_search` lets any signed-in user search customer names and contacts, order/invoice/delivery numbers and
  farm names; `get_notes_for_entity` lets any signed-in user with a record ID read its team notes (HIGH).
- Every active account reads every `customer_addresses` row (To-Do row 11.7; HIGH).
- Drivers can read every customer's billing splits and spray-record field/acres data through
  `field_billing_defaults` and `application_record_fields` (MED).
- Whole-job applicators keep access to completed, cancelled and soft-deleted jobs indefinitely, and dispatch access
  can survive a job deletion; affected functions include `start_job` and `complete_job` (HIGH).
- Opposite gap: dispatch-only applicators cannot read their assigned fields' shares, application records and
  details, attachments, or job-attachment photos (LOW).

### KI-74 — More cost exposure and prerequisites (extends KI-02)
**HIGH/MED · OPEN · security/money · Mason**
`blend_recipe_items` and cost fields reachable through field-billing and dispatch paths remain readable (HIGH).
Commission amount plus rate can reveal a rep's profit, and Quick Receive reveals which open PO line is cheaper
(MED). The computed field `invoice_post_version` reads the whole invoice row, so revoking invoice columns can break
posting: the cost-column lock must ship with a column-safe version design in the same change (MED). **Done in
`20261022090000` (PR #1057, applied live 2026-10-23):** the version is a computed field, `invoice_postable_version`, on
the `invoices_postable` view (every column but `total_cost_cents`), the seven screens read it there, and the cost lock then drops the
`invoices` overload.

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
- Whole-order invoice quantities and unit prices are not capped server-side (MED). Voiding a delivery whose invoice
  is posted leaves the invoice active; the office must issue a credit memo (MED). Removing a product from a
  scheduled delivery can leave its drafted invoice unpostable, and lowering a quantity leaves the draft over the
  delivery quantity until staff edit it (MED). Freezing a soft-deleted order can block cancelling or voiding its
  completed delivery (reversal needs a reviewed migration) (LOW). Draft invoice CS-2026-0055 is deliberately left
  (the other delivery was billed in Chem Man) (LOW). Integrity checks page by offset, so concurrent inserts or
  deletes can make a run miss or repeat a row (LOW, accepted).

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

KI-06 (audit log), KI-07 (profiles TRUNCATE grant, customer-document post-apply check), KI-16 (split-acre
rounding), KI-18 (AR-aging parts), KI-20 (per-delivery split, commission design choices), KI-29/KI-30
(live-data counts), KI-35 (ledger reconciliation), KI-41 (offline recovery), KI-52 (prover, live-testdata false
positives). Live-database facts need a read-only query by someone with access.

---

## Closed in this rewrite (each with proof; full original text is in the archive)

These were open-looking entries in the old file and are confirmed fixed on `main`. "Applied live" is the older
record's claim; this pass had no database access.

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

Also closed inside the old file's own headings before this rewrite (no new proof needed, see archive): the
Deliveries list scheduled-delivery gap (PR #964), smoke chains rotted by the PO cost lock, the regular invoice
editor posting old amounts, the filed-season date-edit guard, the last commission-cohort migration
`20260914100900`, and the `customer-document-files` v2 redeploy.

# CRX Manager — Current State

**Last verified:** 2026-09-26 for the migration ledger only (read-only ledger query against project
`rhyzpcqhnizqbxphqdkr`: 1011 rows / 1004 distinct names, `max(version)` `20260926163005`). Every
other section keeps its own date; nothing below was re-certified by that read.
**Update triggers:** re-read the ledger after any live apply; refresh the rest when a major feature
ships or quarterly, whichever comes first.

## Current state at a glance (2026-09-26)

- **Effective ordering high-water: `20260914100700_customer_document_bytes_server_only`** (ledger
  version `20260926163005`, applied live 2026-09-26). The effective ordering high-water is the
  newest applied row's effective stamp: its authored 14-digit name stamp, or, for a row registered
  under a bare name, a stamp synthesized from its ledger version. It is what the migration ordering
  guard compares, so a new migration must sort above it. Re-read live before numbering one; this
  line goes stale on the next apply. The full boundary history is in
  `docs/reference/migration-history.md`.
- **Applied since 2026-09-20 (authored name → ledger version):** `20260914100100_next_invoice_number_year_chicago`
  (`20260921141423`), `20260914100200_commission_history_report_replay_guard` (`20260921141451`),
  `20260914100300_refuse_stale_commission_payment_recipient` (`20260921141740`),
  `20260914100400_enforce_commission_payment_business_date` (`20260921141901`),
  `20260914100500_commission_dates_follow_chicago_business_day` (`20260922015509`),
  `20260914100600_latest_commission_recipient_label` (`20260922020038`), and
  `20260914100700_customer_document_bytes_server_only` (`20260926163005`).
- **Written but NOT applied (parked on `main`):** `20260914100800_bind_transfer_invoice_intent` and
  `20260914100900_repair_commission_history_label_snapshots`. Applying either goes through the
  `AGENTS.md` live-migration approval gate. While they wait on `main`, the pending-migration guard holds any later-stamped file
  behind them.
- **Read ordering from the authored NAME, not from `version`.** The two diverge: the ledger
  `version` is the apply-time stamp. `.claude/schema-registry.json`'s `migrations_high_water` holds
  a **version**, so a "greater than high-water" rule compared against it silently skips files.
- **Schema registry:** `.claude/schema-registry.json` is stamped `generated_at` `2026-09-20` with
  `migrations_high_water` `20260920052149`, so it does **not** yet record the seven applies above.
  Open PR #799 regenerates it from live.
- **Customer documents:** the `customer-document-files` Edge Function went live as v1 on
  2026-09-22 UTC, the Documents tab that calls it merged in PR #764 (2026-09-22), and migration
  `20260914100700` (which removes every browser Storage policy on the bucket) applied 2026-09-26.
  Its preflight refuses to run if the bucket holds any object, so no signed link minted under the
  old policies can exist. Still open: sales reps cannot remove a document; PR #800 carries a parked
  fix migration that needs Mason's apply approval (details in the PR description).
- **Open pull requests:** run `gh pr list --state open` — any list written here goes stale within
  hours. On 2026-09-26 the one open PR that carries an owner decision is #800 (above).

## Migration and rollout record (condensed, point-in-time)

Every figure here was true when observed and is kept because this page is its only plain-English
home. Per-migration pins, proofs and postflight live in `docs/reference/migration-history.md` and
`docs/manual/KNOWN_ISSUES.md`; those win on any conflict.

**How the ordering boundary moved (September 2026).** `refuse_null_job_field_acres` (authored
`20260904185900`, PR #606) applied 2026-09-05 under a bare ledger name with no 14-digit prefix
(ledger `20260905185938`), so a name-ordered query could not see it; the ordering guard synthesizes
`<version>_<name>` for such a row. History row 916 records the mismatch and was reconciled on
2026-09-07. The boundary then moved to `20260906120000_preview_field_app_season_follows_invoice_date`
(ledger `20260908045843`, 2026-09-08), `20260908120000_close_pr535_live_gaps` (row 923, ledger
`20260909023300`, 2026-09-08), `20260908130000_bind_create_inventory_hold_receipt_to_intent`
(row 927, ledger `20260915033227`, 2026-09-15, PR #691), `20260911120000_bind_adjust_inventory_receipt_to_intent`
(row 930, ledger `20260920052149`, 2026-09-20; landed on `main` by PR #739 — #664, which first
carried the file, closed unmerged — and the `20260908140000_number_generators_year_chicago` six-generator year fix for issue #617 applied
just before it under `20260920051333`), `20260914100400` (2026-09-21), `20260914100600`
(2026-09-22) and `20260914100700` (2026-09-26). Counters such as row counts and `max(version)`
move with every apply by any lane; a stale count is expected drift, not evidence of a problem.

**The 2026-09-14 commission cohort.** The set was restamped together on 2026-09-05 and again on
2026-09-14 (from `20260905200000`..`20260905210000`) to sort above newly applied rows, preserving
its order; `20260905200500` was superseded before apply and is not a file. In order the files:
move the invoice-number year to Chicago time; harden commission snapshot replay; refuse a payment
batch whose recipient went stale before posting; enforce an America/Chicago payout business date;
make commission source dates follow the Chicago business day (`20260914100500`, which drains old
writers, replaces both commission helpers and all four source-document writers in one transaction,
and uses a transaction-local marker plus three owner-only compatibility triggers so a cached
pre-cutover body is refused and retried); and make balance-report recipient labels follow the
latest earned-state observation at the requested cutoff, including paid-only rows. `100100`
through `100600` are applied. The two still parked:
- `20260914100800_bind_transfer_invoice_intent` (formerly `20260908130800`) is the transfer intent
  wrapper. Its first-apply prerequisite, `20260914100500`, is now satisfied.
- `20260914100900_repair_commission_history_label_snapshots` (renumbered from `20260905020100`, and
  briefly `20260908130900` on PR #638's closed branch) appends corrected labels for 34 un-settled
  opening commission snapshots. It is last on purpose: it refuses to run once any commission payment
  has been posted, and running last means that refusal stops nothing else.

**`20260908130000` hold-receipt binding (applied 2026-09-15).** Applied with Mason's explicit
in-chat approval and a fresh CLEAN `gpt-5.6-sol`/high apply proof. Post-apply checks confirmed the
authenticated-only SECURITY DEFINER wrapper, the private impl with no client EXECUTE, and the
enabled `guard_create_inventory_hold_insert_20260913` trigger. The exposure look-back (run
2026-09-15) found all 29 holds ever created (newest 2026-04-28) were made by staff who are active
admins today; it cannot show whether the NULL `p_force` path or the inactive-profile path was ever
used, because `p_force` is not stored and profile state is read as of today. The related
manual-hold same-key race is `RESOLVED 2026-09-15` in `docs/manual/KNOWN_ISSUES.md`; the
pre-apply preflight detail is history row 927.

**A merge is not an apply.** `main` can lag production and production can lag `main`: F06
(`20260903150000_job_chemicals_persist_driver`, PR #582) sat merged-but-unapplied until it applied
under `20260903153402`. Confirm each against live separately, and any migration whose safety
argument rests on "the live body equals the last committed body" must verify against live. Live
`save_job` is one overload at body md5 `8acf34542105a90212ddb0a5e7c5d272`, the body of
`20260904185900_refuse_null_job_field_acres` (it replaced F06's `18d08d5f40aea91fe13ac3e5a686c549`).

**Disk-vs-live file gaps are closed.** PR #535 (merged 2026-09-08) restored its six already-live
`20260831*` files; PR #592 (2026-09-08) restored `20260903150100_ledger_backed_commission_history`
and `20260903230000_commission_report_snapshot_contract`; PR #599 (2026-09-11, `791bc3d86`) put
`20260904180000_invoice_season_follows_invoice_date` on `main`.

**Earlier applies still worth knowing:**
- **F2 number-generator gate** — applied, ledger `20260904023121`; the F2 entry in `KNOWN_ISSUES.md`
  carries the eight-generator security/grant matrix.
- **Commission history is live from the first complete post-cutover Chicago day.**
  `20260903150100_ledger_backed_commission_history` applied 2026-09-03 (ledger `20260903202611`),
  after a first candidate was rejected for backdating mutable current state. It adds
  `commission_payments.voided_at`/`voided_by`, `commissions.cancelled_at` plus immutable
  `cancelled_amount_cents`, one immutable cutover record, an append-only earned-state ledger, and a
  signed posted/voided settlement ledger. Reports read only those immutable events, including
  paid-only negative balances after a later cancellation or soft delete. The cutover is
  `2026-09-03T20:26:11.402245Z`, so the first supported Chicago date is `2026-09-04`; earlier dates
  (and the partial apply day) fail closed. Reports shows the recipient balance summary and the
  payment-by-payment detail, capping future-ending presets at Chicago-today. New and revised
  commissions must carry an `order_date`; payouts reject negative items or a payment date before the
  order date. Zero-dollar commissions stay settleable and count as pending until a signed post
  event exists. Postflight: 35 opening events (33 baseline, 2 legacy-excluded zero-dollar
  cancellations), zero settlement events.
- **PR #535 gauntlet chain** — six migrations applied 2026-09-03 (`20260831160000`,
  `…161000`, `…162000`, `…212415`, `…233000`, `…235900`). `update_vendor_bill` is a single
  9-argument overload accepting `p_confirm_po_overage`/`p_po_overage_reason`; the cycle-count
  revision guard (`CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN`) is live, and the frontend half merged as
  `914a6d36a`, so `src/pages/CycleCounts.tsx` always sends `p_expected_item_revision`. That is what
  made row 923 safe to apply.
- **PR #361 return-credit chain** — all six (`20260827041000`..`20260827041500`) applied 2026-09-01
  in order with Mason's approval, each behind a migration-apply-guard proof and verified by
  read-only live query. The temporary `aa_crx_block_return_credit_during_cogs_cutover` barrier was
  removed by the last file, so return-credit issuance is open. Per Mason's 2026-08-26 decision an
  issued return credit uses the season of the current America/Chicago business date, so prior
  year-end summaries never restate (a late return can show negative usage in the current season).
  Production then had zero credited returns and zero credit memos. The rejected `20260827223000`
  ledger-order trigger was never part of the chain and remains unapplied.
- **Section 9 remediation** — `20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard`
  and `20260826222000_correct_ap_aging_due_date_buckets` applied 2026-09-01. `get_ap_aging` is one
  overload taking `p_as_of_date` with the five-bucket due-date contract; `get_ap_dashboard_summary`
  takes `p_idempotency_key` and keys on `due_date`.
- **Draw-down chain** — all four migrations applied 2026-08-24; the rollout record is in
  `docs/reference/migration-history.md`. **Booking draws are RESUMED:** Mason released the pause in
  chat on 2026-08-25 (`docs/manual/DECISION_LOG.md`, 2026-08-25). No end-to-end production draw had
  been observed at release; Mason resumed knowing that. Do not re-impose the pause on that gap
  alone — only on new evidence of an actual defect.
- **`20260820120000` save-job chemical-unit invariant** (history row 891) applied 2026-08-25
  (ledger `20260825142708`); any document still calling it parked is out of date.
- **CRX-SEC-1 `20260813080000_lock_quote_versions_writes_to_rpc`** (row 886) applied 2026-08-16
  (ledger `20260816174353`). `quote_versions` has one policy, `qversions_select`; `authenticated`
  holds SELECT plus MAINTAIN and `anon` holds MAINTAIN only (MAINTAIN reads and writes no rows), so
  browser roles cannot write it; `metabase_ro` holds SELECT but has no policy, so it reads zero rows. The assertion-only `20260813070000_pin_return_idempotency_helper_contract`
  keeps `check_idempotency_intent` a single `postgres`-owned SECURITY DEFINER overload with no
  anon/authenticated/service_role EXECUTE.
- **Wave A** — six drafts `20260813010000`..`20260813060000` are PARKED under
  `scripts/.staging-migrations/`, NOT applied, and must be restamped above the then-current
  high-water before any governed apply (sha256 pins: history rows 872–877).
- **2026-08-10** — `20260810183629_reconcile_pending_commission_snapshots` (ledger `20260810235207`)
  had been applied with no file in git; it was recovered byte-for-byte from the ledger and is on
  `main`. Three whole-cent migrations (rows 868–870) applied with Mason's approval; a 2026-08-19
  re-check found 8 validated `*_whole_cents_chk` constraints and 4 deferred columns
  (`DECISION_LOG.md`). No live row was modified; CodeRabbit's "use bigint cents" finding on PR #354
  was closed won't-fix with a hard guard substituted
  (`docs/audits/2026-08-10-order-profit-bigint-cents-evaluation.md`).
- **2026-08-09** — the five foundation-ultra-review migrations (rows 857–861,
  `20260809170500`..`20260809170900`) applied; `20260809170900` applied against a finding
  `KNOWN_ISSUES.md` had recorded as blocking (full account there), and the commented-out
  fractional-cent repair inside `20260809170800` was not run.
- **Team Board delegation** — `20260809130108` and `20260810010308` are live, the rollback-only
  chain smoke reached exact `SMOKE_PASS_ROLLBACK` (2026-08-11 closeout), and the frontend merged in
  PR #351. See "Recent production deployments" below.
- **2026-08-07** — `20260807215532_profile_role_lock_covers_insert` and
  `20260807220323_log_customer_fact_rpc` applied; Section 4 bulk-order-import hardening is live (see
  the 2026-08-05 deployment entry below).

## Open-PR landing queue

The 2026-09-11 backlog plan (`docs/plans/2026-09-11-open-pr-backlog-plan.md`) and its queue are
finished; its guard-policy window ran to 2026-09-25. Of its rows, #599, #630, #646 and #651 merged; #624, #626,
#634, #635, #638, #647, #449 and #544 closed (#635 was replaced by the merged #764, and #544 by
issue #747). #605, #612 and #631 are still open. Its follow-up about locked
pending-request dialogs lives in `docs/manual/KNOWN_ISSUES.md`, and the staff recovery steps are in
`docs/workflows/INVENTORY_RULES.md`. For the live list, run `gh pr list --state open`.

## Recent production deployments

- **2026-09-22 → 2026-09-26 (customer documents served only through the server):** the
  `customer-document-files` Edge Function was deployed live as v1 on 2026-09-22 UTC with Mason's
  in-chat approval (ACTIVE; signed-out calls refused; preflight answers the production origin); the
  Documents tab that calls it merged in PR #764 (`d0be12d53`, 2026-09-22); and migration
  `20260914100700_customer_document_bytes_server_only` applied 2026-09-26 (ledger
  `20260926163005`). See "Current state at a glance" above.

- **2026-08-11 verification (Team Board delegation fully live and deployed):** Team Board delegation is live across two migrations. `20260809130108_team_note_completion_rpc_and_assignment_notify` added the governed completion RPC — which admits the creator, current assignee, or an active admin — plus the assignment trigger that notifies active assignees and avoids self-notifications. Review then found the trigger lacked an active-actor gate, closed by `20260810010308_active_team_note_assignment_actor` (authored as `20260809154649`), which requires an active profile in both the `tnotes_insert` policy and the trigger itself. The full rollback-only chain passed against live with exact `SMOKE_PASS_ROLLBACK`, covering assignee completion, outsider and inactive-actor denials, replay/mismatch behavior, assignment notifications, and grants. The schema registry was then refreshed through the live high-water of that day, `20260810235207`. The UI caller and notification deep-link changes were carried by PR #351 (merge commit `8dcb82fb`), and closeout PR #372 merged as `261d10bd`; Vercel reported the production deployment successful and `/team-board` returned HTTP 200 with the app shell.

- **2026-08-05:** Section 4 bulk-order-import lifecycle hardening is live through `20260806023048_surface_bulk_import_inventory_warnings`. The import RPC creates confirmed orders only, reserves inventory through the normal prebook/ledger model, returns canonical Net Position warnings, records order activity, binds retries to the original actor/payload, rejects non-finite values, locks Product cost into one bigint-cent immutable snapshot, keeps line profit whole-cent, and creates commissions from trigger-canonical stored profit. Live catalog and grants, an active-sales-rep rollback smoke with false caller cost, fractional lines, changed-intent replay, and forced shortage, zero fixture residue, all 21 invariant predicates, and a genuine schema-registry refresh passed.

- **2026-07-30:** AP period-close boundary hardening is live via `20260731001654_ap_period_close_boundary_hardening`. `record_vendor_payment`, `void_vendor_payment`, and `void_vendor_bill` now serialize with close using the established date semantics. Authenticated users have SELECT-only access to `accounting_periods`; close/reopen remain the governed mutation path. Sol-high review, six concurrency schedules, live catalog proof, rollback smoke, and zero-remnant checks passed. This is AP-only; 26 other live period-check callers remain outside the protocol.

- **2026-07-30:** Quote and Customer optimistic concurrency is live via `20260730235031_quote_customer_row_version_guard` (submitted as `20260730201230`). Whole-record saves, version snapshots, restores, and conversion reject stale tokens under the parent lock; browser roles cannot write Quote/Customer child collections directly. Postflight catalog/ACL checks, four rollback-only behavior chains, zero-residue checks, and all 21 live invariant predicates passed. PR #290 deployed the compatible frontend first; cached pre-migration bundles fail closed until refreshed, and no rollout toggle is required.

- **2026-07-30:** Accounting-period close write serialization is live via `20260730114102_vendor_bill_period_close_lock`. The post-apply catalog, ACL, and whole-month-constraint checks passed; the rollback-only business chain reached its expected `SMOKE_PASS_ROLLBACK` terminal. Residual hardening remains: direct authenticated-admin writes to `accounting_periods`, existing vendor-bill completeness at close, and the broader non-vendor-bill writer race.

- **2026-07-30:** Same-key accounting-period-close defense-in-depth follow-up is live via `20260730124308_close_accounting_period_idempotency_recheck`. The post-month-lock recheck is structurally asserted; the current helper's first key-only transaction advisory lock supplies behavioral same-key serialization. Sol mutation testing removed the later block and the current behavioral proof still passed. Live catalog proof and fixed-date delivery rollback smoke passed. Independent all-20 sweep: 7 raw/7 allowlisted/0 new rows across 5 predicates.

- **2026-07-30:** Accounting-period date math is explicitly time-zone-independent via `20260730140808_accounting_period_immutable_date_math`. It changed no business rows; live proof found one validated two-cast constraint, 9 valid period rows, and the close RPC's owner/security/search-path/ACL/lock/replay contract intact.

- **2026-07-30:** Validation-only postflight `20260730174628_vendor_bill_month_lock_helper_acl_postflight` is live exactly once at the 930-row ledger high-water (authored as `20260730170743`, then B7-renamed). It adds no schema or business data: it verifies the month-lock helper is uniquely `postgres`-owned, SECURITY INVOKER, on `search_path=public, pg_temp`, and executable by `postgres` alone; API roles are denied. The three governed callers must be unique `postgres`-owned SECURITY DEFINER routines. The network-isolated replay now covers 12 pre-candidate migrations plus 4 candidates (16 total) and rejects temporary untrusted-owner and custom-EXECUTE-grantee mutations before clean replay.

- **2026-07-28:** `process-document` Edge Function deployed v20 → v21 from merged PR #268
  (`7c096444`). Re-verified live 2026-07-29 by read-only `list_edge_functions`: version **21**,
  status `ACTIVE`, `verify_jwt=true`, and the deployed bundle read back with
  `VISION_OCR_TOTAL_TIMEOUT_MS = 120_000` and a shared `AbortSignal.timeout`. The production **boot**
  path returned HTTP 200 for `https://croprxsolutions.app` — that is a reachability check only and
  says nothing about CORS, since no preflight was issued and no
  `Access-Control-Allow-*` response headers were captured. **The signed-in document-upload/OCR path still needs one real-app
  smoke test** — that is the outstanding item, not the deploy itself.

## 1. Reality check

CRX Manager is the live production operations app for Crop RX Solutions at
`https://croprxsolutions.app`. It is feature-rich — core sales/ops, sell-side quote
lifecycle, field mapping and per-acre billing, inventory reservations, credit
memos, commissions, and a driver-facing Field Mode are all shipped and live.
The business is **actively using it**, but operational data is still ramping up:
the database was near-empty on 2026-06-13, and by 2026-07-12 it held roughly
153 customers and 604 products. As of the 2026-08-09 live re-read those two
numbers are still unchanged, but **deliveries are flowing through the app**
(108 recorded) while the dead legacy `payments` table remains at zero — see the table below. Treat this
as a business in early adoption: operational usage is real, and the money loop
(invoice → post → payment) **has** completed one real cycle — see the correction
below.

> **Correction (2026-08-08 foundation ultra review):** the `payments` row count
> below is not evidence the money loop is unexercised. `payments` is a **dead
> legacy table** with zero writers; the live ledger is `allocation_sets` +
> `prepay_credits`. On 2026-07-17 a $6,800 check was recorded against the owner's
> own customer record — $5,020.40 allocated to invoice CS-2026-0094 and $1,779.60
> booked as prepay credit — and both halves reconcile exactly. Do not read
> `payments = 0` as missing money or as an unrun money loop.

## 2. Live operational snapshot

Read-only counts against the live database (project `rhyzpcqhnizqbxphqdkr`),
**re-read 2026-08-19 UTC** by direct read-only query (the previous stamp was
2026-08-09). This is August data and has not been re-read since; these counts age
immediately — re-run before relying on them.

| Table | Count | Notes |
|---|---|---|
| customers | 153 | unchanged since 2026-07-12 |
| products | 604 | unchanged since 2026-07-12 |
| fields | 5 | field mapping/per-acre billing shipped, but growers not yet loaded in bulk |
| quotes | 4 | unchanged |
| orders | 65 | was 64 on 2026-07-18; unchanged since 2026-08-09 |
| invoices | 15 | 9 draft / 2 posted / 1 paid / 2 overdue / 1 unposted — was 13 on 2026-08-09. Re-read 2026-08-19 UTC: one `posted` invoice became `overdue` since the 2026-08-18 read. That is the `mark-overdue-invoices` cron doing its job, not a doc error — and it is the clearest illustration of the "these age immediately" caveat above, since this row went stale inside one day. |
| payments | 0 | **dead legacy table, zero writers** — real payments live in `allocation_sets` (1) / `prepay_credits` (1), both unchanged |
| order_items | 288 | unchanged in count. **Sub-cent rows are now 0** — see the whole-cent note below |
| commissions | 35 | unchanged in count. **Sub-cent rows are now 0** — see the whole-cent note below |
| jobs | 4 | unchanged |
| deliveries | 108 | deliveries are the most-used transactional surface; unchanged since 2026-08-09 |
| blend_tickets | 0 | none recorded yet |
| quote_versions | 3 | append-only snapshots; writable only through the reviewed RPCs since `20260813080000` applied live 2026-08-16 |
| negative inventory | 19 rows | `inventory.quantity_available < 0` — owner re-base pending (unchanged since 2026-07-18) |
| backup_snapshots | 878 rows | cumulative across the weekly in-DB snapshot runs; was 723 on 2026-08-09 |

> **Whole-cent money re-measure, read-only live 2026-08-18 — the historical
> sub-cent debt is nearly cleared.** Counting rows where the stored `numeric`
> value differs from itself rounded to two decimals (all five columns below are
> `numeric` with `numeric_precision` and `numeric_scale` both NULL — genuinely
> unconstrained, so this test is real and not vacuously satisfied by a column
> scale): `order_items.total_price` **0**, `order_items.profit` **0**,
> `commissions.commission_amount` **0**, `commissions.order_profit` **0**. Only
> `quotes.total_cost` still holds **2** sub-cent rows. This supersedes the
> 2026-08-10 figures still quoted in `docs/manual/KNOWN_ISSUES.md`
> (35 `order_items.total_price` + 2 `quotes.total_cost` + 3 + 3 `commissions`
> = 43 dirty **column-values**, summed across four columns rather than four
> disjoint row sets — the two `commissions` counts are 3/35 each and may be the
> same 3 rows, so distinct dirty rows were 40–43) and the older 46 + 3 = 49
> figure, which is a column-value sum in the same way. Note which term survived:
> the 2 `quotes.total_cost` rows are exactly the ones that did **not** clear.
>
> **Two of these zeros are enforced; two are only measured.** `order_items`
> carries validated whole-cent CHECK constraints on both columns
> (`order_items_total_price_whole_cents_chk`, `order_items_profit_whole_cents_chk`,
> both `convalidated = true`), so those zeros cannot regress. `commissions` has
> **no** whole-cent constraint on either `commission_amount` or `order_profit`
> — its only money CHECK is `chk_commission_amount (commission_amount >= 0)` —
> and `quotes` has whole-cent CHECKs on `total_price`/`total_profit` but **none
> on `total_cost`**. So the commission zeros are today's measurement, not an
> invariant, and nothing stops a future write from reintroducing sub-cent values
> there. **What cleared the commission rows is established:**
> `reconcile_pending_commission_snapshots` (ledger version `20260810235207`,
> applied live 2026-08-10 with Mason's approval) rounded `order_profit` to whole
> cents and recomputed `commission_amount` across exactly 11 pending rows. A first
> draft of this paragraph named `20260812115238_repair_historical_order_line_cents`
> as the only money-moving migration in the window and called the commission change
> unexplained; both were wrong, and the retraction with the full attribution is in
> `docs/manual/KNOWN_ISSUES.md`. `20260812115238` did move money — it rewrote order
> lines, and the canonical `trg_recalc_order_totals` trigger refreshed the order
> headers with them — but it never touches `commissions` directly.

> **Correction:** the 2026-07-13 snapshot reported jobs = 104 and deliveries = 0;
> the 2026-07-16 live read shows jobs = 4 and deliveries = 106. The two columns
> appear to have been transposed in the earlier snapshot (or usage shifted
> job→delivery in between) — trust the fresher numbers.

Note: `payments` and `blend_tickets` reading zero does not mean those features
are broken — it means the business hasn't routed real transactions through
those paths yet. Verify against code/tests, not against these counts, before
concluding a feature is unused or unbuilt.

## 3. Shipped feature map

Grouped, one-liner summary of what is LIVE in production today (see
`docs/CHANGELOG.md` for the dated entries these summarize):

- **Core ops:** customers, products, quotes, orders, invoices, payments, and
  accounts-payable (vendor bills/payments, purchase orders/receiving).
- **Supplier pricing:** quick Product-page edits and monthly XLSX batches both
  use preview, explicit approval, atomic governed apply, and one database
  history writer; supplier PDF price-list OCR is permanently retired.
- **CRM relationship intelligence (2026-07-17):** contacts + call logging,
  grower knowledge (facts w/ review queue) + call prep card, seasonal call
  lists (`/call-lists`), per-customer documents — built AI-receptionist-ready
  (Phase 5 seams recorded in the loop ledger).
- **Sell-side quote lifecycle:** quote builder, versions, templates, PDF
  quotes, convert-to-order.
- **Field invoices + as-applied billing:** field-level invoicing reconciled
  against unbilled deliveries, editable invoice editor.
- **Field mapping:** draw-your-own boundaries, shapefile import, USDA CSB
  (Crop Sequence Boundaries) click-to-adopt from the satellite map, two-acre
  model (full vs. edited acreage).
- **Per-acre billing + splits:** order/invoice-level field and acre
  allocations, multi-owner split invoicing, auto-split drafts on full
  delivery.
- **Inventory:** Layer 1 read-only shortfall warnings on scheduling; Layer 2
  job-level inventory reservations.
- **Credit-memo apply:** ledgered credit-memo application against invoice
  balances with reversal support.
- **Commissions:** job-level commission calculation and payment tracking.
- **Batch posting:** bulk invoice posting with posting-policy alignment
  across all posting surfaces.
- **Today dashboard + workflow waves:** Office Cockpit single morning screen
  (queues, KPIs, inventory), consolidated tabbed pages (field invoices,
  receiving, prepay, integrity).
- **Field Mode:** `/my-route` driver workspace for applicators/drivers.
- **EPA label lookup + data quality:** Wave 1 per-product "Look up EPA"
  lookup, admin `/label-data-quality` bulk EPA registration-number
  check-and-fix tool.
- **Lot capture/trace:** lot numbers captured and traceable through the
  chemical supply chain.
- **PDF outputs:** invoices, statements, quotes, and delivery slips.
- **Backups:** automated weekly in-database snapshot (pg_cron) plus a
  separate off-site weekly GitHub Action backup.
- **Morning cron reports** and **PWA/mobile overhaul** (bottom nav, phone
  card layouts, full-screen mobile modals).

## 4. What is NOT live

See `docs/manual/KNOWN_ISSUES.md` for the full parked/deferred/shelved list.
The three headline items:

- **Grower portal** — deferred (no customer-facing self-service portal yet).
- **Earmark engine** (prepay reserved-pool billing) — shelved, needs a
  reserved-pool redesign before it can be revisited.
- **OCR REI/PHI extraction** (re-entry interval / pre-harvest interval from
  label images) — deferred; flagged as a safety trap if done carelessly.

No longer in flight: the customer-document byte boundary is complete (Edge Function v1 live
2026-09-22, frontend merged in PR #764 on 2026-09-22, migration `20260914100700` applied
2026-09-26). The one open follow-up, letting sales reps remove a document, is parked in open
PR #800.

## 5. Environment facts

- **Production URL:** `https://croprxsolutions.app`
- **Supabase project:** `rhyzpcqhnizqbxphqdkr`
- **Deploy model:** a **merge to `main`** deploys production on Vercel
  automatically — there is no separate deploy step. Since the `protect-main`
  ruleset landed (2026-07-14) nobody can push to `main` directly. Landing
  follows the protected path in `AGENTS.md` and `.claude/commands/ship.md`:
  branch, the Codex review tier the change needs (plus the final exact-SHA Sol
  review for risky work), PR, required checks, resolved agent findings, a
  resolved CodeRabbit review of the frozen head, then an exact-head merge. The
  merge is the deploy.
- **Supabase plan:** FREE — no point-in-time recovery (PITR). The weekly
  in-database backup plus the off-site weekly GitHub Action dump are the
  only recovery mechanisms.
- **Time zone:** the live database and its scheduled jobs (pg_cron) run in
  UTC. Business hours are America/Chicago — convert explicitly when
  reasoning about "today" or cron timing.
- **Error monitoring:** Sentry, wired only through `src/lib/sentry` (never
  import the Sentry SDK directly elsewhere).

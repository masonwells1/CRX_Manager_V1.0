# CRX Manager — Current State

**Last verified:** 2026-07-30 (post-apply B7 closeout: ledger rows `20260730114102_vendor_bill_period_close_lock`, `20260730124308_close_accounting_period_idempotency_recheck`, and `20260730140808_accounting_period_immutable_date_math` are live. The final readback confirmed the validated whole-month constraint and close RPC use exactly two time-zone-independent casts each; 9 period rows remain valid and no business rows changed. The sole close overload retains `postgres` owner, SECURITY DEFINER mode, `search_path=public, pg_temp`, ACL boundary, two idempotency reads, and the month lock. Fixed-date delivery smoke reached expected `ERROR P0001 SMOKE_PASS_ROLLBACK`. The independently run post-follow-up all-20 sweep is CLEAN: 7 raw/7 allowlisted/0 new rows across the same 5 predicates. Operational counts below remain the separately dated 2026-07-18 snapshot.)
**Update triggers:** refresh when a major feature ships or quarterly, whichever first.

## Recent production deployments

- **2026-07-30:** Accounting-period close write serialization is live via `20260730114102_vendor_bill_period_close_lock`. The post-apply catalog, ACL, and whole-month-constraint checks passed; the rollback-only business chain reached its expected `SMOKE_PASS_ROLLBACK` terminal. Residual hardening remains: direct authenticated-admin writes to `accounting_periods`, existing vendor-bill completeness at close, and the broader non-vendor-bill writer race.

- **2026-07-30:** Same-key accounting-period-close defense-in-depth follow-up is live via `20260730124308_close_accounting_period_idempotency_recheck`. The post-month-lock recheck is structurally asserted; the current helper's first key-only transaction advisory lock supplies behavioral same-key serialization. Sol mutation testing removed the later block and the current behavioral proof still passed. Live catalog proof and fixed-date delivery rollback smoke passed. Independent all-20 sweep: 7 raw/7 allowlisted/0 new rows across 5 predicates.

- **2026-07-30:** Accounting-period date math is explicitly time-zone-independent via `20260730140808_accounting_period_immutable_date_math`. It changed no business rows; live proof found one validated two-cast constraint, 9 valid period rows, and the close RPC's owner/security/search-path/ACL/lock/replay contract intact.

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
153 customers and 604 products. As of this snapshot (2026-07-18) those two
numbers are unchanged, but **deliveries are now flowing through the app**
(107 recorded) while payments remain at zero — see the table below. Treat this
as a business in early adoption: operational usage is real, the money loop
(invoice → post → payment) has not completed a real cycle yet.

## 2. Live operational snapshot

Read-only counts against the live database (project `rhyzpcqhnizqbxphqdkr`),
captured 2026-07-18. These age immediately — re-run before relying on them.

| Table | Count | Notes |
|---|---|---|
| customers | 153 | |
| products | 604 | |
| fields | 5 | field mapping/per-acre billing shipped, but growers not yet loaded in bulk |
| quotes | 4 | |
| orders | 64 | |
| invoices | 11 | 8 draft / 2 posted / 1 paid |
| payments | 0 | none recorded yet |
| jobs | 4 | |
| deliveries | 107 | deliveries are the most-used transactional surface |
| blend_tickets | 0 | none recorded yet |
| negative inventory | 19 rows | `inventory.quantity_available < 0` — owner re-base pending |
| backup_snapshots | 1 run (120 table-rows) | weekly in-DB backup automation; first run captured 120 tables |

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

## 5. Environment facts

- **Production URL:** `https://croprxsolutions.app`
- **Supabase project:** `rhyzpcqhnizqbxphqdkr`
- **Deploy model:** a **merge to `main`** deploys production on Vercel
  automatically — there is no separate deploy step. Since the `protect-main`
  ruleset landed (2026-07-14) nobody can push to `main` directly, so landing
  work means: push a branch, open a PR, let the checks pass, read and resolve
  CodeRabbit's review, then merge. The merge is the deploy.
- **Supabase plan:** FREE — no point-in-time recovery (PITR). The weekly
  in-database backup plus the off-site weekly GitHub Action dump are the
  only recovery mechanisms.
- **Time zone:** the live database and its scheduled jobs (pg_cron) run in
  UTC. Business hours are America/Chicago — convert explicitly when
  reasoning about "today" or cron timing.
- **Error monitoring:** Sentry, wired only through `src/lib/sentry` (never
  import the Sentry SDK directly elsewhere).

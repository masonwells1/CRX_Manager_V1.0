# CRX Manager — Current State

**Last verified:** 2026-07-29 (re-read this date via the read-only Supabase connector: **920 ledger rows**, live high-water `20260729035923`. That top row is `application_service_atomic_save`, **applied live 2026-07-29** (authored `20260729024500`, stamped `20260729035923` at apply): the admin save of an application service is now **one** transaction. Row 836's carve-out had split the save in two — ordinary columns over PostgREST, then a second call to `admin_set_application_service_cost` — so a create whose second call failed left a service at cost `0`, reading as infinite margin. `admin_save_application_service(...)` writes name, rate, cost and the rest in a single `SECURITY DEFINER` call. Proven live both ways on a rolled-back impersonation block: a real sales rep gets `42501 INSUFFICIENT_ROLE`; a real admin creates and then edits a service with name, rate and cost all landing together. `admin_set_application_service_cost` is retained for one release on purpose (dropping it before the Vercel deploy would turn an occasional partial commit into a guaranteed one); retiring it is tracked in `docs/manual/KNOWN_ISSUES.md` §0d. The row beneath it is `application_service_cost_admin_only`, **applied live 2026-07-29** (authored `20260729003600`, stamped `20260729015706` by Supabase at apply): `application_services.cost_per_acre_cents` is now admin-only via a column-privilege carve-out, with `admin_get_application_service_costs` / `admin_set_application_service_cost` restoring admin access. Proven live both ways — a real driver gets `42501` on the column and on both RPCs, a real admin reads and writes through them (impersonation block rolled back, no data changed) — and all 19 `db-invariant-sweeps` predicates re-ran clean afterwards. Every other claim below was checked against that same read and none changed. Prior stamp, still accurate: 2026-07-28, read-only Supabase `list_migrations` confirms **918 ledger rows** and live high-water `20260728233459`; `secdef_pricing_reads_office_only` is applied live. The live July 27 table hardening and July 28 RPC hardening now jointly restrict quote pricing, per-customer rates, rebate terms, and the two remaining `SECURITY DEFINER` pricing readers to the intended office roles. Regression guard: `scripts/db-invariant-sweeps/predicates/office-only-pricing-secdef-gates.sql`. Both halves of the anon-EXECUTE revoke are also applied live — ledger `20260728231350` for the 40 functions in no RLS policy and `20260728233459` for the `is_admin`/`is_applicator`/`is_driver` role helpers — so logged-out callers no longer reach any of the 43, including the six `next_*_number()` allocators, `calculate_billing_splits` and `check_period_open`, which had no auth gate of any kind. See `docs/manual/KNOWN_ISSUES.md` §0c.)
**Update triggers:** refresh when a major feature ships or quarterly, whichever first.

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

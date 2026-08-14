# CRX Manager — Current State

**Last verified:** 2026-08-14 UTC for repository state; live facts remain from the 2026-08-13 read-only recovery check. The live ledger has 970 rows and ends at assigned version `20260813011751`, carrying submitted name `20260813070000_pin_return_idempotency_helper_contract`. The six recovered money/pricing versions after the prior 962-row Customer 360 high-water are `20260812034831`, `20260812034951`, `20260812145628`, `20260812151606`, `20260812154028`, and `20260812154757`. Five exact applied sources are tracked as migrations. The sixth applied payload contains customer-linked financial preimage data and is therefore represented only by its live ledger identity, exact normalized byte count and SHA-256; no different SQL is published under that applied version. A separately named, digest-bound recovery replay lives outside `supabase/migrations/`. The two later return-credit versions are `20260812212323` and `20260813011751`, now reconciled from merged PR #388. The schema registry and captured-ledger proof snapshot both match that 970-row live high-water. Team Board deployment details below remain current; operational counts below remain the separately dated 2026-07-18 snapshot.

**Multi-price quote-draw edge remains open; the unsafe local candidate was removed.** The live private `draw_down_quote` implementation can average same-product quote lines into a half-cent unit price, which the live whole-cent guard correctly rejects. Review proved the proposed cumulative-rounding/floored-unit-price repair could underbill a reconstructed invoice by one cent and could reuse a cent allocation after a reversible job draw was cancelled. No forward fix is prepared; the durable design needs cent-priced cohorts or an immutable allocation/revenue ledger.

**Restore owner-implementation ACL — local candidate, not applied.** The public `restore_quote_version` path already rejects cross-operation idempotency-key reuse and enters the below-cost wrapper, but the internal `_restore_quote_version_owner_impl` remained directly executable by `service_role`. `20260813090000_restrict_restore_quote_owner_impl.sql` is a permission-only candidate that fingerprints the live wrapper/idempotency chain, revokes direct application-role execution, and leaves `postgres` as the sole direct caller. It changes no function body, row, RPC signature, or browser contract.

**Quote draw-down ownership/deletion boundary — local candidate, not applied.** Exact review found that the live private draw implementation locks a quote but does not bind an active sales rep to `quotes.created_by` and does not reject `deleted_at`. `20260813161614_restrict_draw_down_quote_owner.sql` is a forward-only body replacement behind the unchanged governed public wrapper. It requires the owning rep or an active admin after the quote lock, hides soft-deleted quotes, performs both checks before idempotency replay or mutation, and ships with a container-only two-rep rollback chain. No live state has changed.

**Fresh below-cost reason boundary — local candidate, not applied.** The applied JSON reason parser can recursively rediscover an older approval marker in persisted invoice or quote notes when the current attempt supplies no reason. `20260814041419_fresh_below_cost_reason.sql` makes an explicit `below_cost_reason` key authoritative even when null or blank. The compatible browser sends explicit null on the first JSON-backed attempt, strips old markers from legacy note transports, and sends only the freshly typed reason on retry. No live state has changed.

**Historical quote-version restore quarantine — integrated into the local write-boundary candidate, not applied.** The pending RPC-only boundary stops future browser-forged `quote_versions`, but the three rows already present live were created while authenticated callers could insert directly and cannot be proven server-authored after the fact. `20260813080000_lock_quote_versions_writes_to_rpc.sql` now holds one ACCESS EXCLUSIVE lock across the legacy-id capture, browser grant/policy removal, private forced-RLS immutable quarantine, and governed restore-wrapper denial. This atomic cutover prevents a legitimate RPC-created version from landing between separate boundary and quarantine migrations. A rollback smoke proves a captured legacy restore is denied while a version created after the boundary remains restorable. No live state has changed.

**Wave A — six migrations are PARKED DRAFTS (STAGED), NOT APPLIED.** As of PR #393 (2026-08-13) the six Wave A files live at `scripts/.staging-migrations/20260813010000`–`20260813060000` — moved **out** of `supabase/migrations/` so nothing can replay them. Their `20260813` stamps are **no longer forward of live**: a concurrent 2026-08-13 apply carries ledger name stamp `20260813070000`, ahead of the whole parked range, so the Phase 2 governed apply must restamp all six against the then-current high-water before applying (content is what the sha256 pins bind; the stamps are expected to change). They are **not applied**; no statement in this document describes state they created. Each is pinned byte-for-byte by a SQL sha256 in `docs/reference/migration-history.md` rows 872–877. They apply only through the Phase 2 governed apply pipeline with fresh proofs; the older `20260811…` copies on branch `claude/wave-a-money` are superseded.

**2026-08-10 live re-read, second read — the source gap it reported is now CLOSED.** That read recorded live ledger high-water **`20260810235207`**, **958 ledger rows / 951 distinct names**; an earlier read the same day, taken right after this session's three applies, showed `20260810155629` / 957 rows, a fourth migration having landed live from a concurrent session in between. Of the earlier `20260810` rows, `20260810000427` is the version Supabase assigned to merged file `20260809230500_single_canonical_line_profit.sql` (history row 862). That read also flagged two live rows as having no file in `origin/main`: `20260810025159_backfill_stale_line_profit` and `20260810235207` / name `20260810183629_reconcile_pending_commission_snapshots`, the latter having existed nowhere in git at all despite already having mutated real commission money — it was recovered byte-for-byte from `supabase_migrations.schema_migrations.statements` on 2026-08-10 (live md5 `b14d3dd7f8c5aa8fecd0549886d8bbb3`). **Both files are now present on `origin/main`, verified by `git ls-tree` on 2026-08-11**, so `supabase/migrations/` is once again a complete reconstruction source for that date. Full per-column conformance figures and the recovery detail are in `docs/manual/KNOWN_ISSUES.md` under the same date.

**2026-08-10 — three whole-cent migrations APPLIED LIVE.** History rows 868–870 (`20260810150000`, `20260810150500`, `20260810151000`) fix the commission-basis defect, round `quotes.total_cost` and the `quote_items` line money, and add whole-cent CHECK constraints to the 7 already-clean money columns. All three first executed end-to-end against a throwaway PostgreSQL 17 with every post-condition passing and mutation-tested to fail closed, then applied to live on Mason's explicit in-chat approval, in order, each behind its own freshly minted migration-apply-guard proof with both required reviewers clean. Supabase assigned ledger versions `20260810152935`, `20260810154721`, `20260810155629`. Post-apply live reads confirm the new function fingerprints and exactly 7 validated `*_whole_cents_chk` constraints, with the 5 deferred columns still unconstrained. **No live row was modified.** The schema registry was then rebuilt from live introspection. This is also the disposition of CodeRabbit's "use bigint cents" Major finding on PR #354: closed **won't-fix with a hard guard substituted**, rationale in `docs/audits/2026-08-10-order-profit-bigint-cents-evaluation.md`.

**Team Board delegation — both migrations APPLIED LIVE 2026-08-09.** The database half of the delegation fix is fully live across two migrations: `20260809130108` added `complete_team_note`, which authorizes the creator, current assignee, or an active admin through an actor-bound idempotent SECURITY DEFINER path, plus the assignment trigger that creates `task_assigned` notifications while suppressing self-assignment and inactive recipients; `20260810010308` then closed the inactive-actor path found by review, requiring an active profile in both the `tnotes_insert` policy and the trigger itself while leaving `tnotes_update` unchanged. Live catalog/grant checks, all 26 standing invariant predicates, and a genuine schema-registry refresh passed for the first migration, and the second was verified live after apply (policy shape, SECURITY DEFINER, pinned search_path, trigger attached and enabled, anon/authenticated EXECUTE denied on the trigger function). Behavior was proven by rollback-only probes against live: an active non-admin assignee completed a note they did not create, an unrelated employee was refused, a real deactivated profile was refused at the RLS layer, and with RLS bypassed the trigger's own guard raised `PROFILE_INACTIVE`. The compatible frontend shipped in PR #351, **merged 2026-08-10 (merge commit `8dcb82fb`)**, and its production deployment is live — delegated completion is reachable from the browser. The registered rollback-only chain smoke remains pending external execution because the Codex production guard refuses its intentional transaction-local writes.

**2026-08-09 live re-read.** An earlier read the same day recorded live ledger high-water at **`20260809130108`** with 946 ledger rows — exactly one row above the 2026-08-07 high-water — and noted that migration as applied from a concurrent session with no file in this repository. PR #351 lands that file and its follow-up, so the gap is closed; see `docs/reference/migration-history.md` rows 863 and 864.

**2026-08-09 later the same day — the five foundation-ultra-review migrations are now APPLIED LIVE.** History rows 857–861, re-issued forward as `20260809170500`–`20260809170900`, applied one at a time between 20:32 and 20:54 UTC. Each went through its own freshly minted migration-apply-guard proof with both required reviewers clean, followed by a live post-apply read. Supabase assigned ledger versions `20260809203222`, `20260809204044`, `20260809204435`, `20260809204855`, `20260809205423` in file order, and the schema registry was regenerated from live introspection to match. None of the five altered a table, column, constraint, or enum — every schema-shape section of the registry came back byte-identical. `20260809170900` applied against a review finding that `docs/manual/KNOWN_ISSUES.md` had recorded as blocking; that entry now carries the full account and the decision still owed to Mason. The commented-out fractional-cent repair inside `20260809170800` was **not** run — the 49 pre-existing fractional rows are untouched.
**2026-08-12 pricing rollout evidence (superseded for ledger high-water by the 2026-08-13 header above).** The live migration ledger then had 968 rows and high-water `20260812154757` (`20260812115238_repair_historical_order_line_cents`). The four release migrations submitted as `20260812115235`–`20260812115238` were live at assigned versions `20260812145628`, `20260812151606`, `20260812154028`, and `20260812154757`. The first three exact applied sources use their assigned-version filenames. The fourth private applied payload has no SQL under its ledger identity in the public migration directory; its exact live fingerprint and separately named recovery replay are documented under `supabase/recovery-replays/`. The schema registry and generated TypeScript database types were regenerated from live after that rollout. The later return-credit applies temporarily made that snapshot stale, and the 2026-08-13 recovery refresh reconciled both artifacts through the 970-row high-water recorded in the current header.

**Pricing-audit release status:** database rollout complete; repository delivery still in progress. Each migration received a fresh exact-byte machine proof immediately before apply. Migration 3's first transaction failed on missing `extensions.moddatetime()` and fully rolled back; replacing it with the established `public.update_updated_at()` trigger, re-running disposable proof and dual review, then retrying succeeded. The final repair was rehearsed rollback-only against the exact 35-line / 16-order production preimage before its durable apply. Live postflight now shows zero fractional/non-finite order-line prices, a validated whole-cent line-price constraint, zero header rollup mismatches, RLS plus three enforcement triggers for below-cost approvals, and no app-role direct line-table DML. The captured-ledger proof has been advanced to all 968 rows, and this release packet reran every rollback smoke against the applied state with zero residue. Remaining repository gates are final exact-commit review and green reviewed PR delivery.

**2026-08-11 post-deploy closeout, carried in from `origin/main`.** At that closeout read, the live ledger high-water was `20260810235207` (`20260810183629_reconcile_pending_commission_snapshots`, B7-renamed on disk to the assigned version), 958 ledger rows — the pending-commission-snapshot reconciliation that closed out the stale line-profit backfill. The header above supersedes those figures; they are kept here as the state that closeout observed. The prior high-water `20260810025159` (`20260810022500_backfill_stale_line_profit`) was the unrelated money-workstream migration that landed after the Team Board migrations. The database half of Team Board delegation is fully live: `20260809130108` added the actor-bound `complete_team_note` RPC and assignment-notification trigger, and `20260810010308` added the active-profile insert and trigger guards while leaving `tnotes_update` unchanged. Live catalog/grant checks passed, the full registered business chain reached exact `SMOKE_PASS_ROLLBACK`, and the schema registry was genuinely regenerated from live through the current high-water. The compatible frontend was carried by PR #351, **merged 2026-08-10 (merge commit `8dcb82fb`)**. Closeout PR #372 merged as `261d10bd` on 2026-08-11; its Vercel production deployment completed successfully, and `/team-board` returned HTTP 200 with the app shell. Operational counts below remain the separately dated 2026-07-18 snapshot.

**2026-08-08 addendum (carried forward):** the money-loop correction below and the `payments` row in the counts table were re-verified live on 2026-08-08 and are dated inline. No other line in this document was re-checked on 2026-08-08.

**2026-08-07 verification detail:** (post-apply). Live ledger high-water was then `20260807220323` (`log_customer_fact_rpc`). The two 2026-08-07 parked migrations are now APPLIED LIVE: `20260807215532_profile_role_lock_covers_insert` (profiles role-lock trigger now BEFORE INSERT OR UPDATE, non-admin logged-in inserts blocked with PROFILE_INSERT_LOCK) and `20260807220323_log_customer_fact_rpc` (`log_customer_fact` live: anon denied, authenticated granted, single overload). The Section 4 bulk-order-import lifecycle hardening is live through seven migrations: imports are confirmed-only, inventory-aware, activity-logged, actor/payload-bound for replay, and commission-safe; every imported line uses one locked bigint-cent Product cost snapshot, retains whole-cent profit, and commission profit is reread from the trigger-canonical order header. Canonical pre-reservation Net Position shortages are returned to the browser and recorded in activity. Post-apply catalog/grant checks, rollback proof, all 21 standing invariant predicates, and a genuine live schema-registry refresh passed. The earlier idempotency, statement disclosure, and historical AR report protections remain live as documented below. Operational counts below remain the separately dated 2026-07-18 snapshot.

**2026-08-09 ledger/count re-read:** the live ledger high-water and the entire section 2 counts table were re-read from the live database on 2026-08-09 and are dated inline. The 2026-08-07 feature/postflight detail below and the deployment log were **not** re-checked in that historical pass.

**2026-08-09 live re-read.** At the time of that read, live ledger high-water was **`20260809130108`** (`team_note_completion_rpc_and_assignment_notify`), 946 ledger rows — exactly one row above the 2026-08-07 high-water. Its disk migration and history entry are now reconciled on PR #351.

**2026-08-09 later the same day — the five foundation-ultra-review migrations are now APPLIED LIVE.** History rows 857–861, re-issued forward as `20260809170500`–`20260809170900`, applied one at a time between 20:32 and 20:54 UTC. Each went through its own freshly minted migration-apply-guard proof with both required reviewers clean, followed by a live post-apply read. Supabase assigned ledger versions `20260809203222`, `20260809204044`, `20260809204435`, `20260809204855`, `20260809205423` in file order, so **live high-water is now `20260809205423`** and the schema registry was regenerated from live introspection to match. None of the five altered a table, column, constraint, or enum — every schema-shape section of the registry came back byte-identical. `20260809170900` applied against a review finding that `docs/manual/KNOWN_ISSUES.md` had recorded as blocking; that entry now carries the full account and the decision still owed to Mason. The commented-out fractional-cent repair inside `20260809170800` was **not** run — the 49 pre-existing fractional rows are untouched.

**2026-08-07 verification detail:** (post-apply). Live ledger high-water was `20260807220323` (`log_customer_fact_rpc`) as of that date. The two 2026-08-07 parked migrations are now APPLIED LIVE: `20260807215532_profile_role_lock_covers_insert` (profiles role-lock trigger now BEFORE INSERT OR UPDATE, non-admin logged-in inserts blocked with PROFILE_INSERT_LOCK) and `20260807220323_log_customer_fact_rpc` (`log_customer_fact` live: anon denied, authenticated granted, single overload). The Section 4 bulk-order-import lifecycle hardening is live through seven migrations: imports are confirmed-only, inventory-aware, activity-logged, actor/payload-bound for replay, and commission-safe; every imported line uses one locked bigint-cent Product cost snapshot, retains whole-cent profit, and commission profit is reread from the trigger-canonical order header. Canonical pre-reservation Net Position shortages are returned to the browser and recorded in activity. Post-apply catalog/grant checks, rollback proof, all 21 standing invariant predicates, and a genuine live schema-registry refresh passed. The earlier idempotency, statement disclosure, and historical AR report protections remain live as documented below. Operational counts below remain the separately dated 2026-07-18 snapshot.
**Update triggers:** refresh when a major feature ships or quarterly, whichever first.

**Quote/customer row-version rollout is live:** PR #290 deployed the compatible frontend first, then `20260730201230_quote_customer_row_version_guard` applied under Supabase-assigned ledger/disk version `20260730235031`. Live catalog, trigger, overload, ownership, fixed-search-path, grant, and child-table ACL checks passed. Four rollback-only behavior chains reached exact `SMOKE_PASS_ROLLBACK`, zero fixture rows remained, all 21 standing invariant predicates had zero unallowlisted findings, and the schema registry was refreshed through the subsequent AP high-water. Cached pre-migration bundles fail closed until refreshed; no rollout toggle is required.

## Recent production deployments

- **2026-08-11 verification (Team Board delegation fully live and deployed):** Team Board delegation is live across two migrations. `20260809130108_team_note_completion_rpc_and_assignment_notify` added the governed completion RPC — which admits the creator, current assignee, or an active admin — plus the assignment trigger that notifies active assignees and avoids self-notifications. Review then found the trigger lacked an active-actor gate, closed by `20260810010308_active_team_note_assignment_actor` (authored as `20260809154649`), which requires an active profile in both the `tnotes_insert` policy and the trigger itself. The full rollback-only chain passed against live with exact `SMOKE_PASS_ROLLBACK`, covering assignee completion, outsider and inactive-actor denials, replay/mismatch behavior, assignment notifications, and grants. The schema registry is refreshed through live high-water `20260810235207`. The UI caller and notification deep-link changes were carried by PR #351 (merge commit `8dcb82fb`), and closeout PR #372 merged as `261d10bd`; Vercel reported the production deployment successful and `/team-board` returned HTTP 200 with the app shell.

- **2026-08-05:** Section 4 bulk-order-import lifecycle hardening is live through `20260806023048_surface_bulk_import_inventory_warnings`. The import RPC creates confirmed orders only, reserves inventory through the normal prebook/ledger model, returns canonical Net Position warnings, records order activity, binds retries to the original actor/payload, rejects non-finite values, locks Product cost into one bigint-cent immutable snapshot, keeps line profit whole-cent, and creates commissions from trigger-canonical stored profit. Live catalog and grants, an active-sales-rep rollback smoke with false caller cost, fractional lines, changed-intent replay, and forced shortage, zero fixture residue, all 21 invariant predicates, and a genuine schema-registry refresh passed.

- **2026-07-30:** AP period-close boundary hardening is live via `20260731001654_ap_period_close_boundary_hardening`. `record_vendor_payment`, `void_vendor_payment`, and `void_vendor_bill` now serialize with close using the established date semantics. Authenticated users have SELECT-only access to `accounting_periods`; close/reopen remain the governed mutation path. Sol-high review, six concurrency schedules, live catalog proof, rollback smoke, and zero-remnant checks passed. This is AP-only; 26 other live period-check callers remain outside the protocol.

- **2026-07-30:** Quote and Customer optimistic concurrency is live via `20260730235031_quote_customer_row_version_guard` (submitted as `20260730201230`). Whole-record saves, version snapshots, restores, and conversion reject stale tokens under the parent lock; browser roles cannot write Quote/Customer child collections directly. Postflight catalog/ACL checks, four rollback-only behavior chains, zero-residue checks, and all 21 live invariant predicates passed.

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
**re-read 2026-08-09** (from that day's off-site backup manifest plus two direct
read-only queries). These age immediately — re-run before relying on them.

| Table | Count | Notes |
|---|---|---|
| customers | 153 | unchanged since 2026-07-12 |
| products | 604 | unchanged since 2026-07-12 |
| fields | 5 | field mapping/per-acre billing shipped, but growers not yet loaded in bulk |
| quotes | 4 | |
| orders | 65 | was 64 on 2026-07-18 |
| invoices | 13 | 9 draft / 2 posted / 1 paid / 1 unposted |
| payments | 0 | **dead legacy table, zero writers** — real payments live in `allocation_sets` (1) / `prepay_credits` (1) |
| order_items | 288 | 46 of these carry sub-cent `total_price`/`profit` — see history rows 860–861 |
| commissions | 35 | 3 carry sub-cent `commission_amount`, incl. a $5,245.195 pending payout |
| jobs | 4 | |
| deliveries | 108 | deliveries are the most-used transactional surface |
| blend_tickets | 0 | none recorded yet |
| negative inventory | 19 rows | `inventory.quantity_available < 0` — owner re-base pending (unchanged since 2026-07-18) |
| backup_snapshots | 723 rows | cumulative across the weekly in-DB snapshot runs |

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

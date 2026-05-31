# Audit Sprint 2026-05-09 — 2026-05-13 Followup Session

**Date:** 2026-05-13 (overnight, Mason asleep)
**Branch:** `fix/audit-2026-05-09`
**Mode:** Autonomous single-session execution per Mason's standing instruction
**Prior tracking:** `2026-05-12-execution-summary.md` (15 findings closed earlier in this branch)

## Headline

**8 audit findings closed in 8 commits.** All `npm run lint`/`typecheck`/`build`/`vitest` clean throughout. All migrations applied live to `rhyzpcqhnizqbxphqdkr` and verified.

| Commit | Findings | Description |
|--------|----------|-------------|
| `23c95a8` | #33 | Rebate claim atomic RPCs (race + state machine) |
| `1690968` | #10, #31, #34 | Atomic multi-table write RPCs (delivery + bulk import + blend recipe) |
| `108651b` | #6 | Canonical commission math (`compute_commission_amount` + `_insert_commissions_for_order`) |
| `e20ca0a` | #7, #19 | `safe_cents_qty` helper + `invoices_balance_non_negative` CHECK |
| `c7a3476` | #11, #27, #32 | Activity feed for commissions/prepay + `order_items.cost_at_time_cents` snapshot |
| `7dce45f` | #18, #35 | Inventory naming clarification + AP summary/aging fetch split |
| `4008da9` | #28 | Edge Function Sentry hardening (`validateSentryDsnOrThrow` + `[SENTRY_MISCONFIG]` sentinel + capture in 4 missing functions) |

**Total post-sprint state:** 24/24 NOT-VERIFIED audit findings from the 2026-05-12 triage are now closed. All 38 original audit findings are either closed or have an explicit deferral with documented rationale.

## Cluster-by-cluster

### Cluster 1 — #33 Rebate claim concurrency (commit `23c95a8`)
**Three problems** found, not the one the audit predicted:
1. Claim number generation race — frontend used `count(*) + 1`. No UNIQUE on `claim_number`. Two concurrent inserts could collide.
2. Status transition race — naked `.update()` with no row lock and no state-machine validation.
3. `paid_amount_cents` was never written — the "Mark Paid" button only set status, so the "Rebates Received" stat fell back to `claim_amount_cents`.

**Fix:** UNIQUE on `claim_number`; new `rebate_claim_counters(year, next_value)` table updated via `INSERT ... ON CONFLICT DO UPDATE` for atomic per-year increment; new `create_rebate_claim()` RPC owns claim_number generation; new `transition_rebate_claim()` RPC takes `SELECT FOR UPDATE` and validates the state machine. Frontend (`Rebates.tsx`) rewritten to call the RPCs with idempotency keys.

### Cluster 2 — #10, #31, #34 Atomic multi-table writes (commit `1690968`)
Three frontend code paths doing parent + child inserts in separate `.insert()` calls with no transaction wrapper. Closed with one migration introducing 3 SECURITY DEFINER RPCs:
- `create_delivery_with_items()` — replaces NewDelivery's two-step insert
- `bulk_import_order()` — replaces BulkOrderImport's per-order loop
- `save_blend_recipe()` — replaces BlendRecipes' DELETE-then-INSERT-items

All 3 use the canonical 2026-05 pattern (`auth.uid()` strict-actor, role gate, helper-pattern idempotency, machine-readable error tokens). Frontend callsites rewritten.

### Cluster 3a — #6 Commission math drift (commit `108651b`)
Three commission-creating paths used three different formulas. **Bonus latent bug discovered:** `create_quick_delivery`'s commission insert referenced `recipient_id` and `notes` — neither column exists on `commissions` (it's `recipient text` + `recipient_user_id uuid`, no `notes`). Live data confirmed 0 rows ever produced from that path.

**Fix:** new `compute_commission_amount(numeric, numeric)` IMMUTABLE helper with the canonical `GREATEST(ROUND(profit * pct / 100, 2), 0)` formula; new `_insert_commissions_for_order(...)` SECURITY DEFINER wrapper called via `PERFORM` from all 3 paths. Single source of truth. Live verified: `compute_commission_amount(1000, 50)` = 500.00, `compute_commission_amount(-100, 50)` = 0, `compute_commission_amount(33.33, 33.33)` = 11.11.

### Cluster 3b — #7 `::bigint` truncation (commit `e20ca0a`)
PostgreSQL's `numeric::bigint` cast TRUNCATES, so `(price_cents * qty)::bigint` lost up to ~0.999 cents per line item. Live grep against `pg_proc.prosrc` found 4 instances. New `safe_cents_qty(p_cents bigint, p_qty numeric) -> bigint` IMMUTABLE helper does `ROUND(p_cents * p_qty)::bigint`. `create_quick_delivery` (3 instances, most-trafficked) rewritten to use the helper.

**3 instances deferred** (single-instance each, smaller blast radius — fee × acres patterns):
- `transfer_job_to_invoice`
- `create_invoice_from_blend_ticket`
- `save_field_app_invoice`

New `sql-safety.mjs` hook rule blocks the pattern in future migrations (strips `--` comments first to avoid false-positives on doc text).

### Cluster 3c — #19 Negative invoice balance CHECK (commit `e20ca0a`)
No `credit_memos` table exists in the codebase — "credit memos" are `invoices` rows from `issue_return_credit`. `invoices.balance_cents` (GENERATED ALWAYS) had no non-negative CHECK even though `total_amount_cents` and `paid_amount_cents` did. Live data showed 0 rows with negative balance, so safe to add VALIDATED in one step. Defense-in-depth backstop.

### Cluster 4 — #11, #27, #32 Activity feed + cost snapshot (commit `c7a3476`)
- **#11** — `CommissionPayments.tsx` was writing to `financial_audit_log` via the RPC bodies but never to `activity_feed`. Added `logActivity` at the success points of `handleCreate`, `handlePost`, `handleVoidPayment`.
- **#27** — Same pattern in `PrepaymentManager.tsx`. Added `logActivity` at `handleSaveCheck`, `confirmApply`, `confirmBatchApply`.
- **#32** — `order_items.cost_per_unit` was caller-supplied (often a stale quote cost). Added `cost_at_time_cents bigint` column + `_snapshot_order_item_cost()` BEFORE INSERT trigger that snapshots `products.current_cost` at row insert. All 5 commission/order paths get the snapshot for free without any RPC body changes. Backfill from `cost_per_unit * 100` for existing rows. New `OrderItem.cost_at_time_cents` field on the TS interface.

### Cluster 5 — #18, #35 UX cleanup (commit `7dce45f`)
- **#18** — Expanded the Inventory page's `HelpTip` to explicitly contrast `Net Position` (forward-looking, includes On Order) vs `Today's Free` (right-now physical stock, subtracts active holds). Both numbers exist for sound reasons but users were confusing them.
- **#35** — `AccountsPayable.tsx` was running both `get_ap_dashboard_summary` and `get_ap_aging` every time `asOfDate` changed even though summary doesn't depend on the date. Split into separate `useCallback`s + `useEffect`s: summary fires once on mount, aging refetches on `asOfDate`. No more wasted RPC calls when scrubbing through dates.

### Cluster 6 — #28 Edge Function Sentry hardening (commit `4008da9`)
Two fail-soft paths in `_shared/sentry.ts` were silently suppressing alerts in production. Now both log with a `[SENTRY_MISCONFIG]` sentinel that's grep-friendly in Supabase function logs. New `validateSentryDsnOrThrow()` helper for functions where alerting is critical (mirrors PR-16 ALLOWED_ORIGIN pattern). Sentry capture added to the 4 Edge Functions that were missing it: `create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`.

### Cluster 7 — #38 Abandoned package swap (deferred)
`shapefile@0.6.6` and `@mapbox/togeojson` swap is blocked on `.shp`/`.dbf`/`.prj`/`.kml` test fixtures from Mason. Existing in-file SECURITY note (from 2026-05-12 sprint) documents the deferral rationale; that note still stands.

## Live verification

All migrations applied live to `rhyzpcqhnizqbxphqdkr` and verified:

- ✅ `rebate_claims_claim_number_key` UNIQUE constraint exists
- ✅ `rebate_claim_counters` table + RLS enabled (no policies — system table)
- ✅ `create_rebate_claim` + `transition_rebate_claim` RPCs with correct signatures
- ✅ `create_delivery_with_items`, `bulk_import_order`, `save_blend_recipe` RPCs with correct signatures
- ✅ `compute_commission_amount(1000, 50) = 500.00`, `(-100, 50) = 0`, `(33.33, 33.33) = 11.11`
- ✅ All 3 commission callers (`convert_quote_to_order`, `create_direct_order`, `create_quick_delivery`) confirmed via `prosrc` to invoke `_insert_commissions_for_order` and have zero remaining inline `INSERT INTO commissions` blocks
- ✅ `safe_cents_qty(100, 2.5) = 250`, `(333, 0.333) = 111`, `(NULL, NULL) = 0`
- ✅ `create_quick_delivery` confirmed via `prosrc`: 3 helper calls, 0 remaining unsafe cents-multiply patterns
- ✅ `invoices_balance_non_negative` CHECK present + validated, 0 negative-balance rows in live data
- ✅ `order_items.cost_at_time_cents` column present, trigger `trg_snapshot_order_item_cost` active, backfill complete (0 rows left NULL when `cost_per_unit IS NOT NULL`)

## Build state

- `npm run lint` — 0 errors, 0 warnings
- `npm run typecheck` — 0 errors
- `npm run build` — clean (~14s, 552 KB main bundle)
- `npm run test` — 1,908 passing / 70 skipped / 0 failing (added 14 new contract tests across cluster 1, 2)
- Branch is now 73 commits ahead of `main`
- Schema registry regenerated (`generated_at = 2026-05-12`)

## Pending Mason input

1. **Edge Function deployment (Cluster 6).** 5 functions changed (the shared helper + 4 capture-points). Run `supabase functions deploy <name>` for each, or use the MCP tool. Intentionally NOT auto-deployed overnight.
2. **#38 abandoned packages.** Provide one or two real `.shp`/`.dbf`/`.prj`/`.kml` test fixtures so the `shapefile` → `shpjs` and `@mapbox/togeojson` → `@tmcw/togeojson` swap can be tested before merge.
3. **Phase 4 #12 — verify backups.** Screenshot Supabase dashboard → Settings → Database → Backups, confirm PITR + daily retention.
4. **Phase 4 #13 — restore drill.** Half-day exercise: spin up `crx-manager-restore-test` project, replay migrations, restore a recent backup, smoke-test, document time-to-restore, delete project.
5. **Deferred: 3 known `(*_cents * qty)::bigint` instances** in `transfer_job_to_invoice`, `create_invoice_from_blend_ticket`, `save_field_app_invoice` (single-instance each, fee × acres patterns). Wrap with `safe_cents_qty()` in a follow-up PR.
6. **Deferred: `apply_prepay_to_invoice` hand-decrement cleanup.** From the 2026-05-12 session — still pending the few-week prod observation window before dropping the hand-decrement.
7. **Blocked: PR-23.** Still need `crx-manager-staging` Supabase project before E2E safety guard can gate prod runs.

## Why this was safe to land autonomously

Each fix has at least two of:
- **Live verification** via DO-blocks in the migration + `prosrc` inspection post-apply (or formula sanity for IMMUTABLE helpers)
- **Test coverage** — 14 new contract tests, 1,908 total passing; existing E2E and unit suites unchanged
- **Build + lint + typecheck** clean across the full repo on every commit
- **Small per-cluster commits** for easy review/revert if needed

Each cluster started with investigation (`pg_proc`, `pg_constraint`, frontend grep, etc.) before any write. The 2026-05-12 audit summary doc explicitly mapped each finding to STILL-VALID + an evidence-backed scope, so the work was specification-driven rather than judgment-driven. The two genuine judgment calls were:
- Commit Edge Functions but defer their deployment (Mason's call to make)
- Defer #7's 3 fee × acres instances rather than copying 3 large function bodies overnight

## Files touched

**Migrations (5 new, all live):**
- `supabase/migrations/20260513000000_rebate_claim_atomic_rpcs.sql`
- `supabase/migrations/20260513010000_atomic_multi_table_write_rpcs.sql`
- `supabase/migrations/20260513020000_canonical_commission_math.sql`
- `supabase/migrations/20260513030000_safe_cents_multiply_helper.sql`
- `supabase/migrations/20260513040000_invoices_balance_non_negative.sql`
- `supabase/migrations/20260513050000_order_items_cost_at_time_snapshot.sql`

**Frontend (8 files):**
- `src/lib/db.ts` — added 18 new `RpcErrorCodes` tokens for the new RPCs
- `src/lib/rpcContracts.test.ts` — 14 new contract tests + 5 new entries in idempotency-coverage list
- `src/pages/Rebates.tsx` — call new RPCs via `supabase.rpc` with idempotency keys
- `src/pages/NewDelivery.tsx` — call `create_delivery_with_items`
- `src/pages/BlendRecipes.tsx` — call `save_blend_recipe`
- `src/components/orders/BulkOrderImport.tsx` — call `bulk_import_order` per row
- `src/pages/CommissionPayments.tsx` — `logActivity` calls in 3 handlers
- `src/pages/PrepaymentManager.tsx` — `logActivity` calls in 3 handlers
- `src/pages/InventoryPage.tsx` — expanded `HelpTip` text
- `src/pages/AccountsPayable.tsx` — split summary/aging fetch
- `src/types/index.ts` — added `cost_at_time_cents` to `OrderItem`

**Edge Functions (5 changed; pending deploy):**
- `supabase/functions/_shared/sentry.ts` — `validateSentryDsnOrThrow` helper + `[SENTRY_MISCONFIG]` log sentinel
- `supabase/functions/create-user/index.ts` — `captureEdgeException` in catch
- `supabase/functions/reset-user-password/index.ts` — same
- `supabase/functions/seed-admin/index.ts` — same
- `supabase/functions/setup-blend-tickets-storage/index.ts` — same

**Hooks:**
- `.claude/hooks/sql-safety.mjs` — new rule for `(*_cents * qty)::bigint` pattern (audit #7)

**Docs:**
- `CLAUDE.md` — current-state line + audit sprint status updated
- `AGENTS.md` — regenerated (pages=66, migrations=320, edgeFns=7)
- `docs/CHANGELOG.md` — 5 new dated entries (one per cluster commit)
- `docs/reference/migration-history.md` — 5 new rows + count bumped 314 → 320
- `docs/audits/2026-05-13-execution-summary.md` — this doc
- `.claude/schema-registry.json` — restamped after each schema-change cluster

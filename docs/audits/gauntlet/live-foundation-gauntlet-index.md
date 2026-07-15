# CRX Live Foundation Gauntlet Index

Read-only queue for the recurring CRX Live Foundation Gauntlet. Each run reviews one section against current repo code plus live Supabase database structure only, writes one dated report, updates this index, then stops.

Last updated: 2026-07-14

The July 14 full all-section run supersedes the older per-row queue notes below for current risk and remediation status. See [2026-07-14-full-gauntlet-codex-only-remediation.md](2026-07-14-full-gauntlet-codex-only-remediation.md). The table remains as section history until the fixes are deployed and production-verified.

## Current Queue

| # | Section | Status | Last reviewed | Latest report | Notes |
|---|---|---|---|---|---|
| 1 | Security, roles, route gating, RLS, SECURITY DEFINER RPC access | Refresh recorded in automation memory | 2026-06-21 | `2026-06-21-section-01-security-roles-rls-secdef-refresh.md` | Automation memory recorded 0 BLOCKER / 1 HIGH; report file is not present in this stale checkout. |
| 2 | Money, invoices, payments, AR aging, statements, credits, write-offs, finance charges | Refresh recorded in automation memory | 2026-06-24 | `2026-06-24-section-02-money-invoices-payments-ar-refresh.md` | Automation memory recorded 0 BLOCKER / 1 HIGH / 1 MED; report file is not present in this stale checkout. |
| 3 | Inventory, holds, prebooks, Net Free, quote draw-down, deliveries, receiving | Refresh recorded in automation memory | 2026-06-29 | `2026-06-29-section-03-inventory-holds-prebooks-deliveries-receiving-refresh.md` | Automation memory recorded 0 BLOCKER / 1 HIGH / 1 MED; report file is not present in this stale checkout. |
| 4 | Quote to order to delivery to invoice to payment lifecycle wiring | Refresh recorded in automation memory | 2026-07-01 | `2026-07-01-section-04-quote-order-delivery-invoice-payment-lifecycle-refresh.md` | Automation memory recorded 0 app findings; live function metadata follow-up was partially blocked by linked CLI auth. |
| 5 | Database drift: migrations on disk vs schema registry vs live database catalog, CHECK constraints, overloads, generated columns, search_path | Needs fix | 2026-07-05 | [2026-07-05-section-05-database-drift-refresh.md](2026-07-05-section-05-database-drift-refresh.md) | HIGH: this checkout is behind `origin/main` and live schema migrations; MED: schema registry trails disk migrations. |
| 6 | Idempotency and double-submit safety for mutating RPCs and frontend callers | Needs fix | 2026-07-08 | [2026-07-08-section-06-idempotency-double-submit-refresh.md](2026-07-08-section-06-idempotency-double-submit-refresh.md) | HIGH: `save_job_applied_record` can create duplicate applied-info records on retry/double-submit; MED: static idempotency coverage test missed the new mutating RPC. |
| 7 | Commissions, commission splits, entity recipients, payout batches, cancellations/voids | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found in consolidated run. |
| 8 | Returns and credit memos, including issue, unapply, reversal, statement impact | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found in consolidated run. |
| 9 | Purchase orders, receiving, vendor bills, vendor payments, AP safety | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found in consolidated run. |
| 10 | Blend tickets: OCR status, review status, payment status, order linking, Edge Function handoff contracts from repo code only | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Live link/unlink actor fix was present in consolidated run. |
| 11 | PDFs and compliance documents: invoices, WPS notices, reports, required fields | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Prior MED: WPS PDF generator needs dedicated output test. |
| 12 | Edge Functions and auth/email/document functions from repo code plus database contracts only | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Six live functions active with `verify_jwt=true` in consolidated run. |
| 13 | Frontend wiring: routes, nav, buttons, stale RPC calls, role mismatch, dead pages | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Workflow map found 0 auto-detected problems in consolidated run. |
| 14 | Testing and prevention gaps: missing smoke specs, invariant sweeps, hooks, ESLint rules for repeated Codex finding classes | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Prior MED: strict sweep/security advisor setup gap; LOW: frontend warning noise. |
| 15 | Documentation drift: CLAUDE.md, AGENTS.md, workflow map, schema docs, migration counts versus current repo/live catalog | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Local docs check passed in consolidated run; current branch staleness should be revisited in Section 15 refresh. |

## Existing Uncommitted Files At 2026-07-05 Run Start

- `.claude/schema-registry.json`

This file was present before the Section 5 run and was not modified by this automation.

## Next Section

All 15 sections completed. The next recurring run restarts at Section 1 after this remediation is live and production-verified.

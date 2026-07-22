# CRX Live Foundation Gauntlet Index

Read-only queue for the recurring CRX Live Foundation Gauntlet. Each run reviews one section against current repo code plus live Supabase database structure only, writes one dated report, updates this index, then stops.

Last updated: 2026-07-22

The July 14 full all-section run supersedes the older per-row queue notes below for current risk and remediation status. See [2026-07-14-full-gauntlet-codex-only-remediation.md](2026-07-14-full-gauntlet-codex-only-remediation.md). The table remains as section history until the fixes are deployed and production-verified.

2026-07-21 status notes:

- The 2026-07-14 remediation wave and the sections 2–6 closeout are live, and their guard artifacts are pinned by the permanent regression suite (`src/lib/bugClassRegressionGuards.test.ts`, `src/lib/gauntletRemediationGuards.test.ts`, `src/lib/gauntletSections26Remediation.test.ts`, PR #189).
- Section 5 drift items from the 2026-07-05 row: the pg_proc fixture snapshot and `src/types/supabase.ts` were fully regenerated 2026-07-21 after the 2026-07-20 live applies (per-line split billing, Supplier Pricing 1b + follow-ups).
- Section 6's HIGH (`save_job_applied_record` duplicates) was fixed 2026-07-10 (table-native idempotency key + partial unique index) and the RPC is tracked in `MUTATING_RPCS_WITH_IDEMPOTENCY`.
- Rows 1–4 reference report files recorded only in automation memory; those filenames are not in the repo. Treat the 2026-06-17 and 2026-07-14 committed reports as the durable history.
- Business-area review slices now exist: `node scripts/run-area.mjs --list` (vitest + smoke + invariant sweeps per area; see `scripts/test-areas.json`).

## Current Queue

| # | Section | Status | Last reviewed | Latest report | Notes |
|---|---|---|---|---|---|
| 1 | Security, roles, route gating, RLS, SECURITY DEFINER RPC access | Refresh complete | 2026-07-19 | [2026-07-19-section-01-security-roles-rls-secdef-refresh.md](2026-07-19-section-01-security-roles-rls-secdef-refresh.md) | 0 BLOCKER / 0 HIGH / 2 MED / 0 LOW. MED: anon-executable SECDEF number generators; `save_field` activity actor spoofing. |
| 2 | Money, invoices, payments, AR aging, statements, credits, write-offs, finance charges | Refresh complete | 2026-07-20 | [2026-07-20-section-02-money-invoices-payments-ar-refresh.md](2026-07-20-section-02-money-invoices-payments-ar-refresh.md) | 0 BLOCKER / 1 HIGH / 1 MED / 0 LOW. HIGH: period statements omit opening balance. MED: same-day running-balance order is nondeterministic. |
| 3 | Inventory, holds, prebooks, Net Free, quote draw-down, deliveries, receiving | Refresh complete | 2026-07-22 | [2026-07-22-section-03-inventory-holds-prebooks-deliveries-receiving-refresh.md](2026-07-22-section-03-inventory-holds-prebooks-deliveries-receiving-refresh.md) | 0 BLOCKER / 1 HIGH / 1 MED / 1 LOW. HIGH: inline inventory location edits bypass transfer ledger. MED: product pickers rebuild Net Position without the server over-receive clamp. LOW: `match_quick_receive_items` anon EXECUTE grant is unnecessary though self-gated. |
| 4 | Quote to order to delivery to invoice to payment lifecycle wiring | Refresh complete | 2026-07-22 | [2026-07-22-section-04-quote-order-delivery-invoice-payment-lifecycle-refresh.md](2026-07-22-section-04-quote-order-delivery-invoice-payment-lifecycle-refresh.md) | 0 BLOCKER / 1 HIGH fixed in branch / 0 MED / 0 LOW. HIGH: BulkQuoteImport bypassed `save_quote` with raw quote/section/item inserts and allowed accepted/terminal imported statuses; branch routes imports through `save_quote`, enforces draft-only creation, preserves dosage/price override payloads, rejects unknown-product partial imports, logs successful imports, and adds regression tests. |
| 5 | Database drift: migrations on disk vs schema registry vs live database catalog, CHECK constraints, overloads, generated columns, search_path | Refresh complete | 2026-07-22 | [2026-07-22-sections-05-08-t3-closeout-refresh.md](2026-07-22-sections-05-08-t3-closeout-refresh.md) | 0 BLOCKER / 0 HIGH / 0 MED / 1 LOW (registry stamp cosmetic). Five mutable-search_path functions FIXED LIVE (`20260722111620`); `profile_public_view` advisor ERROR assessed intentional-by-design; two live-only supplier-pricing applies recorded for that branch's landing. |
| 6 | Idempotency and double-submit safety for mutating RPCs and frontend callers | Refresh complete | 2026-07-22 | [2026-07-22-sections-05-08-t3-closeout-refresh.md](2026-07-22-sections-05-08-t3-closeout-refresh.md) | 07-08 HIGH (`save_job_applied_record`) and MED (stale coverage list) VERIFIED FIXED on live primary evidence + sol adversarial pass. LOW parked: 3 read-only RPCs with unused `p_idempotency_key`. |
| 7 | Commissions, commission splits, entity recipients, payout batches, cancellations/voids | Refresh complete | 2026-07-22 | [2026-07-22-sections-05-08-t3-closeout-refresh.md](2026-07-22-sections-05-08-t3-closeout-refresh.md) | 0 BLOCKER / 1 HIGH (PARKED, owner decision): custom "Other" split recipients write `recipient_user_id = NULL` and can never enter a payout batch; zero live rows affected. All live sweeps clean; void/cancel/posting guards hold with citations. |
| 8 | Returns and credit memos, including issue, unapply, reversal, statement impact | Refresh complete | 2026-07-22 | [2026-07-22-sections-05-08-t3-closeout-refresh.md](2026-07-22-sections-05-08-t3-closeout-refresh.md) | 0 BLOCKER / 0 HIGH / 1 MED FIXED LIVE (`unapply_credit_memo` idempotency replay now binds to the requested memo). Lever sign convention schema-enforced; statements opening-balance fix verified applied live. |
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

Section 9 is queued next: Purchase orders, receiving, vendor bills, vendor payments, AP safety.

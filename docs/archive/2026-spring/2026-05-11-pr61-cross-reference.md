# PR #61 Cross-Reference Against Audit Findings

**Date:** 2026-05-11
**Reviewer:** Claude (Opus 4.7, 1M context)
**PR:** #61 — `perf(advisors): close all 97 WARN-level performance findings`
**Branch:** `perf/advisor-sweep-2026-05-11`
**Author:** masonwells1
**State at review time:** OPEN, MERGEABLE, already applied live to production Supabase `rhyzpcqhnizqbxphqdkr`
**Files changed:** 9 files, 1,695 additions, 4 deletions

## What PR #61 actually does

Pure performance work — closes 97 Supabase advisor warnings, no business-logic changes:

1. **Migration `20260511050000_perf_auth_rls_initplan.sql` (826 lines)** — Wraps `auth.uid()` in `(SELECT auth.uid())` across 55 RLS policies on 35 tables. Postgres now caches the value once per query instead of re-evaluating per row. **Predicate, action, roles, and permissive flag are preserved verbatim.**
2. **Migration `20260511060000_perf_consolidate_permissive_policies.sql` (435 lines)** — Consolidates 23 overlap groups across 16 tables. Each group → one permissive policy whose predicate is the OR of the originals. **Same union of access, one evaluation per row.** Also wraps `auth.uid()` in these policies.
3. **Migration `20260511070000_perf_fk_indexes.sql` (94 lines)** — 72 `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for unindexed FK columns.
4. **Migration `20260511080000_perf_drop_duplicate_index.sql` (24 lines)** — Drops `idx_payments_order`, keeps `idx_payments_order_id`.

Plus doc updates: `CLAUDE.md`, `migration-history.md`, `CHANGELOG.md`, plus a `2026-05-11-unused-index-report.txt`.

**Bonus:** `rate_limit_log` gets a `RESTRICTIVE FOR ALL admin` policy as defense-in-depth (replaces a no-op deny-all permissive). Positive change unrelated to any audit finding.

## Tables touched by PR #61

**Migration 1 (`auth_rls_initplan`)** — 35 tables:
accounting_periods, application_record_fields, ar_reminder_tracking, blend_ticket_images, blend_ticket_products, blend_tickets, commission_payment_items, commission_payments, email_log, **field_app_location_shares**, **field_app_locations**, finance_charges, financial_audit_log, inventory_holds, invoice_shares, note_activity_log, note_tags, notifications, order_shares, rate_limits, rup_sales_records, team_note_attachments, team_note_comments, team_note_tags, vendor_bills, vendor_payments, vendors, write_offs.

**Migration 2 (`consolidate`)** — 16 tables:
application_services, commissions, customer_application_rates, deliveries, delivery_items, delivery_photos, delivery_remainders, document_processing_log, failed_notifications, purchase_order_items, purchase_orders, quote_pdf_templates, quote_templates, rate_limit_log, receiving_photos, receiving_records.

**Tables NOT touched by PR #61:** `profiles`, `blend_ticket_fields`, `field_crop_history`.

## Cross-reference against audit findings

| Finding | PR touches it? | Effect | Plan change? |
|---|---|---|---|
| **#1** Hardcoded production password | ❌ No (test files) | Still valid | No |
| **#2** `handle_new_user` metadata role trust | ❌ No (trigger not touched) | Still valid (mitigated by Mason disabling signup) | No |
| **#3** `profiles_update` self-role-escalation | ❌ No (`profiles` not in either migration) | **STILL VALID** | No — Phase 1.4 unchanged |
| **#4** `apply_prepay_to_invoice` no idempotency | ❌ No | Still valid | No |
| **#5** `prepay_credits.balance_cents` not GENERATED | ❌ No | Still valid (per Codex correction: trigger-cache, not GENERATED) | No |
| **#6** Commission math drift | ❌ No | Still valid | No |
| **#7** `(cents × numeric_qty)::bigint` truncation | ❌ No | Still valid | No |
| **#8** `create_quick_delivery` price trust | ❌ No | Still valid | No |
| **#9 — `field_app_locations`** | ⚠️ SELECT policy rewritten | Slightly stricter (`USING ((SELECT auth.uid()) IS NOT NULL)` — auth required) but **still "any authenticated user can read"**. Codex was right that WRITE was tightened earlier by `20260430230000_field_app_workflow_phase11.sql`. | New decision needed (read by drivers/applicators OK?) |
| **#9 — `field_app_location_shares`** | ⚠️ Same as above | Same | Same |
| **#9 — `blend_ticket_fields`** | ❌ Not touched | **STILL `USING (true)` for all 4 ops** | Phase 3.1 still valid |
| **#9 — `field_crop_history`** | ❌ Not touched | **STILL `USING (true)` for SELECT/INSERT/UPDATE** | Phase 3.2 still valid |
| **#10** `NewDelivery.tsx` partial save | ❌ No (TS code) | Still valid | No |
| **#11** Commission payments no audit trail | ❌ No (downgraded by Codex anyway) | Still valid as downgraded | No |
| **#12** No automated backups | ❌ No | Still valid | No |
| **#13** No restore drill | ❌ No | Still valid | No |
| **#14** `checkMutationResult` bug | ❌ No | Still valid | No |
| **#15** `convert_quote_to_order`/`create_quick_delivery` no audit log | ❌ No | Still valid | No |
| **#16** `record_invoice_payment` (per Codex: was hardened) | ❌ No | Still as Codex framed | No |
| **#17** `post_invoice` idempotency | ❌ No | Still valid | No |
| **#18** Inventory net_position (per Codex: naming) | ❌ No | Still valid as Codex framed | No |
| **#19** Negative balance credit memos | ❌ No | Still valid | No |
| **#20** parseCents loose input | ❌ No | Still valid | No |
| **#21** `profiles_select` PII leak | ❌ No (`profiles` not touched) | **STILL VALID** | No — Phase 1.6 unchanged |
| **#22** Customer RLS upper-bound queued | ❌ No (different migration) | Still valid | No |
| **#23** `payments.order_id` ON DELETE CASCADE | ❌ No (FK constraint, not policy) | Still valid | No |
| **#24** `inventory_transactions` / `prepay_applications` immutability | ❌ No | Still valid | No |
| **#25** `useGuardrails` fail open | ❌ No | Still valid | No |
| **#26** Vendor bill audit trail | ❌ No | Still valid | No |
| **#27** Prepayment audit trail | ❌ No | Still valid | No |
| **#28** Edge functions Sentry | ❌ No | Still valid | No |
| **#29** offlineSync no Sentry | ❌ No | Still valid | No |
| **#30** `_is_admin_override` GUC bypass | ❌ No | Still valid | No |
| **#31** Bulk imports | ❌ No | Still valid | No |
| **#32** Product price + cost history | ❌ No | Still valid | No |
| **#33** Rebate claim race | ❌ No | Still valid | No |
| **#34** BlendRecipes destructive edit | ❌ No | Still valid | No |
| **#35** AP churn | ❌ No | Still valid | No |
| **#36** Source maps shipping | ❌ No (build config) | Closed by Mason verifying SENTRY_AUTH_TOKEN earlier today | N/A |
| **#37** jspdf/dompurify XSS | ❌ No | Still valid | No |
| **#38** Abandoned packages | ❌ No | Still valid | No |

## Verdict

**PR #61 does NOT materially change any audit finding.** Out of 38 sev-4-or-5 findings, 0 are closed by this PR; 2 (`field_app_locations`, `field_app_location_shares`) get a tiny SELECT-side improvement that doesn't fully close the original concern.

## New nuance worth flagging (NOT in original audit)

The PR's SELECT policy on `field_app_locations` and `field_app_location_shares` is now `USING ((SELECT auth.uid()) IS NOT NULL)` — meaning **drivers, applicators, and any authenticated user can still read every billing-split row in those tables**. The WRITE side was locked down earlier (per Codex: `20260430230000_field_app_workflow_phase11.sql`).

**Decision needed:** is read-by-any-authenticated acceptable for billing-split data?
- If yes → no further action
- If no → add a Phase 3 item to tighten SELECT to admin/sales_rep only (matching the WRITE side)

## Recommended action on PR #61

**MERGE.** Reasoning:
1. Already applied live → not merging means live DB ↔ git stay permanently out of sync
2. Pure performance + advisor cleanup, no business-logic changes
3. Build + tests + lint all pass per the PR description
4. Closes 97 advisor warnings → easier to spot real ones in the future
5. The `rate_limit_log` defense-in-depth is a small but real security improvement
6. Side benefit: doc updates (`CLAUDE.md`, `migration-history.md`, `CHANGELOG.md`) keep your reference docs current

Only outstanding item before merge: the unchecked PR checkbox "Spot-check critical paths in app: load `/orders`, `/invoices`, `/deliveries` and confirm rows render for admin and sales_rep." Should be ~5 min of clicking around in production.

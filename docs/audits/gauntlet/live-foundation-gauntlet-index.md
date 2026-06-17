# CRX Live Foundation Gauntlet Index

Read-only queue for the recurring CRX Live Foundation Gauntlet. Each run reviews one section against current repo code plus live Supabase database structure only, writes one dated report, updates this index, then stops.

Last updated: 2026-06-17 (Sections 2-15 consolidated gauntlet complete; Section 1 skipped by request)

## Current Queue

| # | Section | Status | Last reviewed | Latest report | Notes |
|---|---|---|---|---|---|
| 1 | Security, roles, route gating, RLS, SECURITY DEFINER RPC access | Complete | 2026-06-17 | [2026-06-17-section-01-security-roles-rls-secdef.md](2026-06-17-section-01-security-roles-rls-secdef.md) | 1 HIGH — **FIXED 2026-06-17** (migration `20260617171500`, applied live + smoke-proven): `link_blend_ticket_to_order` / `unlink_blend_ticket_from_order` now bind the actor to `auth.uid()` and reject a mismatched `p_performed_by` with `ACTOR_MISMATCH`. |
| 2 | Money, invoices, payments, AR aging, statements, credits, write-offs, finance charges | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found. |
| 3 | Inventory, holds, prebooks, Net Free, quote draw-down, deliveries, receiving | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | MED: 17 negative available-quantity rows need owner-approved cleanup. |
| 4 | Quote to order to delivery to invoice to payment lifecycle wiring | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found. |
| 5 | Database drift: migrations on disk vs schema registry vs live database catalog, CHECK constraints, overloads, generated columns, search_path | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | MED: schema registry high-water trails current live DB. |
| 6 | Idempotency and double-submit safety for mutating RPCs and frontend callers | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | MED: `create_invoice_from_delivery` declares but does not use the standard idempotency helper. |
| 7 | Commissions, commission splits, entity recipients, payout batches, cancellations/voids | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found. |
| 8 | Returns and credit memos, including issue, unapply, reversal, statement impact | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found. |
| 9 | Purchase orders, receiving, vendor bills, vendor payments, AP safety | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | No blocker or high found. |
| 10 | Blend tickets: OCR status, review status, payment status, order linking, Edge Function handoff contracts from repo code only | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Live link/unlink actor fix present; no current blend-ticket rows. |
| 11 | PDFs and compliance documents: invoices, WPS notices, reports, required fields | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | MED: WPS PDF generator needs dedicated output test. |
| 12 | Edge Functions and auth/email/document functions from repo code plus database contracts only | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Six live functions active with `verify_jwt=true`; `seed-admin` absent live. |
| 13 | Frontend wiring: routes, nav, buttons, stale RPC calls, role mismatch, dead pages | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Workflow map found 0 auto-detected problems. |
| 14 | Testing and prevention gaps: missing smoke specs, invariant sweeps, hooks, ESLint rules for repeated Codex finding classes | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | MED: strict sweep/security advisor setup gap; LOW: frontend warning noise. |
| 15 | Documentation drift: CLAUDE.md, AGENTS.md, workflow map, schema docs, migration counts versus current repo/live catalog | Complete (consolidated) | 2026-06-17 | [2026-06-17-sections-02-15-full-gauntlet.md](2026-06-17-sections-02-15-full-gauntlet.md) | Local docs check passed; live baseline/schema docs need refresh. |

## Existing Uncommitted Files At First Run

- `docs/audits/2026-06-15-codex-to-claude-full-gauntlet-handoff.md`
- `docs/audits/2026-06-16-codex-to-claude-targeted-gauntlet-handoff.md`

These were present before the first gauntlet run and were not modified by this automation.

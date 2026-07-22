# 2026-07-22 Section 04 Refresh - Quote to Order to Delivery to Invoice to Payment Lifecycle

Read-only audit start, then targeted remediation after the finding was proven. Repo worktree: `C:\Users\mason\.codex\worktrees\section4-lifecycle-audit\CRX_Manager` at `85392e02`. Original `C:\CRX_Manager` had pre-existing modified gauntlet index/summary files; they were not used as source evidence or reverted.

## Scope And Evidence

- Required docs read: `CLAUDE.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/reference/gotchas.md`, `docs/workflows/CODEX_REVIEW_GAUNTLET.md`, `docs/workflows/QUOTE_TO_DELIVERY.md`, `docs/workflows/INVENTORY_RULES.md`.
- Graphify refreshed locally: `graphify-out/GRAPH_REPORT.md` built from commit `85392e02`; relevant lifecycle communities connected `convert_quote_to_order`, `complete_delivery`, `confirm_delivery`, `post_invoice`, invoices/orders/deliveries, and `allocate_payment`.
- Live Supabase catalog checked read-only for lifecycle RPC grants and metadata. The core mutating RPCs (`save_quote`, `convert_quote_to_order`, `create_direct_order`, `create_delivery_with_items`, `confirm_delivery`, `complete_delivery`, `create_quick_delivery`, `post_invoice`, `post_invoice_group`, `allocate_payment`, cancel/void variants, job/blend invoice transfer) are `SECURITY DEFINER`, have `search_path=public, pg_temp`, deny `anon` EXECUTE, and allow authenticated/service-role EXECUTE.
- Live status CHECK constraints checked read-only: quotes allow `draft/sent/revised/accepted/declined/expired/cancelled/closed_by_application/closed_short`; orders allow `confirmed/partially_fulfilled/fulfilled/cancelled/voided`; deliveries allow `scheduled/in_progress/completed/cancelled/voided`; invoices allow `draft/unposted/posted/paid/overdue/voided/cancelled`; payments enforce positive amount and current payment method set.
- Live lifecycle triggers checked read-only: quote/order/delivery/invoice status transition triggers exist; order terminal/delete guards exist; invoice/order lineage guards exist; delivery accounting-period and completed-signature guards exist; payments are PostgREST read-only and entered through `allocate_payment`.

## Findings

### HIGH - Bulk quote import bypassed the quote lifecycle save RPC

Evidence:

- At audit-start commit `85392e02`, `src/components/quotes/BulkQuoteImport.tsx:334` inserted directly into `quotes`; `src/components/quotes/BulkQuoteImport.tsx:370` inserted directly into `quote_sections`; `src/components/quotes/BulkQuoteImport.tsx:420` inserted directly into `quote_items`.
- The same pre-fix block allowed imported status values `accepted`, `declined`, and `expired` at `src/components/quotes/BulkQuoteImport.tsx:341-344`, even though the normal quote lifecycle should advance those states through guarded workflow actions.
- Current server contract evidence: `save_quote(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text)` is live, `SECURITY DEFINER`, `search_path=public, pg_temp`, authenticated-only, and already recalculates quote/item totals server-side.

Business risk:

Bulk quote upload could create quote rows outside the same server-side save contract used by Quote Builder. That risks stale totals, inconsistent item math, terminal/accepted quotes created from a spreadsheet, and downstream order conversion/commission math starting from a quote the server did not normalize.

Suggested fix:

Route bulk quote import through `save_quote`, build the same quote/section/item JSON shape as Quote Builder, keep one retry-safe idempotency key per imported quote number until successful acknowledgement, and restrict import-created statuses to `draft` because the RPC rejects non-draft new quotes.

Prevention:

Add a regression test proving bulk import calls `save_quote` and never direct-inserts `quotes`, `quote_sections`, or `quote_items`; add a parse test rejecting non-draft statuses and payload assertions for server-authoritative dosage and price override fields.

Remediation in this branch:

- `src/components/quotes/BulkQuoteImport.tsx` restricts importable statuses to `draft` and sends all new quote payloads to `save_quote` as `draft`.
- `src/components/quotes/BulkQuoteImport.tsx` keeps per-quote idempotency keys across file reselection/retry and clears them only after `save_quote` succeeds.
- `src/components/quotes/BulkQuoteImport.tsx` translates CSV `oz_per_acre` into `actual_rate: <value>, rate_unit: 'oz'`, preserves explicit CSV prices as `price_override`, rejects the whole quote when any grouped product is unknown, restores Sentry reporting for unexpected parse/import failures, and logs successful imports to `activity_feed`.
- `src/components/quotes/BulkQuoteImport.test.tsx` proves the RPC-only path, direct-insert absence, draft-only status, dosage translation, price override payload, activity logging, and whole-quote rejection for unknown products.
- `src/components/quotes/BulkQuoteImport.test.tsx` proves non-draft import status is rejected.

Status: fixed in branch; no live database mutation required.

## Non-Findings

- Core lifecycle RPC grants/search_path are currently correct in the live catalog.
- Frontend order creation, quote conversion, delivery creation/completion, invoice posting, and payment allocation call the expected RPCs.
- Direct adjunct writes found during source search are trigger/RLS bounded: delivery signature path update follows `complete_delivery`; order soft-delete is terminal-guarded; quote rollback after failed conversion remains within quote status triggers.

## Verification

- `npm run test -- --run src/components/quotes/BulkQuoteImport.test.tsx` - PASS, 5 tests.
- `npm run typecheck` - PASS.
- `npm run lint` - PASS with 3 pre-existing warnings outside this change (`CustomerContacts.tsx` hook deps, `supabase/functions/send-email/index.ts` console warn policy).
- `npm run build` - PASS.

## Counts

- BLOCKER: 0
- HIGH: 1 fixed in branch
- MED: 0
- LOW: 0

## Next Section Queued

Section 9: Purchase orders, receiving, vendor bills, vendor payments, AP safety.

# Codex-Driven Bug Hunt — Phase Plan (subsystem queue)

Branch: `claude/main-debug-hunt` (worktree `C:\CRX_MainDebug`, forked off live `main`).
Scope order: **money/billing engine first**, then a broad whole-app sweep.
1–3 keys per cycle. Mark `[DRAINED]` once a slice yields no new confirmed findings.

## Phase 1 — Money / billing engine (priority)

- [x] **invoices-core** [DRAINED c1] — `src/pages/InvoiceDetail.tsx`, `Invoices.tsx`, `src/lib/invoicePdf.ts`; RPCs `post_invoice` / `void_invoice` / `cancel_invoice` / `update_invoice`; tables `invoices` (balance_cents GENERATED), `invoice_items` (extended_cents), `financial_audit_log` (append-only). _c1: 1 candidate (credit-memo forge) refuted — already fixed live by PARKED-002._
- [x] **payments-allocation** [DRAINED c1] — `src/pages/PaymentAllocation.tsx`, `PaymentHistory.tsx`, `src/lib/paymentAllocation.ts`; RPCs `record_payment` / `allocate_payment`; tables `payments` (NO updated_at), `prepay_applications`. _c1: CLEAN._
- [x] **money-primitives** [DRAINED c2] — `src/lib/money.ts`, `parseCents.ts`, fmt layer. _c2: parseCents mid-dash negative → GREEN fixed (5938937d)._
- [x] **commissions** [DRAINED c2+c3] — `src/pages/CommissionPayments.tsx`, `src/lib/commissionSplit.ts`; RPCs `save_customer` (split=100%), `void_commission_payment`. _c2: void-UI dead-order count → GREEN (5938937d). c3: commission-split (save_customer + per-order creation) CLEAN._
- [x] **credit-returns** [DRAINED c2] — `src/pages/Returns.tsx`; RPC `issue_return_credit` (credit_memo, order_id may be NULL); `returns.requested_by`, `return_items.order_item_id`. _c2: non-atomic create + reject/status-bypass → PARKED-004 (migration)._
- [x] **blend-ticket-billing** [DRAINED c4] — `src/pages/BlendTickets.tsx`, `BlendTicketDetail.tsx`; RPCs `create_invoice_from_blend_ticket`, `sync_blend_ticket_payment_status`; 4 orthogonal status axes. _c4: Create-Invoice card payment_status gate → GREEN (2d274161); inline idempotency save → PARKED-006 (LOW)._
- [x] **orders-AR** [DRAINED c3] — `src/pages/ARaging.tsx`, `CustomerInvoiceSummary.tsx`, `src/lib/customerInvoiceSummary.ts`; RPCs `get_ar_aging`, `get_ar_reminder_candidates`. _c3: AR-reminder $NaN total → GREEN (832f6c8a); reminder excludes overdue → PARKED-005._
- [x] **field-acre-billing** [DRAINED c4 CLEAN] — `src/pages/FieldApplicationInvoice.tsx`, `FieldInvoices*.tsx`, `src/lib/fieldInvoiceList.ts`; per-acre split, as-applied reconcile. _c4: CLEAN._
- [x] **prepay-finance** [DRAINED c3+c5] — `src/pages/PrepaymentManager.tsx`, `src/lib/financeChargeCalc.ts`, `fuelSurcharge.ts`; finance charges, `check_period_open()`. _c5: dead Apply buttons → GREEN (36b9bec5); apply_prepay CURRENT_DATE guard REFUTED (correct)._

## Phase 2 — Whole-app sweep

- [x] **quotes-holds** [DRAINED c5] — quote lifecycle, `draw_down_quote`, `convert_quote_to_order`, holds/prebooked. _c5: convert pre-save-accepted REFUTED (guarded by design) + LOW residual note._
- [x] **inventory-engine** [DRAINED c5] — Net Free, 12 transaction types, prebook reconciliation. _c5: planned-demand double-count → PARKED-007._
- [x] **deliveries** [DRAINED c6] — `confirm_delivery` / `complete_delivery`, quick delivery, item-edit lock. _c6: complete_delivery idempotency-unused REFUTED (already fixed live)._
- [x] **jobs** [DRAINED c6] — job lifecycle → invoiced. _c6: transfer_job_to_invoice + start/complete_job findings REFUTED (append-only trap; live already hardened)._
- [x] **purchase-orders-receiving** [DRAINED c6] — PO lifecycle, receiving_records (NO updated_at). _c6: receive_po_items missing FOR UPDATE → PARKED-009; PO submit direct-update REFUTED (RLS+triggers)._
- [x] **rls-security-definer** [DRAINED c7 CLEAN] — _c7: full live security-advisor report clean (no RLS-off tables, no new SECDEF view, only known-accepted ERROR profile_public_view). Doc drift: 59 vs ~55 anon-SECDEF._
- [x] **edge-functions** [DRAINED c7] — send-email, process-blend-ticket, create-user, etc. _c7: JobDetail not-fail-closed → GREEN (4c20fb8d); send-email optional-idempotency REFUTED (by design)._
- [x] **idempotency-infra** [DRAINED c7] — idempotency_keys columns/operation-scope, `useIdempotencyKey`. _c7: dismiss_watchdog_flag inline save → PARKED-006 (systemic)._
- [x] **misc-pages** [DRAINED c8a+c8b] — beyond-parity + admin/period. _c8a: field-app chemical entry — NaN-guard GREEN (1cd3c873), unit-mismatch → PARKED-010 (HIGH). c8b: month-end/settings/watchdog/office-cockpit CLEAN._

## ✅ SWEEP COMPLETE
All Phase 1 (money/billing) + Phase 2 (whole-app) subsystems drained across cycles 1–8.
Loop stopped: swept everything + diminishing signal (cycle 8b clean; cycles 6–8 mostly
already-fixed re-finds). 7 green fixes committed, 6 parked for Mason, 1 LOW note.

## Cycle log (key → cycle#)
- c1 invoices-core, payments-allocation
- c2 money-primitives, commissions(void), credit-returns
- c3 orders-AR, prepay-finance, commission-split
- c4 blend-ticket-billing, field-acre-billing
- c5 prepay-finance(re), quotes-holds, inventory-engine
- c6 deliveries, jobs, purchase-orders-receiving
- c7 rls-security-definer, edge-functions, idempotency-infra
- c8a misc: label-guardrails + field-app charges · c8b misc: month-end/admin/cockpit

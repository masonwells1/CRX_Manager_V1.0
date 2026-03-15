# Phase 6 — Architecture Responsibility Audit (What Must Move)

## Plain-English summary (for Mason)

I continued directly to the next step.

### Business translation
If critical business rules live in browser code, it’s like letting every truck driver keep their own private scale and invoice calculator.

For a $20M operation with regulated products, the final authority must be server-side (Supabase DB/RPC), not client-side React state.

This phase maps exactly what logic is in the wrong place today and what to move.

---

## RESPONSIBILITY AUDIT TABLE

| Business Logic | Currently In | Should Be In | Risk Level | Effort |
|---|---|---|---|---|
| Quote line math (unit conversion, line totals, margin) | React `QuoteBuilder` | Supabase RPC (`calculate_quote_totals`) | **CRITICAL** | Medium |
| Quote header totals (price/cost/profit/margin) | React `QuoteBuilder` | Supabase RPC + persisted server result | **CRITICAL** | Medium |
| Tier pricing policy enforcement during quoteing | React tier selection flow | DB pricing policy tables + RPC resolution | **CRITICAL** | Medium |
| Discount/tax/fee order-of-operations | Largely absent from canonical quote engine | Explicit schema + server pricing engine | **CRITICAL** | Large |
| Commission amount calculation basis | During order conversion from quote snapshots | Server recalculation from authoritative order economics | High | Medium |
| Inventory mutation (receiving, delivery, adjustments) | Mixed: mostly RPC, but still some page-level direct writes | RPC-only mutation boundary | **CRITICAL** | Medium |
| Inventory transaction log creation | RPC + some direct page inserts | Server-side append-only via RPC/triggers | High | Medium |
| Role authorization for privileged operations | Mixed policy + function param checks | `auth.uid()` bound checks inside every privileged RPC | **CRITICAL** | Small/Medium |
| Notification integrity (who can create cross-user notifications) | Broad insert policy currently possible | Strict role-scoped policy + server-issued notifications | Major | Small |
| Offline replay operation safety | Client queue -> RPC with idempotency keys | Keep RPC path, tighten auth invariants and replay contracts | Major | Small |

---

## Evidence basis for “currently in” decisions

- Quote math functions and totals are in `src/pages/QuoteBuilder.tsx` (`recalcItem`, `totals` memo).
- Order conversion and inventory prebooking logic are in `convert_quote_to_order` RPC migration.
- Direct inventory writes still exist in `src/pages/InventoryPage.tsx` (direct `.from('inventory').insert` and `.from('inventory_transactions').insert` paths).
- Critical flows use RPCs (`record_payment`, `receive_po_items`, `complete_delivery`, `update_order_items`, `create_direct_order`) with idempotency integration.

---

## Recommended migration plan (phased)

### Phase A — Lock critical trust boundaries (first)
1. Add `auth.uid()` enforcement in every privileged RPC (remove trust in caller-supplied actor ids).
2. Close broad RLS policy holes affecting inventory/financial pathways.
3. Block residual direct inventory mutations from page code.

### Phase B — Centralize financial math
1. Introduce `calculate_quote_totals` RPC:
   - inputs: quote lines + pricing context,
   - outputs: normalized line totals + header totals + commission base fields.
2. Update `QuoteBuilder` to call RPC and display returned numbers only.
3. Require `convert_quote_to_order` to recompute/validate before final insert.

### Phase C — Formalize missing commercial dimensions
1. Add schema for discount, tax, and fee components.
2. Codify deterministic operation order in server RPC.
3. Add rounding policy tests at DB level.

### Phase D — Harden inventory integrity model
1. Add non-negative CHECK constraints on stock buckets.
2. Add over-commit guards at reservation operations.
3. Make inventory transaction logs append-only via trusted server routes.

### Phase E — Verification and guardrails
1. Add DB-level test scripts for quote math and inventory transitions.
2. Add concurrency test harness for reservation/receiving/delivery overlap.
3. Add reconciliation report: inventory buckets vs movement ledger vs open commitments.

---

## “Move first” priority list

1. **RPC auth identity enforcement** (highest risk reduction, low/medium effort)
2. **Quote totals server-side authority**
3. **Eliminate page-level inventory mutations**
4. **Tax/discount/fee canonical model**
5. **Inventory invariants and reconciliation automation**

---

## Phase progression

Proceeding to **Phase 7 — Complete Defect Backlog** next.

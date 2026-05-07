# Phase 5 — Inventory Integrity Forensics

## Plain-English summary (for Mason)

I continued to the next phase immediately.

### Business translation
Inventory integrity is the difference between:
- confidently promising product to growers, and
- accidentally selling the same gallons twice.

Your system has a solid backbone (atomic RPCs + audit transaction table), but there are still high-risk cracks:
1. a few inventory-changing actions still happen from page code paths,
2. caller identity checks in RPCs can be spoofed in some functions,
3. database-level “never go below zero” constraints are not fully enforced.

---

## INVENTORY INTEGRITY AUDIT

### 1) Data model: how inventory is tracked

Core stock buckets (table `inventory`):
- `quantity_available` (on hand)
- `quantity_prebooked` (committed/reserved)
- `quantity_on_order` (incoming from supplier)

Auxiliary inventory control/audit tables:
- `inventory_transactions` (movement log)
- `inventory_holds` (planning/holds layer)

Transaction-type vocabulary includes:
- `received`, `booked`, `delivered`, `returned`, `adjusted`, `transferred`

---

### 2) All paths that modify inventory (forensic list)

## Server-side RPC paths (good direction)
1. `convert_quote_to_order` -> increments `quantity_prebooked` and writes `inventory_transactions` (`booked`).
2. `create_direct_order` -> increments `quantity_prebooked` and writes transactions.
3. `receive_po_items` -> increments `quantity_available`, decrements `quantity_on_order`, writes transactions.
4. `complete_delivery` -> decrements `quantity_available` and `quantity_prebooked`, writes `delivered` transaction.
5. `cancel_order` -> releases prebooked quantity and writes release/adjustment log.
6. `update_order_items` -> adjusts prebooked quantity deltas and logs adjustments.
7. `adjust_inventory` -> manual admin adjustment + audit insert.

## Direct table mutation paths still present (risk)
8. `InventoryPage` directly inserts/deletes some inventory/transaction rows in specific flows (e.g., delete record audit insertion then delete).
9. Holds (`inventory_holds`) are written directly from page-level code.

---

### 3) Race condition risks (specific scenarios)

1. **Concurrent quote/order reservations on same product**
   - RPCs use atomic updates, which helps.
   - But without a strict “available must remain >= 0” invariant enforced server-side at reservation boundaries, over-commit risk remains under concurrency bursts.

2. **Manual adjustment while fulfillment events run**
   - `adjust_inventory` is atomic and row-locking aware.
   - Still vulnerable to business-rule conflicts if parallel workflows are allowed without stronger invariant checks.

3. **Client-side direct mutation pathways**
   - Remaining direct writes in `InventoryPage` can bypass central transactional guardrails.

4. **Caller spoof risk in security-definer functions using `p_performed_by`**
   - If caller identity is not tied to `auth.uid()`, malicious callers could attempt privileged operations by passing another UUID.

---

### 4) Audit trail immutability

**Immutable: NO (strictly speaking).**

Why:
- There is a dedicated `inventory_transactions` log and many flows write to it (good).
- But policy/grant patterns and direct insert possibilities for non-admin contexts reduce strict trust/immutability posture.
- No hard “append-only only via secured server pathways” guarantee is yet proven across all write paths.

---

### 5) Can inventory go negative?

**Potentially YES (critical risk).**

Why:
- Many functions use `GREATEST(..., 0)` on decrements, which avoids negative values in those specific updates.
- However, schema-level CHECK constraints for non-negative inventory buckets are not the primary enforced control, and some paths update values without universal invariant checks across all operations.
- Under concurrent and mixed-path operations, true “never negative / never over-committed” guarantee is not yet mathematically sealed at DB constraint level.

---

### 6) Reservation -> commitment -> delivery flow works?

**YES, but with caveats (operationally partial).**

- Reservation/commitment is represented through prebooking transitions in order-creation/edit pathways.
- Delivery completion moves quantities and updates fulfillment state.
- Caveat: consistency depends on strict usage of RPC pathways and robust policy hardening.

---

### 7) PO receiving -> inventory increase works?

**YES (for primary RPC path).**

- `receive_po_items` updates PO item receipt counts, stock buckets, and writes audit transactions.
- Includes partial/full receiving status transitions.

---

### 8) Recommended fixes (specific implementation guidance)

1. **Enforce caller identity in all privileged RPCs**
   - In each inventory/money-impact RPC, derive actor from `auth.uid()` internally (or assert passed id equals `auth.uid()`).
2. **Eliminate residual direct inventory mutations in page code**
   - Route all inventory-changing operations through vetted RPCs.
3. **Add hard DB CHECK constraints for inventory buckets**
   - `quantity_available >= 0`, `quantity_prebooked >= 0`, `quantity_on_order >= 0`.
4. **Add invariant RPC checks for over-commit prevention**
   - Validate reservation does not exceed permitted available net stock before incrementing prebooked.
5. **Tighten RLS/policies for `inventory_transactions`**
   - Prefer append-only through trusted RPC contexts; block broad direct inserts.
6. **Add reconciliation job/report**
   - Periodically verify `inventory` net state equals sum of expected movements and open commitments.

---

## Inventory integrity verdict (phase checkpoint)

- **Data model adequacy:** Caution
- **Transactional integrity:** Caution (good progress, not airtight)
- **Concurrency safety:** Caution/Unsafe in peak contention scenarios
- **Audit trustworthiness:** Caution
- **Production readiness for high-liability operations:** **Not yet safe without hardening**

---

## Phase progression

Proceeding next to **Phase 6 — Responsibility Audit (what logic must move to Supabase)**.

# Bug Fix Plan — 2026-03-12

## Overview
6 bugs reported during user acceptance testing. Full audit completed via parallel agent swarm.
**Rule: NO code changes until user approves this plan.**

---

## Bug #1 — CRITICAL: Inventory "Total On Floor" Inflated
**Severity:** 🔴 Critical — financial/operational data is WRONG
**Root Cause:** `InventoryPage.tsx:233` calculates:
```ts
const totalOnFloor = item.quantity_available + item.quantity_prebooked;
```
`quantity_prebooked` is a **sub-count WITHIN** `quantity_available`, not separate. Adding them double-counts. This exactly explains: 227.5g received + 54.5g prebooked = 282g displayed.

**Fix (1 line):**
```ts
// InventoryPage.tsx:233
const totalOnFloor = item.quantity_available;
```

**Verification:** The `complete_delivery` RPC already treats prebooked as a subset (deducts from prebooked first, then remainder from available). `NewOrder.tsx:560` also correctly uses just `quantity_available`. The formula in `INVENTORY_RULES.md` already documents this correctly. Only the InventoryPage display is wrong.

**Scope:** 1 file, 1 line change
**Risk:** Low — display-only fix, no DB changes

---

## Bug #1b — CRITICAL: Receiving Deletion Doesn't Remove Inventory
**Severity:** 🔴 Critical — inventory inflated permanently after deleting duplicate receivings
**Root Cause:** The `reverse_receiving_record()` RPC exists in local migration `20260327100000_wave4_bug_fixes.sql` but has **never been deployed to production**. The Receiving Log delete button calls this RPC, gets an error, and silently fails. The receiving record stays and inventory stays inflated.

**Fix:**
1. Deploy `reverse_receiving_record()` RPC to production (already written and correct)
2. Fix column name mismatch: `purchase_order_item_id` → `po_item_id` in wave4_remaining_fixes.sql line 575
3. Add a `BEFORE DELETE` safety trigger on `receiving_records` as defense-in-depth (prevents raw SQL deletes from orphaning inventory)
4. Verify the Receiving Log bulk delete UI properly shows success/failure toasts

**Scope:** 1 new migration (deploy existing RPC + add safety trigger), 1 column name fix
**Risk:** Medium — touches inventory, but the RPC logic is already written and audited

---

## Bug #2 — Order Name Disappears After Submission
**Severity:** 🟡 Medium — data saved correctly, just never displayed
**Root Cause:** Pure UI display bug. `order_name` is:
- ✅ In the database (`orders.order_name` column)
- ✅ Sent by NewOrder.tsx (`p_order_name: orderName`)
- ✅ Stored by `create_direct_order` RPC
- ❌ Never displayed in `OrderDetail.tsx` (header shows only `order_number`)
- ❌ Never shown in `Orders.tsx` list table columns

**Fix:**
1. `OrderDetail.tsx` (~line 489): Show `order_name` below the order number in the page header
2. `Orders.tsx` (~line 215): Add `order_name` column to the DataTable (after Order # column)

**Scope:** 2 files, ~10 lines each
**Risk:** Very low — display only

---

## Bug #3 — Order Notes Disappear After Submission
**Severity:** 🟡 Medium — data saved correctly, just never displayed
**Root Cause:** Identical pattern to Bug #2. `notes` is:
- ✅ In the database (`orders.notes` column, original schema)
- ✅ Sent by NewOrder.tsx (`p_notes: notes`)
- ✅ Stored by `create_direct_order` RPC
- ❌ Never displayed in `OrderDetail.tsx`

**Fix:**
1. `OrderDetail.tsx` (~line 539): Add a "Notes" section below the order info grid
   - Only show when `order.notes` is not null/empty
   - Use a card/panel with a FileText icon, matching existing UI patterns
2. `Orders.tsx`: Optionally add a notes icon indicator in the list (tooltip on hover) — keeps the table clean

**Scope:** 1-2 files, ~15 lines
**Risk:** Very low — display only

---

## Bug #4 — Can't Cancel/Undo Fulfilled Orders
**Severity:** 🟠 High — operational blocker when errors happen
**Root Cause:** Triple-locked:
1. **RPC:** `cancel_order()` raises exception: `'Cannot cancel a fulfilled order'`
2. **State machine trigger:** `fulfilled` has zero allowed outbound transitions
3. **UI:** `OrderDetail.tsx` hides all action buttons for fulfilled orders

**Full dependency chain for reversal:**
| Component | What Needs Reversing |
|-----------|---------------------|
| Inventory | Restore `quantity_available` for all delivered items |
| Order items | Reverse `quantity_delivered` / `quantity_remaining` |
| Deliveries | Mark completed deliveries as `reversed` |
| Delivery state machine | Add `completed → reversed` transition |
| Inventory transactions | Insert reversal records (type `delivery_reversed`) |
| Draft invoices | Auto-cancel (existing pattern works) |
| Posted invoices | Notify admin for manual void (existing pattern) |
| Invoices with payments | Flag for admin — cannot auto-void |
| Commissions | Cancel pending, flag paid ones |
| Financial audit log | Append-only reversal entries (never modify) |

**Fix — New `reverse_fulfilled_order()` RPC (admin-only):**
1. New migration with `reverse_fulfilled_order(p_order_id, p_reason)` function
2. Add `fulfilled → cancelled` to order state machine (admin override only)
3. Add `completed → reversed` to delivery state machine
4. Restore inventory per delivered item (add back to `quantity_available`)
5. Reverse order_items quantities
6. Handle invoices: auto-cancel drafts, notify admin for posted
7. Cancel pending commissions, flag paid ones
8. Log everything to `financial_audit_log`
9. UI: Add "Reverse Fulfillment" button on OrderDetail for admin users on fulfilled orders
10. Confirmation modal with warning about implications

**Scope:** 1 large migration (~200 lines), 1 UI file (~30 lines)
**Risk:** High — most complex fix, touches inventory + financials. Needs thorough testing.

---

## Bug #5 — Mobile Data Loss on App Switch
**Severity:** 🟠 High — major UX pain point on mobile
**Root Cause:** PWA config in `vite.config.ts`:
```ts
registerType: 'autoUpdate',  // auto-checks for SW update on focus
skipWaiting: true,            // immediately activates new SW
clientsClaim: true,           // claims clients → triggers reload
```
When user backgrounds the app (switches to calculator), the service worker may detect an update on return and force a full page reload, destroying all React form state.

**Fix (two-pronged):**
1. **PWA config change** (`vite.config.ts`):
   - Change `registerType: 'autoUpdate'` → `registerType: 'prompt'`
   - Keep `skipWaiting` and `clientsClaim` but only activate on user consent
   - Show a "New version available — tap to update" toast instead of auto-reloading

2. **Form draft persistence** (new hook `src/hooks/useFormDraft.ts`):
   - Saves form state to `sessionStorage` on every change (debounced)
   - Restores on component mount if draft exists
   - Shows "Draft recovered" toast when restoring
   - Clears draft on successful submission
   - Apply to: `NewOrder.tsx`, `NewDelivery.tsx`, `QuoteBuilder.tsx`, and other form pages

**Scope:** 1 config file + 1 new hook + 3-5 form pages updated
**Risk:** Low-Medium — PWA change is straightforward; form draft needs testing per page

---

## Bug #6 — Quick Receiving Can't Override PO Quantity
**Severity:** 🟢 Low-Medium — workaround exists (edit PO first)
**Root Cause:** Infrastructure is 70% built:
- ✅ `receive_po_items` RPC accepts `p_allow_over_receive boolean`
- ✅ Quick Receive already passes `true` for this parameter
- ❌ PO Detail receiving form caps quantity at `ordered - received` (UI limit)
- ❌ No admin notification when over-receive happens
- ❌ No discrepancy flag/dashboard

**Fix:**
1. **Quick Receive UI:** Already works! Verify it actually allows over-receive (may need UI validation removal)
2. **PO Detail receiving form:** Remove or relax the max quantity cap, allow override with a warning
3. **Notification:** Add `notify_over_receive()` call in `receive_po_items` when received > ordered
4. **Flag:** Add `has_discrepancy` boolean to `receiving_records` or `purchase_order_items`
5. **Display:** Show discrepancy indicator on PO Detail and Receiving Log pages

**Scope:** 1 migration (notification + flag), 2-3 UI files
**Risk:** Low — additive feature, no existing logic changes

---

## Implementation Order (recommended)

| Priority | Bug | Effort | Why This Order |
|----------|-----|--------|----------------|
| 1st | #1 Inventory display | 5 min | 1-line fix, biggest user-facing data error |
| 2nd | #1b Receiving deletion | 30 min | Deploy existing RPC + safety trigger |
| 3rd | #2 + #3 Order name/notes | 30 min | Quick UI wins, high user frustration |
| 4th | #5 Mobile data loss | 1-2 hrs | PWA config + new hook |
| 5th | #6 Over-receive | 1 hr | Mostly additive, low risk |
| 6th | #4 Reverse fulfilled | 2-3 hrs | Most complex, needs careful testing |

**Total estimated effort: ~5-7 hours**

---

## Questions Resolved
- ✅ "Total On Floor" = physical stock only (`quantity_available`)
- ✅ Cancelling fulfilled order = inventory goes back on shelf
- ✅ Mobile issue = both iOS and Android
- ✅ Receiving delete = Receiving Log bulk delete (RPC not deployed)

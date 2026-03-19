# Comprehensive UI Workflow E2E Test Design

**Date:** 2026-03-18
**Status:** Approved
**Approach:** Pure UI with DB verification assertions

## Overview

Single serial Playwright mega-test (`comprehensive-ui-workflow.spec.ts`) covering the full business lifecycle through the UI. Every action is performed via clicks/forms. Inventory, financial, and commission state verified between each major step via UI reads + Supabase REST assertions.

## Test Data

- **Customer:** [E2E] Farm Alpha (Tier 1)
- **Products:** Herbicide Alpha (15 units), Adjuvant Beta (10→8 units), Fertilizer Gamma (12 units)
- **Prices:** Tier 1 pricing, Fertilizer Gamma gets price override $42→$38
- **Cleanup:** All created entities deleted on test completion via teardown

## 12-Act Structure

### ACT 1: Baseline Snapshot
Record starting inventory (all 3 products), customer AR balance, commission state, Team Board state.

### ACT 2: Create Quote via UI
New quote → Farm Alpha → 3 products → planned program → save draft → send → accept.
**Verify:** Inventory holds created (planned qty increased).

### ACT 3: Convert Quote to Order
Click "Convert to Order" → verify order items/status.
**Verify:** Prebooked increased, holds released, commissions created with correct amounts.

### ACT 4: Edit Order + Price Overrides
Edit order → override Fertilizer Gamma price to $38 → change Adjuvant Beta qty 10→8 → save.
**Verify:** Prebooked adjusted, commissions recalculated, totals updated.

### ACT 5: Partial Delivery #1
New delivery → Herbicide=8, Adjuvant=0, Fertilizer=12 → schedule → start → complete.
**Verify:** Available/prebooked decremented, Team Board shows delivery, order=partially_fulfilled.

### ACT 6: Cancel Partial Order
Cancel remaining Adjuvant Beta (undelivered portion).
**Verify:** Prebooked released for Adjuvant, commissions recalculated.

### ACT 7: Deliver Remaining
New delivery → Herbicide=7 → schedule → start → complete.
**Verify:** All prebooked=0, order=fulfilled, Team Board shows delivery.

### ACT 8: Create Invoice + Post
Create invoice from order → verify line items → post invoice.
**Verify:** Customer AR increased, invoice in Current aging bucket.

### ACT 9: Partial Payment
Record 50% payment against invoice.
**Verify:** Invoice balance = total - payment, customer AR decreased.

### ACT 10: Returns
Return 3× Herbicide Alpha (good, restock) + 2× Fertilizer Gamma (damaged, no restock).
Approve → receive → credit.
**Verify:** Herbicide available +3, Fertilizer unchanged, credit memo created, AR reduced.

### ACT 11: Commission Payment
Create commission payment batch → post.
**Verify:** Commissions marked paid, financial dashboard reflects.

### ACT 12: Final Reconciliation
Verify: inventory = start - delivered + restocked, AR = invoice - payments - credits, all transactions visible.

## Verification Helpers

- `snapshotInventory(page, productIds[])` — inventory state from DB
- `assertInventoryDelta(before, after, productId, field, delta)` — exact change assertion
- `snapshotCustomerAR(page, customerId)` — AR balance from DB
- `snapshotCommissions(page, orderId)` — commission records

## Error Recovery

Fix bugs in place, resume from failure point. State object `S` persists across steps.

## Final Validation

After first pass completes with all fixes, run entire suite once more from beginning for clean regression validation. Cleanup all test data. Push to git.

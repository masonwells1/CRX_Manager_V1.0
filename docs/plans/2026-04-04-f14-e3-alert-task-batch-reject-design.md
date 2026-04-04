# F14: Alert → Task + E3: Batch Reject Blend Tickets — Design

> Created: 2026-04-04 | Owner: Mason Wells | Status: **Approved**

## Feature F14: Alert → Task Conversion

**Problem:** Dashboard Action Queue shows specific actionable items but there's no way to assign them as tasks. Users see "INV-001 is 15 days overdue" but can't create accountability without manually navigating to Team Board.

**Solution:** Add a "create task" button per Action Queue item that opens QuickTaskModal pre-filled with context.

### Changes
- **ActionQueue.tsx** — Add task icon button per item, state for QuickTaskModal
- **Mapping:** overdue_invoices→invoice, cancelled_posted→order, overdue_deliveries→delivery, low_stock→product, expiring_quotes→quote, unassigned_deliveries→delivery
- **Prefill:** title from category+item, assignee = current user, priority = high for overdue/cancelled
- **LinkedEntityType** — Add 'invoice' and 'product' if missing

### No new RPC needed — reuses QuickTaskModal insert.

---

## Feature E3: Batch Reject Blend Tickets

**Problem:** Batch approve exists but batch reject doesn't. Users must reject tickets one by one.

**Solution:** Add "Batch Reject" button next to existing "Batch Approve" in BlendTickets bulk action bar.

### Changes
- **New RPC:** `batch_reject_blend_tickets(p_ticket_ids, p_rejected_by, p_idempotency_key)`
- **BlendTickets.tsx** — Add button, ConfirmModal, handler
- **Activity logging** — Log batch_rejected event

---

## Implementation Order
1. E3 migration (batch reject RPC)
2. E3 frontend (BlendTickets.tsx)
3. F14 frontend (ActionQueue.tsx)
4. Tests + build + commit

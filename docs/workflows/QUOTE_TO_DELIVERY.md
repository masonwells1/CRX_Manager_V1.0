# Quote to Delivery Pipeline

Complete reference for the business pipeline from quoting a customer through delivery and payment.

---

## Pipeline Overview

```
Quote (draft) -> Send -> Accept -> Convert to Order -> Create Delivery -> Confirm -> Complete -> Invoice -> Payment
```

There is also a **Quick Delivery** shortcut that creates an order + delivery + draft invoice in one atomic step (skips the quote entirely).

---

## Stage 1: Quote

### Tables involved
- `quotes` — header (quote_number, customer_id, status, tier, totals, is_planned, expires_at)
- `quote_sections` — sections within a quote (section_name, sort_order)
- `quote_items` — line items (product_id, section_id, pricing, rates, acres, totals)
- `quote_versions` — frozen snapshots of sent quotes (version_number, snapshot_data jsonb)

### Source files
- `src/pages/Quotes.tsx` — quote list with status filters
- `src/pages/QuoteBuilder.tsx` — multi-line quote editor (both `/quotes/new` and `/quotes/:id`)

### Status transitions
Allowed values: `draft`, `sent`, `revised`, `accepted`, `declined`, `expired`, `cancelled`, `closed_by_application`, `closed_short`.
- **draft**: Initial state. Can be edited freely.
- **sent**: Quote was sent to the customer. A `quote_versions` snapshot is created.
- **closed_by_application**: Terminal planned quote fulfilled through application jobs rather than converted to a chemical-sale order.
- **closed_short**: Terminal partially drawn booking closed without fulfilling the remaining quantity.
- **revised**: Edits were made after sending. New version snapshot created on next send.
- **accepted**: Customer accepted. The `is_planned` flag can reserve inventory via holds.
- **declined**: Customer said no.
- **expired**: Past the `expires_at` date.

### Key RPC
- `save_quote()` — atomic save of header + sections + items in one transaction
- `duplicate_quote()` — clones a quote for reuse

Quote sections and quote items are RPC-owned: browser roles may read them but must not write them directly. `save_quote()` locks the parent quote and replaces its child collection in the same transaction, so its row-version check covers both header and line edits.

### Rules
- Tier pricing: customers have assigned tier (1-4). Quote inherits the customer's tier but can be overridden per item.
- `is_planned` flag: when true, inventory holds are created to reserve stock.
- Commission splits stored as JSONB: `{ splits: [{ recipient, percentage }] }`
- Always call `logActivity()` after send/accept/decline events.

### What can go wrong
- Forgetting to create a `quote_versions` snapshot before sending
- Changing product prices after a quote was sent (the snapshot preserves the original)
- Commission splits that don't add up to 100%

---

## Stage 2: Order

### Tables involved
- `orders` — header (order_number, status, totals, order_date). NOTE: `total_paid` and `balance_due` were DROPPED — accounts receivable is derived from `invoices.balance_cents`, the single source of truth (verified live 2026-07-16).
- `order_items` — line items (quantity_delivered, quantity_remaining)
- `commissions` — per-order per-recipient (split_percentage, commission_amount, status, paid_date)

### Source files
- `src/pages/Orders.tsx` — order list
- `src/pages/OrderDetail.tsx` — order detail with status transitions
- `src/pages/NewOrder.tsx` — direct order creation (bypasses quote)

### Status transitions
```
confirmed -> partially_fulfilled -> fulfilled -> cancelled -> voided
```
- **confirmed**: Order is active and ready for delivery.
- **partially_fulfilled**: Some items have been delivered (quantity_remaining > 0 for some items).
- **fulfilled**: All items delivered (quantity_remaining = 0 for all items).
- **cancelled**: Order was cancelled.

### Key RPCs
- `convert_quote_to_order()` — creates order + order_items + commissions from an accepted quote
- `create_direct_order()` — creates an order without a quote
- `cancel_order()` — cancels order and releases any inventory holds
- `update_order_items()` — modify order items (admin only)

### Rules
- Accounts receivable is tracked on `invoices` (`invoices.balance_cents`, GENERATED), NOT on the order. The order header has no `total_paid`/`balance_due` — those columns were dropped.
- Commission records are created automatically during order creation.
- Money must remain exact whole cents: new storage uses bigint cents. Legacy PostgreSQL
  numeric-dollar storage is approved only after exact `numeric` arithmetic, clean finite whole-cent
  values, and an active finite whole-cent CHECK are verified; dirty or unconstrained columns remain
  findings. Parse decimal input exactly instead of multiplying a binary float.
- Always use `checkMutationResult()` after writes.
- Always use `generateIdempotencyKey()` for order creation to prevent double-submissions.

### What can go wrong
- Creating an order from a quote that wasn't accepted
- Forgetting that order items have `quantity_remaining` which drives delivery fulfillment
- Modifying an order after deliveries have already been made

---

## Stage 3: Delivery

### Tables involved
- `deliveries` — header (delivery_number, order_id, assigned_driver, scheduled_date, status, signature_url, priority, delivery_window, is_quick_delivery)
- `delivery_items` — items on delivery (order_item_id, product_id, quantity)
- `delivery_photos` — driver-uploaded photos (storage_path, image_url)
- `delivery_remainders` — partial delivery leftovers (remainder_quantity, status)

### Source files
- `src/pages/Deliveries.tsx` — delivery list + driver dashboard + batch actions (~900 lines)
- `src/pages/NewDelivery.tsx` — create delivery from an order
- `src/pages/DeliveryDetail.tsx` — full lifecycle: confirm, edit, cancel, photos, issues (~1350 lines)
- `src/pages/DeliveryRemainders.tsx` — pending remainders across all customers

### Status transitions
```
scheduled -> in_progress -> completed -> cancelled -> voided
```
- **scheduled**: Delivery is planned, driver assigned.
- **in_progress**: Driver has confirmed/started delivery (`confirm_delivery()` RPC).
- **completed**: Delivery finished (`complete_delivery()` RPC). Inventory deducted, order updated.
- **cancelled**: Delivery was cancelled (`cancel_delivery()` or `batch_cancel_deliveries()`).
- **voided**: Completed delivery reversed by admin (`void_delivery()` RPC). Inventory restored.

### Two-step delivery flow (CRITICAL)
1. **`confirm_delivery()`** — transitions scheduled -> in_progress. Shows inventory warning if stock is low.
2. **`complete_delivery()`** — transitions in_progress -> completed. This is where the real work happens:
   - Deducts inventory (creates `inventory_transactions` of type 'delivered')
   - Updates `order_items.quantity_delivered` and `quantity_remaining`
   - May update order status to `partially_fulfilled` or `fulfilled`
   - Creates `delivery_remainders` rows for any partial deliveries

You **CANNOT** skip from scheduled directly to completed. The in_progress step is mandatory.

### Key RPCs
- `confirm_delivery()` — scheduled -> in_progress
- `complete_delivery()` — in_progress -> completed (requires in_progress status)
- `edit_delivery()` — logistics (date, driver, notes) always; items editable only when status = 'scheduled'
- `cancel_delivery()`, `batch_cancel_deliveries()` — cancel one or many
- `reassign_delivery()` — change the assigned driver
- `create_followup_delivery()` — create a new delivery for remainder items
- `get_customer_delivery_remainders()` — list pending remainders for a customer
- `create_quick_delivery()` — atomic: creates order + delivery + draft invoice in one transaction

### Rules
- Delivery items are editable while status = 'scheduled' (add, remove, adjust quantities from the parent order).
- Once delivery is in_progress or beyond, items are LOCKED — only logistics (date, driver, notes, priority) can be edited.
- Removed items remain on the order's `quantity_remaining` for future deliveries.
- Drivers can upload up to 10 photos per delivery (compressed client-side).
- Drivers can report issues (issue_type + issue_notes fields).
- Quick deliveries have `is_quick_delivery = true` flag and skip the quote/order flow.
- Always call `logActivity()` on status transitions.
- Always use `generateIdempotencyKey()` for `complete_delivery()`.

### What can go wrong
- Trying to complete a delivery that's still in "scheduled" status
- Editing delivery items after delivery has started (items are locked once in_progress)
- Completing a delivery when inventory is insufficient (the RPC warns but proceeds)
- Forgetting to handle delivery remainders after a partial delivery

---

## Stage 4: Invoice

### Tables involved
- `invoices` — header (invoice_number, order_id, customer_id, status, balance_cents bigint, due_date)
- `invoice_items` — line items (quantity, unit_price_cents, extended_cents). NOTE: the line-total column is `extended_cents`, not `line_total_cents` (verified live 2026-07-16).
- `financial_audit_log` — immutable audit trail for all financial changes

### Source files
- `src/pages/Invoices.tsx` — invoice list (unposted/posted), batch print, batch void
- `src/pages/InvoiceDetail.tsx` — post/unpost, print PDF, write-off

### Status transitions
```
draft -> unposted -> posted -> paid -> overdue -> voided -> cancelled
```
- **draft**: Created from order or quick delivery. Can be edited.
- **posted**: Locked. Starts AR aging. Amounts cannot be changed.
- **paid**: Fully paid (balance_cents = 0).
- **overdue**: Past due date and unpaid.
- **voided**: Cancelled. Reverses AR impact.

### Rules
- All money is bigint cents: `balance_cents`, `unit_price_cents`, `extended_cents`.
- Posted invoices are LOCKED — no editing amounts.
- All changes to invoices are logged in `financial_audit_log` (immutable, append-only).
- Quick deliveries auto-create a draft invoice.
- Invoice PDFs: 3 layouts via `src/lib/invoicePdf.ts`.

---

## Stage 5: Payment

### Tables involved
- `payments` — payment records (order_id, amount, payment_method, reference_number)
- `allocation_sets` — payment-to-invoice groupings
- `order_line_allocations` — payment portions applied to order items
- `invoice_line_allocations` — payment portions applied to invoice items
- `prepay_credits` — prepayment credits (remaining_cents)
- `prepay_applications` — prepay credit applications to invoices

### Source files
- `src/pages/PaymentAllocation.tsx` — unified payment entry (route: `/payments`)

### Rules
- Payments are allocated to invoices via `allocate_payment` RPC. AR is tracked on invoices (single source of truth).
- Payment allocation links specific payment amounts to specific invoice line items.
- Prepay credits can be auto-applied to oldest unpaid invoices.
- All payment activity is logged in `financial_audit_log`.
- Use `generateIdempotencyKey()` for payment creation.

---

## Quick Delivery (Shortcut Path)

Skips the entire quote flow. One atomic operation:

1. User opens Quick Delivery modal (from Deliveries page or driver dashboard)
2. Search/select customer
3. Add products with quantities
4. Optionally assign driver, set date, add notes
5. Submit -> `create_quick_delivery()` RPC creates:
   - Order (status: confirmed)
   - Delivery (status: scheduled)
   - Draft invoice
6. Sales rep reviews and posts the draft invoice

### Source: `create_quick_delivery()` RPC

---

## Downstream Impact Map

If you change one stage, check everything downstream:

| Change | Must also check |
|--------|----------------|
| Quote pricing | Order totals, invoice amounts, commission calculations |
| Order items | Delivery items (locked), invoice items, quantity_remaining |
| Delivery completion | Inventory levels, order fulfillment status, delivery remainders |
| Invoice posting | AR aging, payment allocation, finance charges |
| Payment recording | invoice balance_cents (AR — the order has no balance_due), prepay credits |

---

## Safety Checklist for Pipeline Changes

- [ ] Read the RPC source code before modifying any step
- [ ] Use `checkMutationResult()` after every write
- [ ] Use `generateIdempotencyKey()` for order creation, delivery completion, payment recording
- [ ] Call `logActivity()` for status transitions
- [ ] Test with all 3 roles: admin, sales_rep, driver
- [ ] Verify inventory levels after delivery completion
- [ ] Verify order status updates after delivery completion
- [ ] Check that delivery remainders are created for partial deliveries

---

## Field Application Workflow (Phase 1, 2026-04-29)

Field application invoices are a parallel branch — they don't go through the quote → order → delivery pipeline. There are two entry points:

1. **Direct field app invoice** — `/invoices/field-app/new` calls `save_field_app_invoice()`
2. **Blend ticket** — once approved, `create_invoice_from_blend_ticket()` produces invoice(s)

### Multi-customer fields → grouped split invoices

When the selected fields have `field_billing_defaults` rows for multiple customers, both entry-point RPCs produce **one invoice per customer**, all sharing an `invoice_group_id`:

```
2 customers × shared field
  → derive_customer_shares_from_fields() returns per-(field × customer) detail
  → save_field_app_invoice() inserts:
      • invoices.id × N (one per customer, shared invoice_group_id)
      • field_app_locations × M (keyed at group level when N > 1)
      • field_app_location_shares × (M × N) — TRUE per-customer split
      • invoice_shares × N (one 100% row per child invoice — PDF compat)
  → returns { invoice_ids: [...], invoice_group_id }
```

AR is keyed off `invoices.customer_id` directly. Each child invoice has its own `balance_cents`, statement, finance charges, etc. — no AR consumer changes were needed.

### Pricing modes (Mode A vs Mode B)

For each (customer × field) pair, the RPC chooses ONE of:

- **Mode A — Grower share** (when `field_billing_defaults.price_override_cents IS NOT NULL`):
  - One $/ac line per overridden field (`price × share_acres`)
  - Per-product chemical lines at $0 (informational, scaled to that customer's share of acres)
  - **No** application service fee — override is all-inclusive
  - `invoice_items.price_source = 'manual'`

- **Mode B — Line-item billing** (no override):
  - Per-product chemical lines priced at: `manual_override > quoted (quote_sections.field_id linkage) > customer.assigned_tier × product.tierN_price`
  - Application service fee from `customer_application_rates` override → `application_services.default_rate_per_acre_cents`
  - `invoice_items.price_source` ∈ `{'manual', 'quoted', 'tier'}`

A single customer can be in BOTH modes simultaneously if some of their fields have overrides and others don't — the chemical-quantity loop tracks `qty_a` (override fields) and `qty_b` (non-override fields) separately.

### Posted edit/post lock

`save_field_app_invoice` raises if **any** member of the invoice group is not in `draft`/`unposted`. Edits are wipe-and-rebuild for safety. Frontend mirrors this with `canEdit` covering siblings.

### Atomic group posting

`post_invoice_group(p_invoice_group_id, p_performed_by, p_idempotency_key)` posts every invoice in a group in one transaction. Pre-flight checks period-open and status for all siblings; any failure rolls back the whole group. The frontend `InvoiceDetail` Post button auto-routes through this RPC when `invoice.invoice_group_id` is set.

### Pricing preview

`preview_field_app_invoice_split(p_locations, p_chemicals, p_application_service_id)` returns the same per-customer breakdown without writing. Backs the "Preview" button on the field app invoice page so the user can verify amounts before saving.

### Source files
- `src/pages/FieldApplicationInvoice.tsx` — multi-tab editor, sibling banner, Preview/Post buttons
- `src/pages/BlendTicketDetail.tsx` — Create Invoice button, accepts `{invoice_ids, invoice_group_id}` shape
- `src/components/field-app/CustomerSharesTable.tsx` — preview-aware customer breakdown
- `src/components/field-app/FieldAppChemicalEntry.tsx` — tier-aware preview pricing, manual override toggle
- `src/components/field-app/ApplicationServicePicker.tsx` — service dropdown driving fee calculation
- `src/pages/InvoiceDetail.tsx` — group-aware Post button (routes through `post_invoice_group` for grouped invoices)

### Safety checklist for field-app changes
- [ ] `derive_customer_shares_from_fields` falls back to `fields.customer_id` at 100% when no `field_billing_defaults` rows exist
- [ ] Both RPCs return `{ invoice_ids: string[]; invoice_group_id: string | null }` shape
- [ ] `field_app_location_shares` carries the TRUE per-customer split (not 100% to invoice's own customer)
- [ ] `invoice_shares` populated for every invoice (one 100% row per child) — PDF/statement compat
- [ ] Posted-status check covers the whole group, not just the invoice being edited
- [ ] All RPCs verified to have exactly one overload via `DO $$` block at end of migration

# Launch Readiness UX — Design Doc

**Date:** 2026-03-19
**Goal:** Make CRX Manager self-explanatory for 3 users (admin, sales admin, delivery driver) going live 2026-03-20.
**Approach:** Enhanced empty states, contextual HelpTip icons, role-aware Getting Started page, RLS security fix.

---

## 1. HelpTip Component

Reusable `<HelpTip text="..." />` — renders a small `HelpCircle` icon (16px, muted color). Click → popover with tip text. Click outside to dismiss. No external library.

**Props:** `text: string`, optional `className`.

**File:** `src/components/ui/HelpTip.tsx`

---

## 2. Enhanced Empty States

Update 4 core pages to show workflow-guiding empty states:

### Quotes (`src/pages/Quotes.tsx`)
- Title: "No quotes yet"
- Description: "Quotes are the first step — build a quote, send it to your customer, then convert it to an order."
- Action: "Create Your First Quote" button → `/quotes/new`

### Orders (`src/pages/Orders.tsx`)
- Title: "No orders yet"
- Description: "Start by creating a quote in Sales → Quotes, then convert it to an order. Or create a direct order below."
- Actions: "New Quote" button → `/quotes/new`, "New Order" button → `/orders/new`

### Deliveries (`src/pages/Deliveries.tsx`)
- Title: "No deliveries scheduled"
- Description: "Deliveries are created from orders. Open an order and click 'Schedule Delivery' to get started."
- Action: "View Orders" button → `/orders`

### Team Board (`src/pages/TeamBoard.tsx`)
- Title: "Your team board is empty"
- Description: "Create notes, tasks, and announcements to keep your team coordinated."
- Action: "Create First Note" button (triggers create note flow)

---

## 3. Contextual Help Tips (~26 tips)

### QuoteBuilder (`src/pages/QuoteBuilder.tsx`) — 8 tips

| Location | Tip |
|----------|-----|
| Planned toggle | "Mark as Planned if the customer intends to buy but hasn't committed yet. This reserves inventory with a hold so it's not sold to someone else. Set the Needed By date so you can forecast when product will move." |
| Needed By Date | "This is when the customer needs the product — different from the quote expiration. Used for inventory forecasting and delivery scheduling." |
| Section Header Notes | "These notes print above the items in the PDF. Use for delivery instructions like 'Apply before 10am' or 'Requires cool storage'." |
| Send Quote button | "Sends the quote PDF to the customer's email and locks it as 'Sent'. A version snapshot is saved automatically so you can always see what the customer received." |
| Version History | "Every time you send or revise, a snapshot is saved. You can compare versions side-by-side or restore an older version if needed." |
| Convert to Order | "Creates a confirmed order from this quote. Inventory holds transfer to the order and the customer gets a confirmation email." |
| Save as Template | "Saves this quote's structure as a reusable template. Great for customers who reorder the same products each season." |
| Roll Over | "Copies this planned program into the next season (Oct-Sep) with the same products and quantities. Dates update automatically." |

### OrderDetail (`src/pages/OrderDetail.tsx`) — 5 tips

| Location | Tip |
|----------|-----|
| Schedule Delivery | "Creates a new delivery from this order's items. The driver will see it on their dashboard and can start it when ready." |
| Create Invoice | "Generates a draft invoice from the order. It stays in draft until you review and post it — nothing is sent to the customer yet." |
| Fulfillment % bar | "Shows how much of the order has been delivered, weighted by dollar value. 100% means all items are fully delivered." |
| Program Notes | "Notes about this order that carry through to the load sheet and delivery. Use for special instructions like 'Call before delivering'." |
| Inventory warning | "This means available inventory is lower than the order quantity. The order still goes through — this is a heads-up so you can reorder if needed." |

### DeliveryDetail (`src/pages/DeliveryDetail.tsx`) — 6 tips

| Location | Tip |
|----------|-----|
| Start Delivery | "Marks this delivery as in-progress. You can now adjust quantities, capture photos, and get the customer's signature." |
| Photo Upload | "Take up to 10 photos as proof of delivery — product condition, drop location, etc. These attach to the delivery record and can be included in the customer email." |
| Signature Canvas | "Have the customer sign with their finger or mouse. This saves as part of the delivery record for your files." |
| Complete Delivery | "Finalizes the delivery. Inventory is deducted, the customer gets an email receipt, and a draft invoice is created automatically." |
| Email Receipt checkbox | "If checked, the customer receives an email with the items delivered, photos, and signature. Uncheck if this is an internal transfer." |
| Partial quantities | "Adjust quantities down if you couldn't deliver everything. The remaining items automatically create a follow-up delivery." |

### TeamBoard (`src/pages/TeamBoard.tsx`) — 4 tips

| Location | Tip |
|----------|-----|
| Create Note button | "Notes can be tasks, reminders, or announcements. Assign to a team member, set a due date, and link to an order or delivery for context." |
| Entity Link dropdown | "Link this note to an order, quote, delivery, or customer. The note will show up on that record's detail page too." |
| Tags | "Color-coded tags help organize notes. Filter by tag to see only what's relevant — like 'Urgent' or 'Follow-up'." |
| Delivery Bulletin | "Shows today's scheduled deliveries and yesterday's completed ones. Quick way to see what's moving without leaving the board." |

### List Pages — 3 tips

| Page | Location | Tip |
|------|----------|-----|
| Quotes | Planned badge | "Planned quotes reserve inventory but aren't committed orders yet. Use the Planned Programs filter to see all of them." |
| Orders | Fulfillment/Invoiced % | "Fulfillment shows delivery progress. Invoiced shows billing progress. Both are weighted by dollar value." |
| Deliveries | Shortage icon | "This delivery has items where warehouse stock is running low. Check inventory before dispatching." |

---

## 4. Getting Started Page

**Route:** `/getting-started`
**Sidebar:** Top section, BookOpen icon, visible to all roles
**File:** `src/pages/GettingStarted.tsx`

### Admin / Sales Admin View
Visual stepper: Quote → Send → Convert to Order → Schedule Delivery → Invoice & Collect

Three sections:
- Quotes: "Start here. Build a quote, mark as Planned to reserve inventory, or send directly to the customer."
- Orders & Deliveries: "Once a quote is accepted, convert it to an order. Then schedule deliveries — drivers pick them up from their dashboard."
- Team Board: "Keep your team in sync. Create tasks, link them to orders or deliveries, and track progress."

### Driver View
Visual stepper: Check Dashboard → Start Delivery → Get Signature & Photos → Complete

Two sections:
- Dashboard: "Your scheduled deliveries show up here each morning."
- Completing a Delivery: "Start it, adjust quantities if needed, take photos, get the customer to sign, then hit Complete. The office gets notified automatically."

### Auto-dismiss
"Don't show this again" checkbox → saves to localStorage. Sidebar link always available.

---

## 5. RLS Security Fix

Add deny-all RLS policy on `rate_limit_log` table. Migration file: `20260319200000_rate_limit_log_rls.sql`

```sql
ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all access to rate_limit_log"
  ON rate_limit_log FOR ALL USING (false);
```

---

## Implementation Order

1. HelpTip component (foundation for everything else)
2. Getting Started page + sidebar link
3. Enhanced empty states (4 pages)
4. QuoteBuilder help tips (8)
5. OrderDetail help tips (5)
6. DeliveryDetail help tips (6)
7. TeamBoard help tips (4)
8. List page help tips (3)
9. RLS migration
10. Build + test + deploy

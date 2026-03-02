# Top 10 App Improvements Roadmap

> Created: 2026-02-27 | Status: **Deferred** — revisit after v1.0 team launch

## Future Improvements (0 of 10 completed)

- [ ] **#1** Transaction Thread cross-links (Order ↔ Invoice ↔ Delivery)
- [ ] **#2** Consolidate sidebar 9 → 6 categories

## Details

### #3 — Customer 360 View on CustomerDetail
- Add tabs: Profile | Orders | Deliveries | Financials | Fields
- Embed customer's orders, deliveries, AR balance, payments, fields inline
- Eliminates bouncing across 6 pages to understand one customer
- **Impact:** Very High | **Risk:** Medium

### #4 — Global Command Palette (Ctrl+K)
- Search across customers, products, orders, invoices, deliveries, jobs
- Recent items first, then exact matches, then fuzzy
- Eliminates sidebar-hunting for any entity
- **Impact:** Very High | **Risk:** Low

### #5 — Absorb 4 Low-Traffic Pages Into Parents
- Brand vs Generic → button on ProductDetail
- Delivery Remainders → tab on Deliveries page
- Application Records → tab on Jobs page
- Notifications → bell dropdown only (remove standalone page)
- Result: 48 pages → 44 pages
- **Impact:** Medium | **Risk:** Very Low

### #6 — Dashboard Action Queue (Replace Passive Alerts)
- Replace 6 passive alert cards with actionable "Action Items" section
- Each item is specific, clickable, and countable (goal = zero)
- "3 invoices ready to post" → click → filtered view
- **Impact:** High | **Risk:** Low

### #7 — Standardize List Page Patterns
- Create `useListPage` hook or `<ListPageShell>` wrapper
- Standardize: loading, search, filters, bulk selection, export, empty state
- Shrinks each list page by 100-200 lines of boilerplate
- **Impact:** High | **Risk:** Medium

### #8 — Mobile-Optimized Driver Flow
- Detect driver-role + mobile viewport → show simplified step-by-step flow
- 4 steps: Review items → Start → Photos/Signature → Complete
- Large touch targets (48px+), prominent offline indicator
- **Impact:** High | **Risk:** Medium

### #9 — Email Notifications for Critical Events
- New Edge Function + email service (Resend/SendGrid)
- Events: new delivery assigned, delivery issue, invoice overdue, over credit limit, PO received, month-end reminder
- User preference toggles per event type
- **Impact:** High | **Risk:** Medium

### #10 — Workflow Guardrails
- Duplicate order warning
- Overloaded driver warning
- Zero-quantity line item block
- Credit limit soft-block
- Stale quote warning
- Quick Delivery suggestion when doing manual Order→Delivery→Invoice
- **Impact:** Medium | **Risk:** Low

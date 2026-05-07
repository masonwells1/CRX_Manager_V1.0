# Phase 0 — Orientation & System Map (CRX Manager V1.0)

## Plain-English executive readout (for Mason)

Think of this app like your whole operation inside one office:
- **Front desk (React pages)** where your team clicks buttons.
- **Back office clerk (Supabase RPC/SQL functions)** that should do the critical math and inventory moves.
- **Filing cabinets (Postgres tables)** that store products, quotes, orders, deliveries, payments, and audit logs.

I mapped the full structure first before testing behavior. I also traced the two most important business “spines”:
1. **Inventory spine** (where gallons/pounds move), and
2. **Quote/price spine** (where dollars are calculated).

Key Phase 0 finding: the app has strong server-side RPC coverage for inventory/order/payment transitions, **but quote math is also computed in the browser**. That split creates drift risk if UI math and DB math ever disagree.

---

## SYSTEM MAP

### 1) Routes & Pages (every URL currently defined)

Source of truth: `src/App.tsx`

| URL Path | Component |
|---|---|
| `/login` | `LoginPage` |
| `/` | `Dashboard` |
| `/products` | `Products` |
| `/products/:id` | `ProductDetail` |
| `/customers` | `Customers` |
| `/customers/:id` | `CustomerDetail` |
| `/quotes` | `Quotes` |
| `/quotes/new` | `QuoteBuilder` |
| `/quotes/:id` | `QuoteBuilder` |
| `/orders` | `Orders` |
| `/orders/new` | `NewOrder` |
| `/orders/:id` | `OrderDetail` |
| `/inventory` | `InventoryPage` |
| `/deliveries` | `Deliveries` |
| `/deliveries/new` | `NewDelivery` |
| `/deliveries/:id` | `DeliveryDetail` |
| `/blend-tickets` | `BlendTickets` |
| `/blend-tickets/:id` | `BlendTicketDetail` |
| `/purchase-orders` | `PurchaseOrders` |
| `/purchase-orders/new` | `NewPurchaseOrder` |
| `/purchase-orders/:id` | `PurchaseOrderDetail` |
| `/brand-vs-generic` | `BrandVsGeneric` |
| `/reports` | `Reports` |
| `/crop-programs` | `CropPrograms` |
| `/payments` | `Payments` |
| `/team-board` | `TeamBoard` |
| `/notifications` | `Notifications` |
| `/settings` | `SettingsPage` (admin-only wrapper) |
| `*` | Redirect to `/` |

---

### 2) Database schema map (current table inventory)

> Note: Business docs mention “25 tables,” but migration history now defines **35** tables total.

#### Core operational tables
- `profiles`
- `products`
- `cost_history`
- `customers`
- `customer_addresses`
- `quotes`
- `quote_sections`
- `quote_items`
- `quote_versions`
- `orders`
- `order_items`
- `inventory`
- `inventory_transactions`
- `inventory_holds`
- `purchase_orders`
- `purchase_order_items`
- `deliveries`
- `delivery_items`
- `payments`
- `commissions`

#### Collaboration / visibility / reference
- `ingredient_map`
- `unit_conversions`
- `team_notes`
- `team_note_comments`
- `note_tags`
- `team_note_tags`
- `note_activity_log`
- `activity_feed`
- `notifications`
- `app_settings`

#### Blend ticket / OCR pipeline
- `blend_tickets`
- `blend_ticket_products`
- `blend_ticket_images`
- `ocr_processing_queue`

#### Reliability / platform
- `idempotency_keys`

#### Relationship highlights (high-value links)
- `quotes.customer_id -> customers.id`
- `quote_items.quote_id -> quotes.id`
- `orders.quote_id -> quotes.id`
- `order_items.order_id -> orders.id`
- `deliveries.order_id -> orders.id`
- `delivery_items.order_item_id -> order_items.id`
- `payments.order_id -> orders.id`
- `inventory.product_id -> products.id`
- `inventory_transactions.product_id -> products.id`
- `inventory_transactions.order_id -> orders.id`

---

### 3) Backend functions map (RPCs, triggers, Edge Functions)

#### Key RPC functions actively used by app flows
- `generate_quote_number()`
- `generate_order_number()`
- `convert_quote_to_order(p_quote_id, p_performed_by)`
- `create_direct_order(...)`
- `update_order_items(...)`
- `cancel_order(...)`
- `complete_delivery(...)`
- `receive_po_items(...)`
- `adjust_inventory(...)`
- `record_payment(...)`
- `generate_ticket_number()`

#### Supporting reliability/security functions
- `check_idempotency(...)`
- `save_idempotency(...)`
- `is_admin()`, `is_sales_rep()`, `is_driver()`
- `admin_update_profile(...)`

#### Trigger families present in migrations
- Auth profile bootstrap trigger (`on_auth_user_created`)
- Pricing/unit validation triggers (product updates)
- Team board activity/comment triggers
- Order/delivery/PO status-change triggers
- Inventory significant-change trigger

#### Edge Functions found
- `create-user` (admin creates platform users)
- `process-blend-ticket` (OCR parse + mapping workflow)
- `seed-admin` (guarded dev/staging admin seeding)
- `setup-blend-tickets-storage` (returns setup instructions)

---

### 4) Frontend service/data access map

Supabase client singleton: `src/lib/db.ts`

#### Service/util modules that directly call Supabase
- `src/lib/activityLogger.ts`
- `src/lib/notificationTriggers.ts`
- `src/lib/offlineSync.ts` (RPC sync replay)
- `src/hooks/useOCRProcessor.ts` (OCR queue + Edge invoke)
- `src/contexts/AuthContext.tsx`

#### Page-level direct data access
Most pages call `supabase.from(...)` or `supabase.rpc(...)` directly (instead of a centralized API service layer), including:
- `QuoteBuilder`, `Quotes`, `Orders`, `OrderDetail`, `NewOrder`
- `InventoryPage`
- `PurchaseOrders`, `PurchaseOrderDetail`, `NewPurchaseOrder`
- `Deliveries`, `DeliveryDetail`, `NewDelivery`
- `Payments`
- `Customers`, `CustomerDetail`
- `Products`, `ProductDetail`
- `Reports`, `Dashboard`, `TeamBoard`, `Notifications`, `BlendTickets`

---

### 5) State management / data flow map

#### State model in frontend
- Primary state pattern is local React state (`useState`, `useMemo`, `useEffect`) per page.
- Global auth/session state is centralized in `AuthContext`.
- No Redux/Zustand global data store detected.

#### Typical data flow path
1. User click/form submit on page component
2. Component computes/validates local state
3. Page issues `supabase.from(...)` query or `supabase.rpc(...)`
4. DB writes/reads and trigger/RPC side-effects execute
5. Result mapped back into page state + toast/UI feedback

---

### 6) Authentication & role system map

- Supabase Auth session is read in `AuthContext` and profile is loaded from `profiles` table.
- `ProtectedRoute` gates routes by:
  - logged-in session,
  - active user status (`profile.is_active`),
  - optional role list (`allowedRoles`).
- Sidebar hides nav entries based on `profile.role`, but UI hiding is not security by itself; RLS/policies must enforce data access in DB.
- `settings` route is explicitly wrapped with `allowedRoles={['admin']}`.

---

## Inventory Spine (trace of quantity changes)

Plain-English analogy: this is your warehouse whiteboard. Every event should move numbers in the right bucket so you never over-promise product.

### A) PO received -> stock increases
- UI calls `receive_po_items` RPC from inventory and PO detail pages.
- RPC increments `inventory.quantity_available`, decrements `quantity_on_order`, updates PO item receipt totals, writes `inventory_transactions`, and auto-updates PO status.

### B) Quote approved/converted -> inventory prebooked/reserved
- Quote conversion uses `convert_quote_to_order` RPC.
- Function creates order + order_items and writes inventory prebook movements / transaction logs (prebooking intent).

### C) Direct order creation -> reservation/commitment path
- `NewOrder` uses `create_direct_order` RPC (atomic server function) rather than browser-only inserts.

### D) Delivery complete -> committed becomes delivered
- Delivery completion flow uses `complete_delivery` RPC (offline sync also replays this RPC).
- Function updates delivery/order fulfillment state and writes delivery-related inventory transactions.

### E) Manual adjustment -> corrected quantity + audit
- Inventory page uses `adjust_inventory` RPC for controlled adjustments.
- Function writes adjustment transactions for audit history.

### F) Return/cancel flows
- `cancel_order` RPC exists to unwind order state and release inventory linkage.
- `inventory_transactions.transaction_type` includes `returned`, but return UX flow still needs full Phase 3 verification.

### G) Additional reservation layer
- `inventory_holds` table is used by inventory UI for explicit hold records (prebooking helper layer).

---

## Quote / Price Spine (trace of dollar math)

Plain-English analogy: this is your pricing calculator. If two calculators exist (browser and database) and they disagree, margin can leak without anyone noticing.

### A) Line math in QuoteBuilder (frontend)
In `QuoteBuilder`, the browser computes:
- price per unit by tier,
- rate/unit conversions,
- total units needed,
- line total price,
- line profit/margin,
- quote totals (price/cost/profit/margin).

### B) Persisted quote totals
The same frontend computed totals are saved into `quotes` + `quote_items` rows.

### C) Conversion to order (backend)
`convert_quote_to_order` RPC uses persisted quote/item values to create order records and related downstream data.

### D) Pricing automation in DB
Database has `calculate_prices_from_margin` and unit validation logic, but quote-total composition is still performed in React page logic.

### Phase 0 risk callout (preliminary)
- **Single source of truth for quote math: NO (currently split).**
- Frontend performs mission-critical total calculations, while backend also has pricing-related functions.
- This is a production-readiness risk and will be deep-tested in Phase 4.

---

## Known unknowns (explicit)

Not yet executed in Phase 0:
- runtime click testing,
- role impersonation tests,
- network/offline fault injection,
- end-to-end math validation with known numeric fixtures.

Those are scheduled for later phases after your checkpoint confirmation.

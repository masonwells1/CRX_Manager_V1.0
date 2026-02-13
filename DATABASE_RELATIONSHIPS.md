# Database Relationship Diagram
**Crop RX Solutions - Entity Relationships**

---

## Entity Relationship Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AUTHENTICATION & USERS                          │
└─────────────────────────────────────────────────────────────────────────┘

    auth.users (Supabase managed)
         │
         │ 1:1 (auto-created via trigger)
         ↓
    profiles (id, email, full_name, role, phone, is_active)
         │
         ├──→ role: 'admin' | 'sales_rep' | 'driver'
         │
         │ Used throughout as FK for:
         ├──→ customers.assigned_sales_rep
         ├──→ quotes.created_by
         ├──→ orders.created_by (implicit)
         ├──→ deliveries.assigned_driver
         ├──→ deliveries.created_by
         ├──→ purchase_orders.created_by
         ├──→ cost_history.changed_by
         ├──→ inventory_transactions.performed_by
         ├──→ team_notes.created_by / assigned_to / completed_by
         ├──→ notifications.user_id
         ├──→ activity_feed.performed_by
         ├──→ financial_audit_log.performed_by
         ├──→ blend_recipes.created_by
         ├──→ cycle_counts.counted_by
         ├──→ returns.requested_by / approved_by
         └──→ rebate_programs.created_by

┌─────────────────────────────────────────────────────────────────────────┐
│                           PRODUCT CATALOG                               │
└─────────────────────────────────────────────────────────────────────────┘

    products (598+ items with 3-tier pricing)
         │
         ├──→ Used by:
         │    ├─ quote_items.product_id
         │    ├─ order_items.product_id
         │    ├─ inventory.product_id
         │    ├─ inventory_transactions.product_id
         │    ├─ purchase_order_items.product_id
         │    ├─ delivery_items.product_id
         │    ├─ ingredient_map.generic_product_id
         │    ├─ invoice_items.product_id
         │    ├─ blend_recipe_items.product_id
         │    ├─ return_items.product_id
         │    ├─ rebate_programs.product_id
         │    ├─ rebate_claims.product_id
         │    └─ cycle_count_items.product_id
         │
         └──→ Audit trail:
              └─ cost_history (tracks price changes over 2 years)

┌─────────────────────────────────────────────────────────────────────────┐
│                         CUSTOMER MANAGEMENT                             │
└─────────────────────────────────────────────────────────────────────────┘

    customers (farm_name, contact_name, assigned_tier, assigned_sales_rep)
         │
         ├──→ 1:many customer_addresses (delivery locations)
         │              │
         │              └──→ deliveries.delivery_address_id
         │
         ├──→ 1:many quotes
         ├──→ 1:many orders
         ├──→ 1:many deliveries
         ├──→ 1:many commissions
         ├──→ 1:many activity_feed entries
         ├──→ 1:many fields (farm fields / parcels)
         ├──→ 1:many applicator_licenses
         ├──→ 1:many returns
         ├──→ 1:many invoices
         ├──→ 1:many rebate_claims
         └──→ 1:many prepay_credits

┌─────────────────────────────────────────────────────────────────────────┐
│                           QUOTE WORKFLOW                                │
└─────────────────────────────────────────────────────────────────────────┘

    quotes (quote_number, customer_id, created_by, status, tier)
         │
         ├──→ 1:many quote_sections (program groups like "Corn", "Soybeans")
         │              │
         │              └──→ 1:many quote_items (products with pricing)
         │                            │
         │                            └──→ product_id → products
         │
         ├──→ 1:many quote_versions (frozen snapshots when sent)
         │              │
         │              └──→ sent_by → profiles
         │
         └──→ When accepted, creates:
                    └─ orders.quote_id (1:1 link)

    Quote Status Flow:
    draft → sent → revised → accepted/declined/expired

┌─────────────────────────────────────────────────────────────────────────┐
│                          ORDER FULFILLMENT                              │
└─────────────────────────────────────────────────────────────────────────┘

    orders (order_number, quote_id, customer_id, status)
         │
         ├──→ 1:many order_items (copied from quote_items with fulfillment tracking)
         │              │
         │              ├──→ product_id → products
         │              ├──→ quote_item_id → quote_items (origin)
         │              └──→ quantity_delivered / quantity_remaining
         │
         ├──→ 1:many deliveries (scheduled shipments)
         │              │
         │              ├──→ assigned_driver → profiles
         │              ├──→ delivery_address_id → customer_addresses
         │              └──→ 1:many delivery_items
         │                            │
         │                            └──→ order_item_id → order_items
         │
         ├──→ 1:many commissions (calculated per order)
         ├──→ 1:many inventory_transactions (stock movements)
         ├──→ 1:many invoices (billing records)
         ├──→ 1:many returns (product returns)
         └──→ 1:many rebate_claims (rebate tracking)

    Order Status Flow:
    confirmed → partially_fulfilled → fulfilled / cancelled

┌─────────────────────────────────────────────────────────────────────────┐
│                      INVENTORY MANAGEMENT                               │
└─────────────────────────────────────────────────────────────────────────┘

    inventory (product_id, location, quantity_available, quantity_prebooked)
         │
         └──→ Changed by: inventory_transactions
                    │
                    ├──→ transaction_type: 'received' | 'booked' | 'delivered'
                    │                      'returned' | 'adjusted' | 'transferred'
                    ├──→ product_id → products
                    ├──→ order_id → orders (if related)
                    ├──→ purchase_order_id (if receiving stock)
                    ├──→ delivery_id (if delivering stock)
                    └──→ performed_by → profiles

┌─────────────────────────────────────────────────────────────────────────┐
│                         PROCUREMENT                                     │
└─────────────────────────────────────────────────────────────────────────┘

    purchase_orders (po_number, vendor, status, created_by)
         │
         └──→ 1:many purchase_order_items
                    │
                    ├──→ product_id → products
                    ├──→ quantity_ordered / quantity_received
                    └──→ When received → inventory_transactions

    PO Status Flow:
    draft → submitted → partially_received → fully_received / cancelled

┌─────────────────────────────────────────────────────────────────────────┐
│                    BILLING & INVOICES                                   │
└─────────────────────────────────────────────────────────────────────────┘

    invoices (invoice_number, order_id, customer_id, status, balance_cents)
         │
         ├──→ order_id → orders
         ├──→ customer_id → customers
         ├──→ status: 'draft' | 'posted' | 'void'
         │
         └──→ 1:many invoice_items
                    │
                    ├──→ invoice_id → invoices
                    ├──→ order_item_id → order_items
                    └──→ product_id → products

    allocation_sets (payment_id)
         │
         ├──→ payment_id → payments
         │
         ├──→ 1:many order_line_allocations
         │              │
         │              ├──→ set_id → allocation_sets
         │              └──→ order_item_id → order_items
         │
         └──→ 1:many invoice_line_allocations
                    │
                    ├──→ set_id → allocation_sets
                    └──→ invoice_line_id → invoice_items

    prepay_credits (customer_id, source_payment_id)
         │
         ├──→ customer_id → customers
         ├──→ source_payment_id → payments
         │
         └──→ 1:many prepay_applications
                    │
                    ├──→ credit_id → prepay_credits
                    └──→ invoice_id → invoices

    financial_audit_log (performed_by)
         │
         └──→ performed_by → profiles

    Invoice Status Flow:
    draft → posted → void

┌─────────────────────────────────────────────────────────────────────────┐
│                        FARM FIELDS                                      │
└─────────────────────────────────────────────────────────────────────────┘

    fields (customer_id)
         │
         ├──→ customer_id → customers
         │
         └──→ 1:many field_billing_defaults
                    │
                    ├──→ field_id → fields
                    └──→ customer_id → customers

┌─────────────────────────────────────────────────────────────────────────┐
│                      BLEND RECIPES                                      │
└─────────────────────────────────────────────────────────────────────────┘

    blend_recipes (created_by)
         │
         ├──→ created_by → profiles
         │
         └──→ 1:many blend_recipe_items
                    │
                    ├──→ recipe_id → blend_recipes
                    └──→ product_id → products

    blend_ticket_to_order_item (ticket_id, order_item_id)
         │
         ├──→ ticket_id → blend_tickets
         └──→ order_item_id → order_items

┌─────────────────────────────────────────────────────────────────────────┐
│                  WAREHOUSES & CYCLE COUNTS                              │
└─────────────────────────────────────────────────────────────────────────┘

    warehouses (standalone - name, location, etc.)
         │
         └──→ 1:many cycle_counts
                    │
                    ├──→ warehouse_id → warehouses
                    ├──→ counted_by → profiles
                    │
                    └──→ 1:many cycle_count_items
                               │
                               ├──→ cycle_count_id → cycle_counts
                               └──→ product_id → products

┌─────────────────────────────────────────────────────────────────────────┐
│                          RETURNS                                        │
└─────────────────────────────────────────────────────────────────────────┘

    returns (order_id, customer_id, requested_by, approved_by)
         │
         ├──→ order_id → orders
         ├──→ customer_id → customers
         ├──→ requested_by → profiles
         ├──→ approved_by → profiles
         │
         └──→ 1:many return_items
                    │
                    ├──→ return_id → returns
                    ├──→ order_item_id → order_items
                    ├──→ product_id → products
                    │
                    └──→ If restocked → inventory_transactions

┌─────────────────────────────────────────────────────────────────────────┐
│                        COMPLIANCE                                       │
└─────────────────────────────────────────────────────────────────────────┘

    applicator_licenses (customer_id)
         │
         └──→ customer_id → customers
              - Tracks license numbers, categories, expiry dates
              - Tied to products.is_rup for RUP compliance tracking

┌─────────────────────────────────────────────────────────────────────────┐
│                          REBATES                                        │
└─────────────────────────────────────────────────────────────────────────┘

    rebate_programs (product_id, created_by)
         │
         ├──→ product_id → products
         ├──→ created_by → profiles
         │
         └──→ 1:many rebate_claims
                    │
                    ├──→ program_id → rebate_programs
                    ├──→ order_id → orders
                    ├──→ customer_id → customers
                    └──→ product_id → products

┌─────────────────────────────────────────────────────────────────────────┐
│                    TEAM COLLABORATION                                   │
└─────────────────────────────────────────────────────────────────────────┘

    team_notes (title, content, note_type, priority, created_by, assigned_to)
         │
         ├──→ note_type: 'note' | 'todo' | 'announcement'
         ├──→ priority: 'low' | 'medium' | 'high' | 'urgent'
         ├──→ is_completed, completed_by, due_date
         └──→ 1:many team_note_comments
                    │
                    └──→ created_by → profiles

┌─────────────────────────────────────────────────────────────────────────┐
│                    ACTIVITY & NOTIFICATIONS                             │
└─────────────────────────────────────────────────────────────────────────┘

    activity_feed (event_type, description, performed_by)
         │
         ├──→ related_entity_type / related_entity_id (polymorphic)
         └──→ customer_id → customers (optional)

    notifications (user_id, title, message, notification_type, is_read)
         │
         ├──→ user_id → profiles
         └──→ related_entity_type / related_entity_id (polymorphic)

┌─────────────────────────────────────────────────────────────────────────┐
│                      REFERENCE DATA                                     │
└─────────────────────────────────────────────────────────────────────────┘

    unit_conversions (unit, factor_oz)
         - Conversion factors for Gal, Qt, Pt, Oz, Lb, etc.

    ingredient_map (branded_ingredient, generic_product_id)
         - Maps brand names to generic products
         └──→ generic_product_id → products

    app_settings (setting_key, setting_value)
         - Global app configuration
         - Default quote validity days, company info, etc.
```

---

## Key Relationships Summary

### Primary Flows

1. **Quote -> Order -> Delivery**
   ```
   customers → quotes → quote_sections → quote_items → products
                  ↓
               orders → order_items → deliveries → delivery_items
   ```

2. **Inventory Flow**
   ```
   purchase_orders → purchase_order_items → inventory_transactions → inventory
                                                                          ↓
   orders → deliveries → inventory_transactions → inventory
   ```

3. **User Assignment**
   ```
   profiles (sales_rep) → customers → quotes → orders
   profiles (driver) → deliveries
   profiles (admin) → everything
   ```

4. **Invoice & Payment Flow**
   ```
   orders → invoices → invoice_items
   payments → allocation_sets → order_line_allocations
                              → invoice_line_allocations
   prepay_credits → prepay_applications → invoices
   ```

5. **Return Flow**
   ```
   orders → returns → return_items → inventory_transactions (if restocked)
   ```

6. **Compliance Flow**
   ```
   customers → applicator_licenses
   products.is_rup → compliance tracking
   ```

7. **Rebate Flow**
   ```
   rebate_programs → rebate_claims → payments
   ```

### Polymorphic References

Some tables use polymorphic relationships (not enforced by FK):
- `activity_feed.related_entity_type/id`
- `notifications.related_entity_type/id`

These allow linking to any entity type (quote, order, delivery, etc.) for activity tracking.

---

## Foreign Key Cascade Rules

### ON DELETE CASCADE (Children deleted with parent)
- customer_addresses → customers
- quote_sections → quotes
- quote_items → quotes
- quote_versions → quotes
- order_items → orders
- delivery_items → deliveries
- purchase_order_items → purchase_orders
- team_note_comments → team_notes
- cost_history → products
- profiles → auth.users
- invoice_items → invoices
- blend_recipe_items → blend_recipes
- cycle_count_items → cycle_counts
- return_items → returns
- field_billing_defaults → fields

### ON DELETE SET NULL / NO ACTION (Preserve records)
- customers.assigned_sales_rep (FK to profiles)
- quotes.created_by (FK to profiles)
- deliveries.assigned_driver (FK to profiles)
- orders.quote_id (preserve even if quote deleted)

---

## Index Coverage

All foreign key columns are indexed for efficient joins:

### Customer Path
```sql
idx_customers_rep (assigned_sales_rep)
idx_addresses_customer (customer_id)
```

### Quote Path
```sql
idx_quotes_customer (customer_id)
idx_quotes_created_by (created_by)
idx_qsections_quote (quote_id)
idx_qitems_quote (quote_id)
idx_qitems_section (section_id)
idx_qitems_product (product_id)
```

### Order Path
```sql
idx_orders_customer (customer_id)
idx_orders_quote (quote_id)
idx_oitems_order (order_id)
idx_oitems_product (product_id)
```

### Delivery Path
```sql
idx_deliveries_order (order_id)
idx_deliveries_customer (customer_id)
idx_deliveries_driver (assigned_driver)
idx_deliveries_address (delivery_address_id)
idx_del_items_delivery (delivery_id)
idx_del_items_order_item (order_item_id)
```

### Inventory Path
```sql
idx_inventory_product (product_id)
idx_inv_tx_product (product_id)
idx_inv_tx_order (order_id)
idx_po_items_product (product_id)
```

---

## Data Flow Examples

### Creating a Quote
1. Sales rep creates `quotes` record
2. Sales rep adds `quote_sections` (e.g., "Corn Program")
3. Sales rep adds `quote_items` within each section (links to `products`)
4. System calculates totals, margins
5. Quote sent → `quote_versions` snapshot created
6. Customer accepts → `orders` record created, `order_items` copied from `quote_items`

### Fulfilling an Order
1. Order confirmed → `order_items` created from quote
2. Admin creates `deliveries` record
3. Admin adds `delivery_items` (links to `order_items`)
4. Driver assigned → `deliveries.assigned_driver` set
5. Delivery completed → `delivery_items.quantity` updates `order_items.quantity_delivered`
6. Inventory reduced → `inventory_transactions` record created

### Procurement
1. Admin creates `purchase_orders`
2. Admin adds `purchase_order_items` (products to order)
3. PO submitted to vendor
4. Stock received → `inventory_transactions` record created
5. Inventory updated → `inventory.quantity_available` increased

### Invoicing & Payment Allocation
1. Order fulfilled → `invoices` record created (status: draft)
2. Invoice posted → `invoice_items` link to `order_items` and `products`
3. Customer pays → `payments` record created
4. Payment allocated → `allocation_sets` groups line-level allocations
5. `order_line_allocations` apply payment to specific order items
6. `invoice_line_allocations` apply payment to specific invoice lines
7. All financial changes logged in `financial_audit_log`

### Prepay Credits
1. Customer makes advance payment → `prepay_credits` created (links to `payments`)
2. Invoice posted → `prepay_applications` deducts from credit balance
3. Credit applied reduces `invoices.balance_cents`

### Processing a Return
1. Sales rep requests return → `returns` record created (links to `orders`, `customers`)
2. Admin approves → `returns.approved_by` set
3. Items specified → `return_items` link to `order_items` and `products`
4. If restocked → `inventory_transactions` record created (type: 'returned')

### Cycle Count
1. Admin initiates count → `cycle_counts` record created (links to `warehouses`)
2. Counter assigned → `cycle_counts.counted_by` set
3. Items counted → `cycle_count_items` link to `products` with counted quantities
4. Variances resolved → `inventory_transactions` for adjustments

### Rebate Claim
1. Admin creates `rebate_programs` (links to `products`)
2. Qualifying orders trigger `rebate_claims` (links to `orders`, `customers`, `products`)
3. Approved claims generate `payments` to customers

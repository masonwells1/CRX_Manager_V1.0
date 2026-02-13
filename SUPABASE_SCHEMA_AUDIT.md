# Supabase Schema & Auth Audit
**Crop RX Solutions - Database Architecture**

---

## Executive Summary

✅ **Authentication**: Already using Supabase Auth with proper patterns
✅ **Row Level Security**: Enabled on all 40+ tables with comprehensive policies
✅ **Schema**: Complete with proper relationships and indexes
✅ **Security**: Role-based access control (admin, sales_rep, driver)

---

## 1. Authentication Implementation

### Current Status: **FULLY IMPLEMENTED ✓**

The application correctly uses Supabase Auth:

- **Auth Table**: `auth.users` (managed by Supabase)
- **Profile Sync**: Automatic via `handle_new_user()` trigger
- **Client Auth**: Uses `supabase.auth.signInWithPassword()` and `supabase.auth.signOut()`
- **Session Management**: Proper `onAuthStateChange` listener in `AuthContext.tsx`

### Auth Flow

```
1. User signs up → auth.users row created
2. Trigger fires → profiles row auto-created with same ID
3. User logs in → Session established
4. RLS policies use auth.uid() → Checks against profiles.id
```

---

## 2. Database Schema (40+ Tables)

### Core Tables

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **profiles** | User accounts linked to auth.users | References: auth.users(id) |
| **customers** | Grower/farm CRM records | FK: assigned_sales_rep → profiles |
| **customer_addresses** | Multiple delivery addresses per customer | FK: customer_id → customers |
| **products** | Product master (598+ items, 3-tier pricing) | - |

### Quote Management

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **quotes** | Quote headers with status tracking | FK: customer_id → customers, created_by → profiles |
| **quote_sections** | Program groups within quotes | FK: quote_id → quotes |
| **quote_items** | Individual product line items | FK: quote_id → quotes, section_id → quote_sections, product_id → products |
| **quote_versions** | Frozen snapshots of sent quotes | FK: quote_id → quotes, sent_by → profiles |

### Order Management

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **orders** | Confirmed orders from accepted quotes | FK: quote_id → quotes, customer_id → customers |
| **order_items** | Order line items with fulfillment tracking | FK: order_id → orders, product_id → products, quote_item_id → quote_items |

### Inventory & Procurement

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **inventory** | Stock levels per product per warehouse | FK: product_id → products |
| **inventory_transactions** | Complete audit trail of stock movements | FK: product_id → products, order_id → orders, performed_by → profiles |
| **purchase_orders** | Orders to suppliers | FK: created_by → profiles |
| **purchase_order_items** | Line items on supplier POs | FK: purchase_order_id → purchase_orders, product_id → products |

### Delivery Management

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **deliveries** | Scheduled customer deliveries | FK: order_id → orders, customer_id → customers, assigned_driver → profiles, delivery_address_id → customer_addresses |
| **delivery_items** | Products on each delivery | FK: delivery_id → deliveries, order_item_id → order_items, product_id → products |

### Financial & Reporting

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **commissions** | Earned commissions per order per recipient | FK: order_id → orders, customer_id → customers |
| **cost_history** | 2-year cost change log per product | FK: product_id → products, changed_by → profiles |

### Reference Data

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **ingredient_map** | Brand to generic product lookup | FK: generic_product_id → products |
| **unit_conversions** | Unit conversion factors | - |

### Collaboration & Activity

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **team_notes** | Shared notes, to-dos, announcements | FK: created_by → profiles, assigned_to → profiles, completed_by → profiles |
| **team_note_comments** | Comments on shared notes | FK: note_id → team_notes, created_by → profiles |
| **activity_feed** | Auto-generated action log | FK: performed_by → profiles, customer_id → customers |
| **notifications** | Push notifications per user | FK: user_id → profiles |

### Configuration

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **app_settings** | Global app configuration | FK: updated_by → profiles |

### Billing / Invoicing

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **invoices** | Invoice headers with posting workflow | FK: order_id → orders, customer_id → customers, created_by → profiles |
| **invoice_items** | Invoice line items | FK: invoice_id → invoices, order_item_id → order_items, product_id → products |
| **allocation_sets** | Payment allocation groups | FK: payment_id → payments |
| **order_line_allocations** | Payment allocated to order items | FK: set_id → allocation_sets, order_item_id → order_items |
| **invoice_line_allocations** | Payment allocated to invoice items | FK: set_id → allocation_sets, invoice_line_id → invoice_items |
| **prepay_credits** | Prepayment credit tracking | FK: customer_id → customers, source_payment_id → payments |
| **prepay_applications** | Prepay credit applications | FK: credit_id → prepay_credits, invoice_id → invoices |
| **financial_audit_log** | Immutable financial change trail | FK: performed_by → profiles |

### Farm Fields

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **fields** | Farm field records | FK: customer_id → customers |
| **field_billing_defaults** | Per-field billing splits | FK: field_id → fields, customer_id → customers |

### Blend Recipes

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **blend_recipes** | Saved blend formulas | FK: created_by → profiles |
| **blend_recipe_items** | Recipe ingredients | FK: recipe_id → blend_recipes, product_id → products |
| **blend_ticket_to_order_item** | Ticket-order linkage | FK: ticket_id → blend_tickets, order_item_id → order_items |

### Warehouses & Cycle Counts

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **warehouses** | Storage locations | - |
| **cycle_counts** | Count sessions | FK: warehouse_id → warehouses, counted_by → profiles |
| **cycle_count_items** | Individual count lines | FK: cycle_count_id → cycle_counts, product_id → products |

### Returns / RMA

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **returns** | Return/RMA headers | FK: order_id → orders, customer_id → customers, requested_by → profiles |
| **return_items** | Return line items | FK: return_id → returns, order_item_id → order_items, product_id → products |

### Compliance

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **applicator_licenses** | Pesticide license tracking | FK: customer_id → customers |

### Rebates

| Table | Purpose | Key Relationships |
|-------|---------|-------------------|
| **rebate_programs** | Manufacturer rebate programs | FK: product_id → products, created_by → profiles |
| **rebate_claims** | Claims against programs | FK: program_id → rebate_programs, order_id → orders, customer_id → customers |

---

## 3. Row Level Security (RLS) Policies

### Role-Based Access Control

The application uses three roles defined in `profiles.role`:
- **admin**: Full access to all data and operations
- **sales_rep**: Access to quotes, customers, orders they created/manage
- **driver**: Limited access to assigned deliveries

### Helper Functions

```sql
is_admin()      -- Returns true if current user is admin
is_sales_rep()  -- Returns true if current user is sales_rep
is_driver()     -- Returns true if current user is driver
```

All functions use:
- `SECURITY DEFINER` for RLS bypass
- `STABLE` for query optimization
- `SET search_path = public` to prevent search_path attacks
- `(select auth.uid())` wrapped in subquery for performance

### Policy Summary by Table

#### profiles
- ✅ SELECT: Own profile OR admin
- ✅ INSERT: Own profile OR admin
- ✅ UPDATE: Own profile OR admin
- ✅ DELETE: None (profiles are never deleted, only deactivated)

#### products
- ✅ SELECT: All authenticated users
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

#### customers
- ✅ SELECT: Admin OR sales_rep OR driver (if assigned delivery)
- ✅ INSERT: Admin OR sales_rep (if assigned to self)
- ✅ UPDATE: Admin OR sales_rep (if assigned to self)
- ✅ DELETE: Admin only

#### quotes
- ✅ SELECT: Admin OR sales_rep
- ✅ INSERT: Admin OR sales_rep (if created_by = self)
- ✅ UPDATE: Admin OR sales_rep (if created_by = self)
- ✅ DELETE: Admin only

#### orders
- ✅ SELECT: Admin OR sales_rep
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

#### deliveries
- ✅ SELECT: Admin OR sales_rep OR driver (if assigned to self)
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin OR driver (if assigned to self)
- ✅ DELETE: Admin only

#### inventory
- ✅ SELECT: Admin OR sales_rep OR driver
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

#### team_notes
- ✅ SELECT: All authenticated users
- ✅ INSERT: Any authenticated user (created_by = self)
- ✅ UPDATE: Creator OR admin
- ✅ DELETE: Admin only

#### notifications
- ✅ SELECT: Own notifications only (user_id = self)
- ✅ INSERT: Admin OR self-notification
- ✅ UPDATE: Own notifications only (user_id = self)
- ✅ DELETE: None

#### All Other Original Tables
Similar restrictive policies based on role and ownership checks.

#### invoices, invoice_items, allocation_sets, order/invoice_line_allocations
- ✅ SELECT: Admin OR sales_rep
- ✅ INSERT: Admin OR sales_rep
- ✅ UPDATE: Admin only (invoice_items: Admin; allocations: none)
- ✅ DELETE: Admin only (allocations: Admin)

#### financial_audit_log
- ✅ SELECT: Admin only
- ✅ INSERT: All authenticated (immutable)
- ✅ UPDATE: None (immutable)
- ✅ DELETE: None (immutable)

#### fields, field_billing_defaults
- ✅ SELECT: Admin OR sales_rep (assigned customer)
- ✅ INSERT: Admin OR sales_rep
- ✅ UPDATE: Admin OR sales_rep
- ✅ DELETE: Admin (fields); Admin/Sales Rep (billing defaults)

#### blend_recipes, blend_recipe_items
- ✅ SELECT: All authenticated
- ✅ INSERT: Admin OR sales_rep
- ✅ UPDATE: Admin OR sales_rep
- ✅ DELETE: Admin (recipes); Admin/Sales Rep (items)

#### warehouses, cycle_counts, cycle_count_items
- ✅ SELECT: All authenticated (warehouses); Admin (counts)
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

#### returns, return_items
- ✅ SELECT: Admin OR sales_rep
- ✅ INSERT: Admin OR sales_rep
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

#### applicator_licenses
- ✅ SELECT: Admin OR sales_rep
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

#### rebate_programs, rebate_claims
- ✅ SELECT: Admin only
- ✅ INSERT: Admin only
- ✅ UPDATE: Admin only
- ✅ DELETE: Admin only

### Security Improvements Applied

The second migration (`20260206174345_fix_security_and_performance_issues.sql`) applied:

1. **Performance**: Wrapped all `auth.uid()` calls in `(select auth.uid())` for query planner optimization
2. **Consolidated Policies**: Merged multiple permissive policies into single policies with OR conditions
3. **Search Path Security**: Added `SET search_path = public` to all helper functions
4. **Fixed Unrestricted Insert**: Changed notifications insert policy from `WITH CHECK (true)` to proper ownership check
5. **Missing Indexes**: Added 21 missing FK indexes for query performance

---

## 4. Indexes

### Coverage

**✓ All foreign key columns indexed** (21 additional indexes added)
**✓ Status columns indexed** (quotes, orders, deliveries, purchase_orders)
**✓ Date columns indexed** (scheduled_date, created_at)
**✓ Common filter columns indexed** (category, vendor, is_active, is_read)

### Performance Optimization

- All relationships have proper FK indexes
- Query planner can efficiently resolve joins
- RLS policy lookups are optimized
- Time-based queries (dashboards, reports) are indexed

---

## 5. Data Integrity

### Constraints

- ✅ **Check Constraints**: Role, tier, status fields use CHECK constraints
- ✅ **NOT NULL**: All critical fields marked NOT NULL
- ✅ **UNIQUE**: Unique constraints on quote_number, order_number, po_number, delivery_number
- ✅ **Foreign Keys**: All relationships enforced with FK constraints
- ✅ **ON DELETE CASCADE**: Child records auto-deleted where appropriate

### Default Values

- ✅ **UUIDs**: Generated via `gen_random_uuid()`
- ✅ **Timestamps**: Auto-set via `now()` or `CURRENT_DATE`
- ✅ **Booleans**: Sensible defaults (e.g., `is_active DEFAULT true`)
- ✅ **Numerics**: Zero defaults for financial fields

---

## 6. Auto-Profile Creation

### Trigger: `handle_new_user()`

```sql
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
```

**Behavior**:
1. When a new user signs up via Supabase Auth
2. Trigger automatically creates matching `profiles` row
3. Inherits: `id`, `email`, `full_name`, `role` from auth metadata
4. Runs as SECURITY DEFINER to bypass RLS

---

## 7. Frontend Integration

### Auth Context (`src/contexts/AuthContext.tsx`)

**Provides**:
- `session`: Current Supabase session
- `profile`: Current user's profile data
- `role`: User's role (admin, sales_rep, driver)
- `loading`: Auth loading state
- `signIn(email, password)`: Login method
- `signOut()`: Logout method

**Properly implements**:
- ✅ `onAuthStateChange` listener
- ✅ Async profile fetching on session change
- ✅ Session persistence
- ✅ Cleanup on unmount

---

## 8. Migration Checklist

### ✅ Authentication
- [x] Using Supabase Auth (not custom auth)
- [x] `profiles` table references `auth.users(id)`
- [x] Auto-profile creation via trigger
- [x] Frontend uses `supabase.auth.*` methods
- [x] Proper session management in React context

### ✅ Row Level Security
- [x] RLS enabled on all 40+ tables
- [x] No tables with missing RLS
- [x] All policies use `auth.uid()` for user identification
- [x] Policies wrapped in subqueries for performance
- [x] Role-based policies use helper functions

### ✅ Security Best Practices
- [x] Helper functions use SECURITY DEFINER
- [x] Search path protection on all functions
- [x] No policies with `USING (true)` without reason
- [x] Restrictive INSERT policies check ownership
- [x] UPDATE policies have both USING and WITH CHECK
- [x] DELETE policies are admin-only (except where appropriate)

### ✅ Performance Optimization
- [x] All foreign key columns indexed
- [x] Status fields indexed
- [x] Date fields indexed
- [x] Common filter columns indexed
- [x] RLS policies optimized with subqueries

### ✅ Data Integrity
- [x] All relationships have FK constraints
- [x] ON DELETE CASCADE where appropriate
- [x] CHECK constraints on enums
- [x] NOT NULL on critical fields
- [x] UNIQUE constraints on business keys
- [x] Default values on all appropriate columns

### ✅ Frontend Best Practices
- [x] Single centralized Supabase client (`src/lib/db.ts`)
- [x] Auth context properly manages session
- [x] All DB calls use centralized client
- [x] Proper error handling in auth methods
- [x] Loading states managed correctly

---

## 9. Verification Steps

### Test Auth Flow

```bash
# 1. Create test user (via Supabase Dashboard or API)
# 2. Verify profile auto-created
SELECT * FROM profiles WHERE email = 'mason@croprxsolutions.com';

# 3. Verify RLS policies work
# (As authenticated test user)
SELECT * FROM customers;  -- Should see customers based on role
```

### Test RLS Policies

```sql
-- Test as sales_rep
SELECT auth.uid();  -- Verify current user
SELECT * FROM quotes WHERE created_by = auth.uid();  -- Should see own quotes
SELECT * FROM quotes WHERE created_by != auth.uid();  -- Should see other reps' quotes too

-- Test as driver
SELECT * FROM deliveries WHERE assigned_driver = auth.uid();  -- Should see assigned deliveries
```

### Test Role Helpers

```sql
SELECT is_admin();      -- Should return true/false
SELECT is_sales_rep();  -- Should return true/false
SELECT is_driver();     -- Should return true/false
```

---

## 10. RPC Functions

### RPC Functions (Phase 7)
- `get_ar_aging(p_as_of_date)` -- AR aging buckets by customer
- `get_customer_statement(p_customer_id, p_start_date, p_end_date)` -- Customer transaction history with running balance
- `get_season_comparison(p_season_a, p_season_b)` -- Year-over-year metrics comparison

All three are `SECURITY DEFINER STABLE`.

---

## 11. Summary

### Current State: **PRODUCTION READY ✓**

The Crop RX Solutions application has:

1. ✅ **Proper Supabase Auth integration**
2. ✅ **Comprehensive RLS policies on all tables**
3. ✅ **Role-based access control (admin, sales_rep, driver)**
4. ✅ **Optimized queries with proper indexes**
5. ✅ **Secure helper functions with search_path protection**
6. ✅ **Auto-profile creation trigger**
7. ✅ **Centralized database client**
8. ✅ **Frontend auth context with session management**

### No Migration Required

The application is **already using Supabase Auth patterns correctly**. No migration is needed.

### Recommendations

1. **User Management**: Implement user creation UI for admins
2. **Password Reset**: Add forgot password flow
3. **Email Verification**: Consider enabling email confirmation (currently disabled)
4. **MFA**: Consider Multi-Factor Authentication for admin users
5. **Audit Logging**: Consider logging all admin actions to activity_feed

---

## 12. SQL Reference (Complete Schema)

See attached migration files:
- `supabase/migrations/20260206172436_create_full_schema_v2.sql` - Initial schema
- `supabase/migrations/20260206174345_fix_security_and_performance_issues.sql` - Security fixes
- `supabase/migrations/20260206174743_add_profile_trigger_and_admin_user.sql` - Profile trigger
- `supabase/migrations/20260213000000_phase1_fields_foundation.sql` - Farm fields & field billing defaults
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql` - Invoices, allocations, prepay credits, financial audit log
- `supabase/migrations/20260213120000_phase3_blend_ticket_order_linkage.sql` - Blend ticket to order item linkage
- `supabase/migrations/20260213140000_phase4a_blend_recipes.sql` - Blend recipes & recipe items
- `supabase/migrations/20260213160000_phase5_inventory_enhancements.sql` - Warehouses, cycle counts
- `supabase/migrations/20260213180000_phase6_returns_rma.sql` - Returns & return items
- `supabase/migrations/20260213200000_phase7_reporting_compliance_rebates.sql` - Applicator licenses, rebate programs, rebate claims, RPC functions

All migrations are **idempotent** and safe to re-run.

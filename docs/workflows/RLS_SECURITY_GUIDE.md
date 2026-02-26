# RLS Security Guide

Complete reference for Row Level Security in CRX Manager.

---

## What is RLS?

Row Level Security (RLS) controls which rows each user can see and modify in the database. Every table in CRX Manager has RLS enabled — this is mandatory. Without RLS policies, a table returns zero rows to everyone (which is the safe default).

---

## The 3 Roles

CRX Manager has 3 main roles stored in `profiles.role`:

| Role | Who | Access level |
|------|-----|-------------|
| `admin` | Mason and other administrators | Full access to everything |
| `sales_rep` | Sales representatives | Access to own customers, quotes, orders. No access to month-end, commissions, settings. |
| `driver` | Delivery drivers | Access to own assigned deliveries. Can confirm, complete, upload photos, report issues. |

There's also an `applicator` role for job scheduling:
| `applicator` | Chemical applicators | Access to own assigned jobs. Can record applied info. |

---

## Helper Functions

These SQL functions check the current user's role. They are `SECURITY DEFINER` and `STABLE`, meaning they run with elevated privileges and are cached per-query.

```sql
is_admin()       -- Returns TRUE if current user has role = 'admin'
is_sales_rep()   -- Returns TRUE if current user has role = 'sales_rep'
is_driver()      -- Returns TRUE if current user has role = 'driver'
is_applicator()  -- Returns TRUE if current user has role = 'applicator'
```

### How they work
Each function queries the `profiles` table for the current user's role:
```sql
CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = (select auth.uid()) AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

---

## Critical Rule: Always Use `(select auth.uid())`

**WRONG (evaluates per row — slow):**
```sql
USING (customer_id = auth.uid())
```

**RIGHT (evaluates once — fast):**
```sql
USING (customer_id = (select auth.uid()))
```

The parentheses and `select` keyword make PostgreSQL evaluate `auth.uid()` once per query instead of once per row. This is a major performance difference on large tables.

---

## Common RLS Policy Patterns

### Pattern 1: Admin-only access
```sql
CREATE POLICY "table_select" ON public.table_name
  FOR SELECT TO authenticated
  USING (is_admin());
```
Used on: `cost_history`, `cycle_counts`, `cycle_count_items`, `rebate_programs`, `rebate_claims`

### Pattern 2: All authenticated users can read
```sql
CREATE POLICY "table_select" ON public.table_name
  FOR SELECT TO authenticated
  USING (true);
```
Used on: `products`, `app_settings`, `team_notes`, `activity_feed`, `blend_recipes`, `warehouses`

### Pattern 3: Admin + Sales Rep (with ownership)
```sql
-- Sales reps see their own, admin sees all
CREATE POLICY "quotes_select" ON public.quotes
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR (is_sales_rep() AND created_by = (select auth.uid()))
  );
```
Used on: `quotes`, `quote_sections`, `quote_items`

### Pattern 4: Admin + Sales Rep + Driver (for deliveries)
```sql
-- Drivers see only their assigned deliveries
CREATE POLICY "deliveries_select" ON public.deliveries
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_sales_rep()
    OR (is_driver() AND assigned_driver = (select auth.uid()))
  );
```

### Pattern 5: Own data only
```sql
-- Users can only see their own notifications
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));
```
Used on: `notifications`

### Pattern 6: Insert own data
```sql
CREATE POLICY "activity_feed_insert" ON public.activity_feed
  FOR INSERT TO authenticated
  WITH CHECK (performed_by = (select auth.uid()));
```

### Pattern 7: Append-only (no updates or deletes)
```sql
-- financial_audit_log: insert only, no updates, no deletes
CREATE POLICY "audit_log_insert" ON public.financial_audit_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- No UPDATE or DELETE policies = nobody can modify/delete rows
```
Used on: `financial_audit_log`

---

## Full RLS Policy Matrix

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | All authenticated | Own/Admin | Own/Admin | - |
| products | All authenticated | Admin | Admin | Admin |
| cost_history | Admin | Admin | - | - |
| customers | Admin / Sales Rep (assigned) / Driver (has delivery) | Admin / Sales Rep | Admin / Sales Rep (assigned) | Admin |
| customer_addresses | All authenticated | Admin / Sales Rep (own customer) | Admin / Sales Rep (own customer) | Admin |
| quotes | Admin / Sales Rep (own) | Admin / Sales Rep (own) | Admin / Sales Rep (own) | Admin |
| quote_sections | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_items | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_versions | All authenticated | Admin / Sales Rep (quote owner) | - | - |
| orders | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| order_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| inventory | Admin / Sales Rep / Driver | Admin | Admin | Admin |
| inventory_transactions | Admin / Sales Rep | Admin / Sales Rep | - | - |
| inventory_holds | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| purchase_orders | Admin / Sales Rep | Admin | Admin | Admin |
| purchase_order_items | Admin / Sales Rep | Admin | Admin | Admin |
| receiving_records | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| deliveries | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin / Sales Rep / Driver (assigned) | Admin |
| delivery_items | Admin / Sales Rep / Driver (via delivery) | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| delivery_photos | Admin / Sales Rep / Driver | Admin / Sales Rep / Driver | - | Admin |
| delivery_remainders | Admin / Sales Rep / Driver | Admin / Sales Rep | Admin / Sales Rep | Admin |
| commissions | Admin / Sales Rep (own recipient) | Admin | Admin | - |
| payments | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| team_notes | All authenticated | Own created_by | Own created_by / Admin | Admin |
| team_note_comments | All authenticated | Own created_by | - | - |
| activity_feed | All authenticated | Own performed_by | - | - |
| notifications | Own user_id | All authenticated | Own user_id | - |
| invoices | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| invoice_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| financial_audit_log | Admin | All authenticated | - | - |
| blend_recipes | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin |
| warehouses | All authenticated | Admin | Admin | Admin |
| cycle_counts | Admin | Admin | Admin | Admin |
| returns | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| return_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| rebate_programs | Admin | Admin | Admin | Admin |
| rebate_claims | Admin | Admin | Admin | Admin |

---

## Debugging: Why Is My Query Returning Empty?

If a query returns no rows when you expect data:

### Step 1: Check RLS
The most common cause is an RLS policy blocking access. The query succeeds (no error) but returns empty data.

### Step 2: Use `checkMutationResult()`
For writes, always use:
```typescript
const result = await supabase.from('table').update({ ... }).eq('id', id).select();
checkMutationResult(result, 'Update table');
```
This throws an error if zero rows were affected, which catches silent RLS denials.

### Step 3: Test in SQL Editor
Run the query directly in the Supabase SQL Editor as the affected user:
```sql
-- Check what role the user has
SELECT role FROM profiles WHERE id = 'user-uuid-here';

-- Test the query with that user's context
SET request.jwt.claims = '{"sub": "user-uuid-here"}';
SELECT * FROM table_name;
```

### Step 4: Check the policy
Look at the migration files for the table's RLS policies:
```bash
# Search for policies on a specific table
grep -r "CREATE POLICY.*table_name" supabase/migrations/
```

---

## Debugging: Why Is My Write Silently Failing?

Supabase returns `{ data: null, error: null }` when RLS blocks a write. This is NOT an error — it's a silent denial.

### Use `checkMutationResult()`
```typescript
const result = await supabase
  .from('customers')
  .update({ farm_name: 'New Name' })
  .eq('id', customerId)
  .select();

checkMutationResult(result, 'Update customer');
// Throws: "Update customer failed: no rows were affected. You may not have permission."
```

### Use `assertRpcResult()` for RPCs
```typescript
const { data } = await supabase.rpc('my_function', { params });
const result = assertRpcResult<ReturnType>(data, 'my_function');
```

---

## Safety Checklist for RLS Changes

- [ ] Every new table has `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- [ ] Every table has at least a SELECT policy
- [ ] Use `(select auth.uid())` not bare `auth.uid()` in all policies
- [ ] Use `DROP POLICY IF EXISTS` before `CREATE POLICY` for idempotency
- [ ] Test as all roles: admin, sales_rep, driver
- [ ] Use `checkMutationResult()` after every `.update()` and `.delete()`
- [ ] Use `assertRpcResult()` for SECURITY DEFINER RPCs
- [ ] Never remove existing RLS policies — add new ones or modify in a new migration

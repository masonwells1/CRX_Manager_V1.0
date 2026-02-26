# Database Change Checklist

Step-by-step guide for ANY database schema change. Follow every step — skipping steps causes bugs.

---

## Before You Start

1. **Read the existing schema** — check `docs/reference/database-schema.md` to understand what already exists
2. **Check for related tables** — if you're adding a column to `orders`, think about whether `order_items`, `deliveries`, or `invoices` also need changes
3. **Plan the migration** — write out what SQL you need before creating the file

---

## Step 1: Create the Migration File

### File naming convention
```
supabase/migrations/YYYYMMDDHHMMSS_description.sql
```

Example: `20260226150000_add_notes_to_deliveries.sql`

- Use the current date and time as the timestamp prefix
- Use snake_case for the description
- Keep the description short but clear

### Where the file goes
```
supabase/migrations/
```

### CRITICAL RULE: Never modify existing migration files. Always create a NEW one.

---

## Step 2: Write the SQL

### Every new TABLE must have:
```sql
-- 1. The table itself
CREATE TABLE IF NOT EXISTS public.my_new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- your columns here
);

-- 2. RLS enabled (MANDATORY — no exceptions)
ALTER TABLE public.my_new_table ENABLE ROW LEVEL SECURITY;

-- 3. RLS policies (at minimum: SELECT for authenticated users)
DROP POLICY IF EXISTS "my_new_table_select" ON public.my_new_table;
CREATE POLICY "my_new_table_select" ON public.my_new_table
  FOR SELECT TO authenticated
  USING (true);  -- adjust based on role requirements

-- 4. Updated_at trigger
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.my_new_table
  FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

-- 5. Indexes on frequently queried columns
CREATE INDEX IF NOT EXISTS idx_my_new_table_created_at
  ON public.my_new_table(created_at);
```

### Column naming conventions
| Convention | Example | Rule |
|-----------|---------|------|
| Boolean prefix | `is_active`, `is_planned`, `is_quick_delivery` | Always use `is_` prefix |
| Timestamp suffix | `created_at`, `updated_at`, `expires_at`, `cancelled_at` | Always use `_at` suffix |
| Foreign key suffix | `customer_id`, `order_id`, `product_id` | Always use `_id` suffix |
| Money columns | `balance_cents`, `unit_price_cents`, `line_total_cents` | Always use `_cents` suffix, bigint type |
| Status columns | `status TEXT NOT NULL DEFAULT 'draft'` | Use TEXT with a sensible default |

### Making migrations idempotent
Always use these patterns so the migration can be re-run safely:
```sql
-- Tables
CREATE TABLE IF NOT EXISTS ...

-- Columns
ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...

-- Policies (drop then create)
DROP POLICY IF EXISTS "policy_name" ON table_name;
CREATE POLICY "policy_name" ...

-- Triggers (check first)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_name') THEN
    CREATE TRIGGER ...
  END IF;
END $$;

-- Functions
CREATE OR REPLACE FUNCTION ...

-- Indexes
CREATE INDEX IF NOT EXISTS ...
```

---

## Step 3: Apply the Migration

Since you use the Supabase Dashboard:

1. Open the Supabase SQL Editor at: `https://supabase.com/dashboard/project/rhyzpcqhnizqbxphqdkr/sql`
2. Paste the entire migration SQL
3. Click "Run"
4. Check for errors in the output
5. If there are errors, fix them and run again (idempotent migrations are safe to re-run)

---

## Step 4: Update TypeScript Types

After changing the database, update the TypeScript interfaces:

### File: `src/types/index.ts`

Add or modify the interface that matches your table. Example:

```typescript
// If you added a 'notes' column to deliveries:
export interface Delivery {
  // ... existing fields ...
  notes: string | null;  // ADD THIS
}
```

### Rules
- All shared interfaces go in `src/types/index.ts`
- Use `string | null` for nullable columns
- Use `number` for bigint cents (TypeScript doesn't have bigint in JSON)
- Use `string` for UUIDs and timestamps
- Use `boolean` for `is_` prefixed columns

---

## Step 5: Update Affected Components

Find and update every file that uses the changed table:

1. Search the codebase for the table name (e.g., search for `'deliveries'` in `.from()` calls)
2. Update any `.select()` calls that need the new column
3. Update any forms or display components that should show the new data
4. Update any RPC functions that reference the table

---

## Step 6: Verify

Run these commands (or ask Claude to run them):

```bash
npm run typecheck    # Catches type mismatches
npm run build        # Catches import/compile errors
npm run test         # Catches broken tests
```

If `typecheck` fails, it usually means you forgot to update `src/types/index.ts`.

---

## Common Mistakes

| Mistake | Consequence | Prevention |
|---------|------------|------------|
| Forgetting RLS on new table | Data exposed to unauthorized users | Always add RLS + policies in the same migration |
| Forgetting `updated_at` trigger | `updated_at` never changes | Always add `moddatetime` trigger for new tables |
| Modifying an existing migration | Migration won't re-run (already applied) | Create a NEW migration file |
| Using `FLOAT` for money | Rounding errors in financial calculations | Always use `BIGINT` for cents |
| Forgetting to update types | TypeScript compile errors or missing data | Always update `src/types/index.ts` |
| Not making migration idempotent | Fails on re-run | Use `IF NOT EXISTS`, `DROP ... IF EXISTS` |
| Using bare `auth.uid()` in RLS | Performance issue (evaluates per-row) | Use `(select auth.uid())` (evaluates once) |
| Forgetting indexes on FK columns | Slow queries on large tables | Add index on every `_id` column |

---

## Quick Reference: Adding a Column

The most common database change. Here's the minimal checklist:

1. Create migration file: `supabase/migrations/YYYYMMDDHHMMSS_add_column_name.sql`
2. SQL: `ALTER TABLE public.table_name ADD COLUMN IF NOT EXISTS column_name TYPE DEFAULT value;`
3. Apply in Supabase SQL Editor
4. Update interface in `src/types/index.ts`
5. Update components that use this table
6. Run `npm run typecheck` and `npm run build`

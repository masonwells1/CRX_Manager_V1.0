# Database Change Checklist

Step-by-step guide for ANY database schema change. Follow every step — skipping steps causes bugs.

---

## Before You Start

1. **Read the existing schema** — check `docs/reference/database-schema.md` to understand what already exists
2. **Read the canonical SQL patterns** — use `docs/reference/sql-canonical-patterns.md` for SECURITY DEFINER, actor binding, idempotency, and mutation-result shapes
3. **Check for related tables** — if you're adding a column to `orders`, think about whether `order_items`, `deliveries`, or `invoices` also need changes
4. **Plan the migration** — write out what SQL you need before creating the file

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
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

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

## Step 3: Review, THEN Apply the Migration

> **Do NOT paste migration SQL into the Supabase Dashboard SQL Editor.** That path skips
> every guard this project has (migration-review proof, the apply-guard hook, the Codex
> gate, and Mason's approval) and leaves no record in `schema_migrations` — the file on
> disk and the live database silently drift apart. It caused exactly the incidents the
> guard system was built to stop. (Rewritten 2026-07-16 — the old text here predated the
> guard system and taught the dashboard path.)

The only sanctioned way to apply a migration to the live database:

1. Run `/migration-review` on the migration file. It dispatches the security/drift
   reviewers and, if clean, stamps the apply-guard proof for this exact file content.
2. For SQL/RLS/money changes, a real Codex verdict this session is also required
   (the `/migration-review` flow handles this; the apply-guard checks it).
3. Get authorization: in an ordinary interactive session, Mason's explicit in-chat OK.
   In a Mason-pre-authorized hands-free run with autopilot armed, the proof gate itself
   is the authorization (settled 2026-07-13) — destructive migrations are never autonomous.
4. Apply via the Supabase MCP `apply_migration` tool (the apply-guard hook verifies the
   proof and policy before the call is allowed through).
5. If the apply fails, do NOT retry variations against live — fix the migration file,
   re-run `/migration-review`, and apply again through the same gate.
6. After a successful schema change, run the `regen-schema-registry` workflow against
   that same database source. Do not use stamp-only mode as a substitute for live
   introspection; the schema-aware hooks must see the new columns and constraints.

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
| Forgetting `updated_at` trigger | `updated_at` never changes | Always add a `public.update_updated_at()` trigger for new tables |
| Modifying an existing migration | Migration won't re-run (already applied) | Create a NEW migration file |
| Using `FLOAT` for money | Rounding errors in financial calculations | Always use `BIGINT` for cents |
| Forgetting to update types | TypeScript compile errors or missing data | Always update `src/types/index.ts` |
| Not making migration idempotent | Fails on re-run | Use `IF NOT EXISTS`, `DROP ... IF EXISTS` |
| Using bare `auth.uid()` in RLS | Performance issue (evaluates per-row) | Use `(select auth.uid())` (evaluates once) |
| Forgetting indexes on FK columns | Slow queries on large tables | Add index on every `_id` column |
| **Rewriting CHECK without reading existing** | Removes values other functions rely on — causes runtime crashes | Query existing values first, add yours to the list |
| **Creating function overloads** | PostgREST calls the wrong version — your fix never runs | Check pg_proc for existing overloads before CREATE OR REPLACE |
| **SECURITY DEFINER without search_path** | Function fails when called from trigger context | Always add `SET search_path = public, pg_temp` |
| **DROP FUNCTION without replacement** | Deletes the only working version — RPC calls fail with "function not found" | Verify replacement exists BEFORE dropping |

---

## Step 2b: CHECK Constraint & Function Safety (CRITICAL)

> These rules were added after 40+ bugs were caused by migration drift in March 2026.

### If your migration touches a CHECK constraint:
1. **BEFORE writing SQL**, query the existing constraint values
2. Your new CHECK MUST include ALL existing values plus any new ones
3. Never assume you know all the values — other migrations may have added values you don't know about

### If your migration creates or modifies a function:
1. Check if overloads exist: query `pg_proc` for the function name — should return exactly 1 row
2. If overloads exist (>1 row), you must DROP all overloads and recreate a single version
3. Every `SECURITY DEFINER` function must include `SET search_path = public, pg_temp`
4. Every mutating RPC should accept `p_idempotency_key text DEFAULT NULL`

### If your migration rewrites a trigger function:
1. Search ALL migrations for previous versions of the trigger function
2. Read the LATEST version to understand what logic exists
3. Your rewrite must preserve all critical logic from previous versions

---

## Quick Reference: Adding a Column

The most common database change. Here's the minimal checklist:

1. Create migration file: `supabase/migrations/YYYYMMDDHHMMSS_add_column_name.sql`
2. SQL: `ALTER TABLE public.table_name ADD COLUMN IF NOT EXISTS column_name TYPE DEFAULT value;`
3. Apply through `/migration-review` → `apply_migration` (see Step 3 above — never the Dashboard SQL Editor)
4. Update interface in `src/types/index.ts`
5. Update components that use this table
6. Run `npm run typecheck` and `npm run build`

---

## Adding an Index on a Large Table (`CREATE INDEX CONCURRENTLY`)

> Use this pattern when adding an index to a table that has live writes you don't want to block.
> The canonical example is `supabase/migrations/20260511070000_perf_fk_indexes.sql` (perf sweep #3).

### Why CONCURRENTLY exists

`CREATE INDEX` takes an `ACCESS EXCLUSIVE` lock on the table for the entire build — every read AND write is blocked until the index finishes. On a multi-million-row table that can mean minutes of downtime.
`CREATE INDEX CONCURRENTLY` builds the index in two passes without blocking writes. The cost: it takes ~2× longer overall and **cannot run inside a transaction block** (Postgres rejects it).

### The deployment trap

Every "transactional" migration runner — including `apply_migration` on the Supabase MCP — wraps each file in `BEGIN; ... COMMIT;`. Inside that wrapper, `CREATE INDEX CONCURRENTLY` fails with:
```
ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

For this project there are three valid application paths, listed in order of preference:

**There is currently NO autonomous live path for a CONCURRENTLY migration — it parks for Mason.**
Every route is hard-blocked by design (verified 2026-07-16, Codex review):

| Path | Why it does not work |
|------|----------------------|
| `apply_migration` MCP | Wraps the file in a transaction — CONCURRENTLY fails immediately. |
| Supabase MCP `execute_sql` | `live-testdata-guard` denies raw DDL outside a `BEGIN;...ROLLBACK;` smoke test ("schema changes must travel the migration gauntlet") — and CONCURRENTLY cannot run inside a transaction, so the smoke-test escape does not apply either. Historical note: perf sweep #3 (2026-05-11) used this path BEFORE the guard existed; that workflow is closed now. |
| `supabase db push` / `supabase migration up` (any spelling) | Blocked by the bash-safety hook — they apply ALL pending local migrations at once, bypassing the review gate. |
| Direct `psql -f file.sql` | Local dev only. NEVER against production. |

What to actually do: (1) for small or low-write tables, use plain `CREATE INDEX IF NOT EXISTS`
(no CONCURRENTLY) in an ordinary migration through the normal Step 3 gate — this covers almost
every case; (2) for a genuinely hot, large table, write the CONCURRENTLY migration, run
`/migration-review` on it, then PARK it and ask Mason — applying it is one of the few remaining
owner actions (he runs it himself, or a future wave extends the guard with a proof-gated
CONCURRENTLY path). Do NOT look for a way around the guards — that is the incident class this
document exists to prevent.

### File template

```sql
-- Migration: <description>
-- Source: Supabase performance advisor / specific reason
-- Goal: <one-line explanation>
--
-- supabase-no-transaction
--
-- DEPLOYMENT NOTE: Contains CREATE INDEX CONCURRENTLY. NO autonomous live
-- path exists for this file (apply_migration fails on the transaction wrap;
-- execute_sql DDL is guard-blocked; CLI applies are guard-blocked). After
-- /migration-review passes, PARK it for Mason — see the CONCURRENTLY section
-- of DATABASE_CHANGE_CHECKLIST.md.
--
-- IF NOT EXISTS makes the file replay-safe — re-running is a no-op.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_<table>_<column>
  ON public.<table> (<column>);

-- ... repeat for each index ...

-- Verification: run separately as a regular SELECT (not part of this file)
-- SELECT count(*) FROM pg_indexes
-- WHERE schemaname='public' AND indexname IN ('idx_...', 'idx_...');
```

### Quick checklist

1. **Need this only on tables with significant size or write traffic.** Empty / low-traffic tables: plain `CREATE INDEX IF NOT EXISTS` is fine and runs inside a transaction.
2. **Put the `-- supabase-no-transaction` marker on its own line near the top.** Supabase CLI looks for the literal substring.
3. **Always pair with `IF NOT EXISTS`** so the migration is replay-safe (CONCURRENTLY can leave invalid indexes behind on failure; `IF NOT EXISTS` won't re-attempt a name that already exists, so check `pg_indexes WHERE indisvalid = false` after a failed run and DROP any invalid index manually before retry).
4. **Verification block goes in a separate execution**, not inside the file. CONCURRENTLY can't run alongside other statements in one transaction, and a verification SELECT inside the file would force one.
5. **Run `/migration-review`, then PARK the file for Mason** — there is no autonomous live path for CONCURRENTLY files (see the table above: apply_migration fails on the transaction wrap, execute_sql DDL and CLI applies are hard-blocked by the guards). Prefer plain `CREATE INDEX IF NOT EXISTS` through the normal gate whenever the table is small or low-traffic.
6. **After apply, query `pg_indexes`** to confirm all expected `idx_*` names exist and `indisvalid = true`.

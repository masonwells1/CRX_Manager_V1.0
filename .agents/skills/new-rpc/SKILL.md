---
name: new-rpc
description: Create a new Supabase RPC function with correct idempotency, SECURITY DEFINER, search_path, and documentation. Use when the user wants to add a new database function or stored procedure.
---

# Create New RPC Function

Create a properly structured Supabase RPC (stored procedure) with all the safety patterns CRX Manager requires.

## Step 1: Gather Requirements

Ask the user (skip if already described):
- **Function name** — What should it be called? (e.g., `create_tote`, `update_delivery_status`)
- **Purpose** — What does it do in one sentence?
- **Parameters** — What inputs does it need?
- **Returns** — What should it return? (uuid, json, void, table?)
- **Mutates data?** — Does it INSERT, UPDATE, or DELETE?

## Step 2: Pre-Flight Checks (CRITICAL)

Before writing ANY SQL, run these checks:

### Check for existing function with same name
```sql
SELECT proname, pg_get_function_identity_arguments(oid)
FROM pg_proc
WHERE proname = 'function_name_here';
```
If results come back, there's already a function with this name. Either pick a different name or confirm we're replacing it (and that the parameter signature matches).

### Check for overloads
```sql
SELECT proname, count(*)
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = 'function_name_here'
GROUP BY proname
HAVING count(*) > 1;
```
Must return ZERO rows. If it returns anything, we have dangerous overloads to clean up first.

### If the function reads/writes a table, verify the table's columns
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'table_name_here'
ORDER BY ordinal_position;
```
Never assume column names from memory — always verify.

## Step 3: Generate the Migration

Get timestamp and create the file:

```bash
date -u +"%Y%m%d%H%M%S"
```

File: `supabase/migrations/<timestamp>_create_<function_name>.sql`

### SQL Template (for mutating functions)

```sql
-- Create <function_name>: <one-line description>
CREATE OR REPLACE FUNCTION public.<function_name>(
  p_param1 uuid,
  p_param2 text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_existing jsonb;
BEGIN
  -- Idempotency check — the lookup MUST be scoped to THIS function's operation
  -- name. An unscoped key-only lookup returns ANY operation's cached row on a
  -- key collision (the restore_quote_version bug class; 22 live RPCs had to be
  -- swept). idempotency-body-check.mjs hard-denies the unscoped shape.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = '<function_name>';  -- ALWAYS scope to this function's name
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'id')::uuid;
    END IF;
  END IF;

  -- === Main logic here ===

  INSERT INTO some_table (col1, col2)
  VALUES (p_param1, p_param2)
  RETURNING id INTO v_id;

  -- === End main logic ===

  -- Record idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, '<function_name>', jsonb_build_object('id', v_id));
  END IF;

  RETURN v_id;
END;
$$;

-- Deliberate grants — REQUIRED on every SECURITY DEFINER function. Without
-- these, anon/PUBLIC can execute it (incident classes B7-B9). Note: REVOKE
-- FROM PUBLIC alone does NOT de-anon — revoke anon explicitly.
REVOKE ALL ON FUNCTION public.<function_name>(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.<function_name>(uuid, text, text) TO authenticated;
```

### SQL Template (for read-only functions)

```sql
-- <function_name>: <one-line description>
CREATE OR REPLACE FUNCTION public.<function_name>(
  p_param1 uuid
)
RETURNS TABLE (col1 uuid, col2 text, col3 numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT t.col1, t.col2, t.col3
  FROM some_table t
  WHERE t.id = p_param1;
END;
$$;

-- Deliberate grants — required on read-only SECURITY DEFINER functions too
REVOKE ALL ON FUNCTION public.<function_name>(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.<function_name>(uuid) TO authenticated;
```

### CRITICAL Patterns (DO NOT deviate)

- `SECURITY DEFINER` + `SET search_path = public, pg_temp` — ALWAYS together
- `p_idempotency_key text DEFAULT NULL` — REQUIRED on all mutating functions
- idempotency lookup MUST include `AND operation = '<function_name>'` — an unscoped lookup is hard-denied by the idempotency hook
- idempotency_keys columns: `idempotency_key`, `operation`, `result` — NEVER `key`, `entity_type`, `entity_id`
- `result` column is `jsonb` — NEVER cast to `::text`
- Deliberate grants on EVERY function: `REVOKE ALL ... FROM PUBLIC, anon;` + `GRANT EXECUTE ... TO authenticated;` — REVOKE FROM PUBLIC alone does NOT de-anon
- Money values: use `bigint` for cents, NEVER `numeric` or `float` for money storage

## Step 4: Update TypeScript Types

If the function returns a new shape, add or update the interface in `src/types/index.ts`.

## Step 5: Update Documentation

### rpc-functions.md
Read `docs/reference/rpc-functions.md` and add:

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| function_name | p_param1 uuid, p_param2 text, p_idempotency_key text | uuid | One-line description |

### migration-history.md
Add new row to `docs/reference/migration-history.md`.

(Do NOT add function/migration counts to `CLAUDE.md` or `AGENTS.md` — volatile counts
live only in `docs/reference/` files that `npm run check:docs` validates.)

## Step 6: Verify

```bash
npm run typecheck && npm run build
```

## Step 7: Print Summary

```
=== RPC Function Created ===

Function:  public.<function_name>
Migration: supabase/migrations/<filename>.sql
Mutating:  YES/NO
Idempotent: YES/NO

Pre-flight checks:
  - No existing function: PASS
  - No overloads: PASS
  - Column names verified: PASS

Docs updated:
  - docs/reference/rpc-functions.md
  - docs/reference/migration-history.md

Build: PASS
Typecheck: PASS

⚠️  Remember: This migration is LOCAL only. Applying it to the live database goes
    through `/migration-review` → Supabase MCP `apply_migration` (interactive
    session: Mason's in-chat OK; pre-authorized armed hands-free run: full proof +
    Codex gate per the settled 2026-07-13 policy). NEVER `supabase db push` and
    NEVER the dashboard SQL editor — both bypass the review gate and are blocked.
```

## Safety Rules

- NEVER skip the pre-flight checks — overloads caused multiple production bugs
- NEVER use `key`, `entity_type`, `entity_id`, or `result_id` for idempotency_keys columns
- NEVER cast idempotency result to `::text` — it's jsonb
- NEVER skip `SET search_path = public, pg_temp` on SECURITY DEFINER functions
- NEVER create a function without checking for overloads first

---
name: create-migration
description: Create a new Supabase migration with proper naming, SQL generation, TypeScript type updates, and documentation updates. Use when the user wants to add or change database tables, columns, RLS policies, indexes, or RPC functions.
---

# Create Migration

Generate a new Supabase migration file, update TypeScript types, and keep docs in sync — all from a plain-English description.

## Step 1: Understand What's Needed

Ask the user to describe the database change in plain English. Clarify:
- What tables/columns/functions are being added or changed?
- Are there RLS policies needed?
- Are there indexes needed for performance?

If the user already described the change before invoking this skill, skip the question and proceed.

## Step 2: Generate the Migration File

1. Get the current timestamp for the filename:

```bash
date -u +"%Y%m%d%H%M%S"
```

2. Create the file at `supabase/migrations/<timestamp>_<short_snake_case_description>.sql`
   - Keep the description part under 50 characters
   - Use snake_case (e.g., `add_tote_tracking`, `create_invoice_table`)

3. Write the SQL with these conventions (match existing migrations):
   - Always include a comment header explaining the purpose
   - Use `public` schema explicitly
   - Use `IF NOT EXISTS` / `IF EXISTS` to make a migration safely re-runnable — but **not
     reflexively**. A blanket guard silently swallows schema drift: if an object already exists
     in a shape you did not expect, `IF NOT EXISTS` leaves the wrong object in place and records
     the migration as successful. Before adding a guard, check the live catalog read-only
     (Supabase MCP) for that object. If it already exists, resolve the drift deliberately instead
     of guarding past it.
   - For new tables: include `id uuid DEFAULT gen_random_uuid() PRIMARY KEY`,
     `created_at timestamptz DEFAULT now()`, `updated_at timestamptz DEFAULT now()`
   - For new tables: **always add the `updated_at` trigger in the same migration** —
     `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` lists omitting it as a known repeat mistake,
     and the column alone never updates itself. Use the house trigger function (not the
     `moddatetime` extension — it is not the project pattern):

     ```sql
     CREATE TRIGGER set_updated_at
       BEFORE UPDATE ON public.my_new_table
       FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
     ```

   - For new tables: always add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **and** real policies
     in the same migration. `USING (true)` is a placeholder, not a policy — role-gate it.
   - For new columns: use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   - For new functions: `CREATE OR REPLACE FUNCTION` is the statement form, **not** the security
     contract. Any function this migration creates must also satisfy the CRX Hard Rules in
     `AGENTS.md`:
     - `SECURITY DEFINER` functions set `SET search_path = public, pg_temp` and get **deliberate,
       narrow** grants — `REVOKE EXECUTE FROM PUBLIC, anon`, then `GRANT` only to the roles that
       genuinely need it. (An empty search path is allowed only as the narrow 2026-07-30 exception
       in `docs/manual/DECISION_LOG.md`: a deliberately fully schema-qualified body with
       migration-review proof.)
     - A plain read-only function should normally stay **`SECURITY INVOKER`** so RLS still applies.
       Use `SECURITY DEFINER` only when owner privileges are actually required, and say why in
       the header comment.
     - Mutating RPCs accept and **actually enforce** `p_idempotency_key text DEFAULT NULL`, with
       the lookup scoped to `operation`, not the key alone.
     - Mutating RPCs validate the actor against `auth.uid()` and check role/active-profile; never
       trust a caller-supplied `p_performed_by` without an `ACTOR_MISMATCH` gate.
     - New money storage is `bigint` cents — never float. Existing PostgreSQL numeric-dollar
       storage may remain temporarily to avoid a risky unit rewrite, but it is not an approved or
       suppressible exception until exact `numeric` math is verified, existing values are finite
       whole cents, and an active finite whole-cent CHECK is present. Dirty or unconstrained columns
       remain tracked findings; do not retype, widen, or rewrite their values without owner approval.

   If the change involves an RPC of any complexity, use `/new-rpc` instead: it carries the full
   RPC contract and this skill's template is deliberately minimal.

## Step 3: Update TypeScript Types

Read `src/types/index.ts` and update it to match the schema change:
- New table → add a new `export interface`
- New column → add the field to the existing interface
- Changed column type → update the field type
- New enum/type → add a new `export type`

Follow existing conventions in the file (look at how other interfaces are structured).

## Step 4: Verify

TypeScript typecheck proves the app compiles. It proves **nothing** about the SQL — a migration
can typecheck perfectly and still be invalid, unsafe, or drifted. Run all of these:

```bash
npm run typecheck
bash scripts/validate-sql-migrations.sh
npm run test:drift
```

If there are type errors caused by the new/changed types, fix them:
- Check components that use the affected interface
- Update any destructuring or property access that changed
- Do NOT fix pre-existing type errors unrelated to this migration

For anything touching RLS, `SECURITY DEFINER`, money, or an existing table, the real proof gate
is `/migration-review` (security + drift reviewer subagents, plus a Codex verdict for SQL/RLS/
money) and a rolled-back smoke run (`node scripts/smoke/run-smoke.mjs --spec <rpc>` →
`SMOKE_PASS_ROLLBACK`). Those run before any live apply — do not report the migration as proven
on a typecheck alone.

## Step 5: Update Documentation

### migration-history.md
Read `docs/reference/migration-history.md` and add a new row to the table with:
- Timestamp (from filename)
- Filename
- One-line description of what it does

### database-schema.md (if tables or columns changed)
Read `docs/reference/database-schema.md` and:
- New table → add it under the correct domain section with all columns listed
- New column → add it to the existing table listing
- Changed column → update the listing

### rpc-functions.md (if functions were created)
Read `docs/reference/rpc-functions.md` and add the new function with:
- Function name
- Parameters
- Return type
- One-line description

## Step 6: Print Summary

After everything is done, print:

```
=== Migration Created ===

File: supabase/migrations/<filename>.sql
Type updates: src/types/index.ts
Typecheck:    PASS / FAIL (with details)
SQL validate: PASS / FAIL
Drift test:   PASS / FAIL

Docs updated:
  - docs/reference/migration-history.md
  - docs/reference/database-schema.md  (if applicable)
  - docs/reference/rpc-functions.md    (if applicable)

⚠️  Remember: This migration is LOCAL only.
    Applying it to the live database goes through /migration-review →
    Supabase MCP apply_migration (interactive session: Mason's in-chat OK;
    pre-authorized armed hands-free run: full proof + Codex gate, settled
    2026-07-13). NEVER `supabase db push` and NEVER the dashboard SQL
    editor — both bypass the review gate and are blocked.
    After a live apply that changes tables, columns, constraints, or
    status values, refresh the schema registry (/regen-schema-registry).
```

## Important Safety Rules

- NEVER modify an existing migration file — only create new ones
- NEVER apply the migration automatically from this skill — this skill only writes the file. Applying goes through `/migration-review` + migration-apply-guard: interactive session = Mason's in-chat OK; pre-authorized armed hands-free run = full proof + Codex gate (settled 2026-07-13); destructive = never autonomous
- NEVER commit automatically — the user decides when to commit
- NEVER report a migration verified on `npm run typecheck` alone — typecheck does not read SQL
- NEVER create a new table without RLS, real policies, and the `updated_at` trigger in the same file
- NEVER make a read-only function `SECURITY DEFINER` by default; that silently bypasses RLS
- If the SQL could be destructive (DROP TABLE, DROP COLUMN), warn the user clearly before writing the file

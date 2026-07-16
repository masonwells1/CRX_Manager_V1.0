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
   - Always use `IF NOT EXISTS` / `IF EXISTS` for safety
   - Always include a comment header explaining the purpose
   - Use `public` schema explicitly
   - For new tables: include `id uuid DEFAULT gen_random_uuid() PRIMARY KEY`, `created_at timestamptz DEFAULT now()`, `updated_at timestamptz DEFAULT now()`
   - For new tables: always add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and at least a basic RLS policy
   - For new columns: use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   - For new functions: use `CREATE OR REPLACE FUNCTION`

## Step 3: Update TypeScript Types

Read `src/types/index.ts` and update it to match the schema change:
- New table → add a new `export interface`
- New column → add the field to the existing interface
- Changed column type → update the field type
- New enum/type → add a new `export type`

Follow existing conventions in the file (look at how other interfaces are structured).

## Step 4: Run Type Check

```bash
npm run typecheck
```

If there are type errors caused by the new/changed types, fix them:
- Check components that use the affected interface
- Update any destructuring or property access that changed
- Do NOT fix pre-existing type errors unrelated to this migration

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
Typecheck: PASS / FAIL (with details)

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
```

## Important Safety Rules

- NEVER modify an existing migration file — only create new ones
- NEVER apply the migration automatically from this skill — this skill only writes the file. Applying goes through `/migration-review` + migration-apply-guard: interactive session = Mason's in-chat OK; pre-authorized armed hands-free run = full proof + Codex gate (settled 2026-07-13); destructive = never autonomous
- NEVER commit automatically — the user decides when to commit
- If the SQL could be destructive (DROP TABLE, DROP COLUMN), warn the user clearly before writing the file

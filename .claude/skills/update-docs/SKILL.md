---
name: update-docs
description: Audit all project documentation for drift from the actual codebase. Checks counts in CLAUDE.md, missing entries in reference docs, and fixes any stale data.
---

# Documentation Audit & Update

Audit the CRX_Manager_V1.0 documentation for drift against the actual codebase. Follow each step, compare actual counts to documented counts, and fix any mismatches.

## Step 1: Gather Actual Counts

Run these commands and record each result:

```bash
# Page count (lazy-loaded pages in App.tsx)
grep -c "lazy(" src/App.tsx

# Migration count (SQL files in migrations folder)
ls supabase/migrations/*.sql | wc -l

# Edge Function count (directories in functions folder)
ls -d supabase/functions/*/ | wc -l

# Unit test file count
find src -name "*.test.ts" -o -name "*.test.tsx" | wc -l

# E2E test file count
find e2e -name "*.test.ts" 2>/dev/null | wc -l
```

## Step 2: Check CLAUDE.md Counts

Read `CLAUDE.md` and find the "Current State" line (near the top). It shows counts like:
```
- 49 pages, 72+ tables, ~110 RPCs, 77+ migrations
- 1,122 unit tests + 424 E2E tests (370 passing, 42 pre-existing failures)
```

Compare each number against your Step 1 results:
- **Page count** should match the `grep lazy` result
- **Migration count** should match (use `XX+` format if approximate)
- **Edge Function count** should match what's in the Edge Functions section (~line 144)

Also update the date on the "Current State" line to today's date.

If any count is wrong, edit CLAUDE.md to fix it.

## Step 3: Check migration-history.md

Read `docs/reference/migration-history.md`. Then list all actual migration files:

```bash
ls supabase/migrations/
```

Compare the lists. If any migration file exists on disk but is NOT in the migration history table, add a new row. Use the filename to figure out the timestamp and description (the part after the timestamp in the filename).

Update the "77+ migrations" count in the title if it changed.

## Step 4: Check pages-routes.md

Read `docs/reference/pages-routes.md`. Then extract all lazy-loaded pages from App.tsx:

```bash
grep "lazy(" src/App.tsx
```

Also check the Route definitions to find paths:

```bash
grep -E "path=" src/App.tsx
```

If any page exists in App.tsx but is NOT in pages-routes.md, add it with its route path and a short description. Update the page count in the title if it changed.

## Step 5: Check database-schema.md

Read `docs/reference/database-schema.md` (the table listings).

Since we can't query the live database locally, check for NEW tables by scanning recent migrations:

```bash
grep -l "CREATE TABLE" supabase/migrations/*.sql | tail -5
```

For each recent migration that creates a table, verify that table appears in database-schema.md. If not, add it under the correct domain section. Also check for new RLS policies in those migrations.

## Step 6: Check rpc-functions.md

Read `docs/reference/rpc-functions.md`.

Check for NEW functions in recent migrations:

```bash
grep -l "CREATE.*FUNCTION" supabase/migrations/*.sql | tail -5
```

For each recent migration that creates a function, verify it appears in rpc-functions.md. If not, add it under the correct category.

## Step 7: Cross-Check Other Docs

If any counts changed, also check:
- `README.md` — does it mention page/table/RPC counts? Update if so.
- `TESTING.md` — does it mention test counts? Update if so.
- `DEPLOYMENT.md` — does it list Edge Functions? Update if a new one was added.

## Step 8: Print Summary

After all checks, print a summary table:

```
=== Documentation Audit Results ===

| Item               | Documented | Actual | Status  |
|--------------------|-----------|--------|---------|
| Pages              | XX        | XX     | OK / UPDATED |
| Migrations         | XX        | XX     | OK / UPDATED |
| Edge Functions     | XX        | XX     | OK / UPDATED |
| Test files         | XX        | XX     | OK / UPDATED |
| migration-history  | —         | —      | OK / X entries added |
| pages-routes       | —         | —      | OK / X entries added |
| database-schema    | —         | —      | OK / X tables added |
| rpc-functions      | —         | —      | OK / X functions added |

Files modified: [list files that were changed, or "None — all docs are current"]
```

If you made any changes, remind the user to include the doc updates in their next commit.

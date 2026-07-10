---
name: explain-migration
description: Translate a Supabase migration file into plain English for Mason (zero coding experience). Explains what the SQL changes, what tables/policies/functions it touches, what could go wrong, and what the rollback would look like. Use BEFORE approving any `apply_migration` MCP call so Mason understands what's about to happen to the live database.
---

# Explain Migration

You are explaining SQL to someone who does not read code. Be plain, be concrete, and tie every change back to real business consequences.

## Step 1: Identify the Migration

Ask Mason which migration to explain. Accept:

- A full path: `supabase/migrations/20260527120000_foo.sql`
- A filename: `20260527120000_foo.sql`
- "the one I just wrote" / "the latest" → use `Glob` for `supabase/migrations/*.sql` sorted by modification time, take the newest
- A description: "the one that adds the field grouping" → grep migration files for matching content

Read the file with `Read`.

## Step 2: Classify Every Statement

Go through the migration top to bottom and bucket each statement:

| SQL pattern | Plain-English category |
|-------------|------------------------|
| `CREATE TABLE` | "Adds a new table called X — a new place to store data" |
| `ALTER TABLE ... ADD COLUMN` | "Adds a new field to table X" |
| `ALTER TABLE ... DROP COLUMN` | "Removes field X from table Y — any data in that field is gone" |
| `ALTER TABLE ... ADD CONSTRAINT ... CHECK` | "Adds a rule: the value in field X must be one of these options: [list]" |
| `CREATE OR REPLACE FUNCTION` | "Adds or updates a database function (RPC) called X" |
| `DROP FUNCTION` | "Removes a function — any code that still calls it will break" |
| `GRANT ... TO ...` | "Gives role X permission to call function Y" |
| `REVOKE ... FROM ...` | "Takes away role X's permission to call Y — usually a security fix" |
| `ENABLE ROW LEVEL SECURITY` | "Turns on row-level security on table X — by default, no one can read it" |
| `CREATE POLICY` | "Says who can do what on table X: 'admin can SELECT', 'sales_rep can INSERT', etc." |
| `CREATE INDEX` | "Speeds up queries that filter on field X — no behavior change, just faster" |
| `INSERT INTO ... ON CONFLICT` | "Adds seed data — usually default rows the app needs" |

## Step 3: Identify the Business Impact

For each change, answer:
- **What user-facing thing might change?** (e.g., "A new tab appears in Settings", "Quotes now show a tier-4 option", "Nothing visible — backend only")
- **What could go wrong?** (e.g., "If the new column is NOT NULL without a default, existing rows will error", "The new function bypasses RLS — needs anon REVOKE", "This DROP COLUMN can't be undone without a backup")
- **What's the rollback?** (e.g., "Write a new migration that re-adds the column", "Can't roll back — backup restore would be needed")

## Step 4: Spot the Safety Concerns

Cross-reference against CLAUDE.md's "Hard Red Lines" and "Migration Safety Rules". Flag explicitly if you see:

- ⚠️ **SECURITY DEFINER without `SET search_path`** — search_path attack risk
- ⚠️ **SECDEF function that does DML, not paired with `REVOKE EXECUTE FROM anon`** — RLS bypass risk (B7/B8/B9 class)
- ⚠️ **CHECK constraint that drops existing enum values** — will break existing rows (March 2026 incident class)
- ⚠️ **New mutating RPC without `p_idempotency_key`** — double-submit risk
- ⚠️ **New table without RLS enabled + at least one policy** — anyone can read everything
- ⚠️ **UPDATE on a GENERATED column** (check `.claude/schema-registry.json` `generated_columns`) — will error
- ⚠️ **UPDATE on a table that lacks `updated_at`** (check registry `tables_without_updated_at`) — will error
- ⚠️ **References to `idempotency_keys.key`** etc. (wrong column names — should be `idempotency_key`)
- ⚠️ **`pg_get_functiondef`** — bakes in existing bugs

## Step 5: Write the Explanation

Use this template. Be honest about what you don't know — if the migration's intent isn't clear from the SQL alone, ask Mason what business problem prompted it before guessing.

```
═══════════════════════════════════════════════════
  MIGRATION EXPLANATION
═══════════════════════════════════════════════════

File:     supabase/migrations/<filename>
Lines:    <N>
Touches:  <tables/functions list>

WHAT IT DOES (plain English)
────────────────────────────
<2-3 short paragraphs, no SQL, no jargon. Walk through the file like
you're describing what's changing in the database in normal English.>

WHAT YOU'LL SEE IN THE APP
──────────────────────────
<Concrete user-facing changes, or "Nothing visible — this is plumbing">

WHAT COULD GO WRONG
───────────────────
<List concrete failure modes. "If the new policy has a typo, admins can't see X." Not abstract risks.>

SAFETY CHECK
────────────
<Either: "Looks clean — no patterns from the 'Migration Safety Rules' triggered."
 Or: List each ⚠️ flag with the specific line number, what's wrong, and the fix.>

ROLLBACK
────────
<How would we undo this if it goes wrong on live?
 Examples: "Write a new migration that DROPs the new column" / "Restore from
 Supabase backup — there's no migration-level rollback" / "Re-grant the
 EXECUTE permission we revoked".>

RECOMMENDED NEXT STEPS
──────────────────────
<Pick one:
 - "Safe to apply via Supabase MCP — say 'apply it' to proceed."
 - "BEFORE applying: run /codex-cross-review on this migration." (if uncertain)
 - "DO NOT apply yet. Fix these issues first: <list>"
 - "Dispatch the rls-security-reviewer + migration-drift-reviewer subagents first
    so we don't repeat the B7/B8/B9 class of bug.">
```

## Step 6: Wait for Mason's Decision

Do NOT auto-apply. Do NOT auto-commit. Mason reads the explanation, asks follow-up questions, and decides what to do.

If Mason asks "should I apply this?", give an honest answer based on the safety check, NOT a default yes.

## Hard Rules

- NEVER skip a statement — if you don't recognize a SQL pattern, say so and ask before guessing.
- NEVER explain in jargon. If you must use a technical term, define it inline ("RLS policy — a rule about who can read/write rows").
- NEVER recommend "apply it" if a safety flag was raised. Recommend the fix first.
- NEVER fabricate user-facing impact — if the migration is plumbing only, say so plainly. Don't invent a feature story.
- If the migration was already applied (check via Supabase MCP `list_migrations` if available), say so clearly and explain that the explanation is retrospective, not pre-apply.

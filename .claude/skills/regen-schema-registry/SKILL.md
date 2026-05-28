---
name: regen-schema-registry
description: Regenerate `.claude/schema-registry.json` from the live Supabase database. The schema registry is the source of truth that powers 4 of the PreToolUse hooks (status-enum-check, generated-column-check, sql-safety, rls-on-new-tables) and the 2 review subagents. Use after applying any migration that creates a new status enum, generated column, or table — otherwise the hooks will be working from stale data and may miss the very class of bug they're supposed to catch.
---

# Regenerate Schema Registry

Wraps `scripts/regenerate-schema-registry.mjs` with the surrounding hygiene that the script alone doesn't do: verifying the regeneration succeeded, diffing against the previous version, and reminding Mason to commit.

## Step 1: Run the Script

```bash
node scripts/regenerate-schema-registry.mjs
```

If this fails:
- The script needs Supabase MCP or a SUPABASE_SERVICE_ROLE_KEY env var (read the script to determine which)
- If MCP failed, retry with the relevant `mcp__50e15046-cf2c-49da-b8df-ceef27768f63__list_tables` etc. and reconstruct the JSON manually as a fallback
- Report the error to Mason and STOP — don't proceed with stale data

## Step 2: Diff Against Previous Version

```bash
git diff .claude/schema-registry.json
```

Capture and summarize the changes:
- New status enums added
- New generated columns
- Tables added to / removed from `tables_without_updated_at`

If the diff is empty: the registry was already up to date. Tell Mason and skip to Step 5.

## Step 3: Sanity-Check the New Registry

Read the regenerated `.claude/schema-registry.json` and verify:
- `_meta.generated_at` matches today
- All 3 top-level keys present: `generated_columns`, `status_enums`, `tables_without_updated_at`
- `status_enums` is non-empty (the project has at least 20+ status enums; a near-empty result means the script silently failed)

If any of these look wrong, tell Mason and revert via `git checkout -- .claude/schema-registry.json`.

## Step 4: Confirm Hooks Will Pick Up New Data

The PreToolUse hooks read the registry on every invocation, so changes take effect immediately for the next file edit. No restart needed.

Optionally, smoke-test by piping a fake payload through each hook that reads the registry:

```bash
echo '{"tool_input":{"file_path":"test.sql","content":"INSERT INTO new_status_enum_table (status) VALUES (\\"nonexistent\\");"}}' | node .claude/hooks/status-enum-check.mjs
```

If the new enum was registered, this should now be checked.

## Step 5: Print Summary

```
═══════════════════════════════════════════════════
  SCHEMA REGISTRY REGENERATED — <YYYY-MM-DD>
═══════════════════════════════════════════════════

Status: SUCCESS / FAILED / NO CHANGES

Changes from previous version:
  Generated columns:    + <N added>, - <N removed>
  Status enums:         + <N added>, - <N removed>
  No-updated_at tables: + <N added>, - <N removed>

Details:
  <bulleted list of specific additions/removals>

Next step:
  Commit `.claude/schema-registry.json` (Mason commits — Claude never auto-commits)

⚠️  If the hook behavior should change now (e.g., a new generated column means
    an existing UPDATE statement somewhere is about to fail), recommend running
    /audit before the next commit.
```

## Step 6: Wait

Do NOT auto-commit. Mason commits when he's ready.

If Mason asks "should this be committed?" — yes, always. The schema registry being out of sync with the live DB makes every hook + subagent less reliable.

## Hard Rules

- NEVER modify `.claude/schema-registry.json` by hand — only via the script. Manual edits drift.
- NEVER skip Step 2 (diff check) — Mason should see what changed before committing.
- NEVER auto-commit the registry change.
- If the script doesn't exist (`scripts/regenerate-schema-registry.mjs`), tell Mason and STOP. Don't attempt to fabricate the registry from scratch.

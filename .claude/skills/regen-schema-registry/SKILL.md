---
name: regen-schema-registry
description: Regenerate `.claude/schema-registry.json` from the live Supabase database. The schema registry is the source of truth that powers 4 of the PreToolUse hooks (status-enum-check, generated-column-check, sql-safety, rls-on-new-tables) and the 2 review subagents. Use after applying any migration that creates a new status enum, generated column, or table — otherwise the hooks will be working from stale data and may miss the very class of bug they're supposed to catch. The registry-freshness PostToolUse hook writes `.claude/session-state/REGISTRY-STALE.flag` after a live apply with registry-relevant DDL — this skill's live-introspection refresh is how that flag gets cleared.
---

# Regenerate Schema Registry

Wraps `scripts/regenerate-schema-registry.mjs` with the surrounding hygiene that the script alone doesn't do: verifying the regeneration succeeded, diffing against the previous version, clearing the REGISTRY-STALE flag, and reminding Mason to commit.

⚠️ **Honesty check — the script has TWO modes, and only one is a real refresh:**
- `node scripts/regenerate-schema-registry.mjs` (no args) is **"stamp" mode**: it only bumps `_meta.generated_at`. It does NOT touch any schema data, so it leaves the hooks exactly as stale as before. A stamp run is NOT a refresh.
- `node scripts/regenerate-schema-registry.mjs --from-introspection <file.json>` is the **REAL refresh**: it rebuilds the registry from live Supabase introspection results. This is the mode this skill runs.

## Step 1: Do a REAL Refresh (live introspection — not the stamp)

1. Run the 5 read-only queries documented in the header of `scripts/regenerate-schema-registry.mjs` (Q1 migrations_high_water, Q2 sequences, Q3 generated_columns, Q4 check_constraints, Q5 columns) via Supabase MCP `execute_sql` on project rhyzpcqhnizqbxphqdkr — one statement per call (the MCP drops all but the last statement in a multi-statement call).
2. Assemble the results into one JSON object (exact input format is in the script header) and save it to a temp file.
3. Run:

```bash
node scripts/regenerate-schema-registry.mjs --from-introspection <path-to-queries.json>
```

If this fails:
- Read the script's error output — it validates the input shape loudly
- If an MCP query failed, retry it (Q5 can be split by table-name range if the response is too large — see the script header)
- Report the error to Mason and STOP — don't proceed with stale data

## Step 2: Diff Against Previous Version

```bash
git diff .claude/schema-registry.json
```

Capture and summarize the changes:
- New status enums added
- New generated columns
- Tables added to / removed from `tables_without_updated_at`

If the diff is empty: the registry was already up to date. Tell Mason and skip to Step 5 (a genuine introspection run that changes nothing still counts for clearing the stale flag — see Step 5).

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

## Step 5: Clear the REGISTRY-STALE Flag (only after verification)

If `.claude/session-state/REGISTRY-STALE.flag` exists (written by the registry-freshness PostToolUse hook after a live apply), delete it **only after the refreshed registry is verified — content changed, not just timestamp**:

1. The refresh was the real `--from-introspection` mode (Step 1), NOT a no-args stamp run.
2. `_meta.generated_at` in the new registry is newer than the flag's `created` timestamp.
3. The file **content** actually changed vs before the refresh (Step 2's diff shows more than a `generated_at` bump). A timestamp-only diff means a stamp run happened — that does NOT clear the flag; go back to Step 1.
   - Exception: if a genuine `--from-introspection` run produced an EMPTY diff, the registry was already accurate — that also verifies freshness. Say so explicitly, then delete the flag.

Then delete the flag file and confirm it's gone. If sql-safety.mjs was blocking migration writes, it stops blocking as soon as the flag is deleted.

## Step 6: Print Summary

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

## Step 7: Wait

Do NOT auto-commit. Mason commits when he's ready.

If Mason asks "should this be committed?" — yes, always. The schema registry being out of sync with the live DB makes every hook + subagent less reliable.

## Hard Rules

- NEVER modify `.claude/schema-registry.json` by hand — only via the script. Manual edits drift.
- NEVER skip Step 2 (diff check) — Mason should see what changed before committing.
- NEVER auto-commit the registry change.
- If the script doesn't exist (`scripts/regenerate-schema-registry.mjs`), tell Mason and STOP. Don't attempt to fabricate the registry from scratch.

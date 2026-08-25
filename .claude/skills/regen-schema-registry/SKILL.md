---
name: regen-schema-registry
description: Regenerate `.claude/schema-registry.json` from the live Supabase database. The schema registry is the source of truth that powers 3 of the PreToolUse hooks (status-enum-check, generated-column-check, sql-safety), the session-staleness check, and the 3 schema-aware review subagents (migration-drift, rls-security, typescript-types-drift). Use after applying any migration that creates a new status enum, generated column, or table — otherwise the hooks will be working from stale data and may miss the very class of bug they're supposed to catch. The registry-freshness PostToolUse hook writes `.claude/session-state/REGISTRY-STALE.flag` after a live apply with registry-relevant DDL — this skill's live-introspection refresh is how that flag gets cleared.
---

# Regenerate Schema Registry

Wraps `scripts/regenerate-schema-registry.mjs` with the surrounding hygiene that the script alone doesn't do: verifying the regeneration succeeded, diffing against the previous version, clearing the REGISTRY-STALE flag, and reminding Mason to commit.

⚠️ **Honesty check — the script has TWO modes, and only one is a real refresh:**
- `node scripts/regenerate-schema-registry.mjs` (no args) is **"stamp" mode**: it only bumps `_meta.generated_at`. It does NOT touch any schema data, so it leaves the hooks exactly as stale as before. A stamp run is NOT a refresh.
- `node scripts/regenerate-schema-registry.mjs --from-introspection <file.json>` is the **REAL refresh**: it rebuilds the registry from live Supabase introspection results. This is the mode this skill runs.

## Step 1: Do a REAL Refresh (live introspection — not the stamp)

0. **FIRST, before running any query**, record the refresh start time — Step 5 uses it as the cutoff for clearing stale flags (a flag created after this moment belongs to a live apply this refresh may not capture):

```bash
node -e "const fs=require('node:fs');fs.mkdirSync('.claude/session-state',{recursive:true});fs.writeFileSync('.claude/session-state/registry-refresh-start.txt',new Date().toISOString())"
```

1. Run the 6 read-only queries documented in the header of `scripts/regenerate-schema-registry.mjs` (Q1 migrations_high_water, Q2 sequences, Q3 generated_columns, Q4 check_constraints, Q5 columns, Q6 applied_names) via Supabase MCP `execute_sql` on project rhyzpcqhnizqbxphqdkr — one statement per call (the MCP drops all but the last statement in a multi-statement call). Do NOT skip Q6 — it powers the name-based staleness comparison; without it the script only carries forward the previous (possibly behind) name list.
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

Capture and summarize the changes across all 8 sections:
- New/removed status enums, generated columns, and `tables_without_updated_at` entries
- Added/changed/removed entries in `check_constraints`, `skipped_constraints`, `not_null_columns`, `columns`, and `sequences`

If the diff is empty: the registry was already up to date. Tell Mason and skip to Step 5 (a genuine introspection run that changes nothing still counts for clearing the stale flag — see Step 5).

## Step 3: Sanity-Check the New Registry

Read the regenerated `.claude/schema-registry.json` and verify:
- `_meta.generated_at` matches today and `_meta.registry_version` is `2`
- All 8 top-level keys present: `generated_columns`, `status_enums`, `tables_without_updated_at`,
  `check_constraints`, `skipped_constraints`, `not_null_columns`, `columns`, `sequences`
- `status_enums` is non-empty, and its entry count is in the same ballpark as the registry you
  just replaced (compare against `git show HEAD:.claude/schema-registry.json`). A near-empty or
  sharply smaller result means the script silently failed — do not accept it as "the schema
  changed" without finding the migration that removed them.

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

Then clear the flag from **EVERY** location — since 2026-07-13 the flag is written to the main checkout's `.claude/session-state/` AND the applying worktree's, and any sibling worktree may hold its own copy; leaving any one behind keeps migration writes blocked there. Use the shared helper, which sweeps the main checkout + all worktrees and prints exactly what it deleted. The cutoff is the refresh START stamp recorded in Step 1.0 — a flag created after that moment belongs to a live apply your introspection snapshot may not include and must be left in place (go refresh again instead):

```bash
node -e "const{pathToFileURL}=require('node:url');const{readFileSync}=require('node:fs');const cutoff=readFileSync('.claude/session-state/registry-refresh-start.txt','utf8').trim();import(pathToFileURL(process.cwd()+'/.claude/hooks/registry-freshness-lib.mjs').href).then(m=>console.log(JSON.stringify(m.clearStaleFlag(process.cwd(),{cutoffIso:cutoff}))))"
```

The cutoff is the moment Step 1.0 stamped BEFORE the first introspection query — NOT the registry file's completion time. (An apply that lands mid-refresh, after a query ran but before the registry was written, would be OLDER than the registry's mtime, so a completion-time cutoff would wrongly delete its flag — Codex P1 2026-07-13 round 5.) If `registry-refresh-start.txt` is missing, you skipped Step 1.0 — do NOT substitute a newer timestamp; go back and redo the refresh from Step 1.0. (`pathToFileURL` is required — a raw `import("C:/...")` fails on Windows with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.) Confirm the printed `removed` list covers every location where the flag existed, and that `kept` is empty — a non-empty `kept` means an apply happened during/after your refresh: do not force-delete it, run the refresh again from Step 1.0. If sql-safety.mjs was blocking migration writes, it stops blocking as soon as all flags are gone.

## Step 6: Print Summary

```
═══════════════════════════════════════════════════
  SCHEMA REGISTRY REGENERATED — <YYYY-MM-DD>
═══════════════════════════════════════════════════

Status: SUCCESS / FAILED / NO CHANGES

Changes from previous version (all 8 sections):
  Generated columns:    + <N added>, - <N removed>
  Status enums:         + <N added>, - <N removed>
  No-updated_at tables: + <N added>, - <N removed>
  Check constraints:    + <N added>, ~ <N changed>, - <N removed>
  Skipped constraints:  + <N added>, - <N removed>
  NOT NULL columns:     + <N added>, - <N removed>
  Columns:              + <N added>, ~ <N changed>, - <N removed>
  Sequences:            + <N added>, - <N removed>

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

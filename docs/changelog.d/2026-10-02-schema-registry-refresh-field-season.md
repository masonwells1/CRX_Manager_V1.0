## 2026-10-02 — refresh the schema registry after the field-season applies

The session-staleness check reported `.claude/schema-registry.json` behind the migrations on disk.
Six `20260914…` migrations had been applied live since the 2026-09-26 refresh: `20260914100800` and
`20260914100900` (2026-09-27/28), and the four field-season files `20260914101000`..`20260914101300`
(2026-10-02 20:14–20:16 UTC, ledger versions `20261002201451`..`20261002201609`).

Rebuilt with the real `--from-introspection` mode from the six read-only queries (Q1–Q6) in
`scripts/regenerate-schema-registry.mjs`, run through the Supabase MCP on project
`rhyzpcqhnizqbxphqdkr` (refresh started 2026-10-02 20:20:52 UTC, after the last apply):

- `migrations_high_water` 20260926163005 → 20261002201609; the six applied names were added to
  `applied_migration_names` (1004 → 1010). None were dropped.
- No change to generated columns (11), status enums (38), parsed CHECK IN-lists (119), skipped
  constraints, NOT NULL columns, column lists (160 tables), tables without `updated_at` (94), or
  sequences (7).

Second refresh (started 2026-10-03 03:19:35 UTC, after merging `main` at `8bf73bf4a`): PR #800's
`20260921180000_soft_delete_customer_document_rpc` had applied live at ledger version
`20261002230949`, so it was added too (`applied_migration_names` 1010 → 1011, `migrations_high_water`
→ `20261002230949`). Again no change to any other section. `docs/manual/CURRENT_STATE.md`'s
"Schema registry" bullet now matches, and its ledger stamp and effective ordering high-water (plus the
ledger bullet at the top of `docs/reference/migration-history.md`) now read 1018 rows / 1011 names,
`max(version)` `20261002230949`, high-water `20260921180000` — from a live read-only count at
2026-10-03 03:19 UTC — instead of the pre-#800 `20260914101300`. The migration-history boundary
block is re-headed as the 03:19 capture, its "registry last regenerated 2026-09-26; refresh it"
sentence and its later boundary reference now name this refresh, and `docs/manual/KNOWN_ISSUES.md`
no longer says the registry stops at `100700`.

Moving the authored boundary to `20260914101300` made `src/lib/rpcContracts.test.ts` fail (3 tests):
the four field-season files no longer sort above the boundary, and `src/types/supabase.ts` has not
been regenerated since they applied, so their RPCs would have dropped out of the mutator inventory.
They are now registered in `MIGRATIONS_AWAITING_TYPE_REGENERATION`, the same bookkeeping #721/#722
used; clear them when the generated types are regenerated from production. The file passes (97/97)
both with `main`'s migration-history rows (LOCAL CANDIDATE — NOT APPLIED) and with PR #871's
(APPLIED LIVE).

Proof: a section-by-section comparison against the previous registry showed only the two `_meta`
changes above, and re-running `.claude/hooks/session-staleness.mjs` no longer reports the registry
as behind. No `REGISTRY-STALE.flag` existed in any worktree.

`docs/reference/migration-history.md` rows 931–934 already record `20260914101000`..`101300` as
APPLIED LIVE; PR #871 (merged as `27c450f0a`, now merged into this branch) made that change.

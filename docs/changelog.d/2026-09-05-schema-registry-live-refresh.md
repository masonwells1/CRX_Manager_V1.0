## 2026-09-05 — Schema registry refreshed from live introspection (five missing migrations)

`.claude/schema-registry.json` was stamped `2026-09-03` with `migrations_high_water 20260903153402`,
while **five** migrations had since applied live. Three PreToolUse hooks (`status-enum-check`,
`generated-column-check`, `sql-safety`), the session-staleness check, and three schema-aware review
subagents all read that file, so every one of them was reasoning from a schema that no longer
matched production. `npm run agent-health` failed on `main` as a result.

Regenerated through the sanctioned live path — `scripts/regenerate-schema-registry.mjs
--from-introspection` against project `rhyzpcqhnizqbxphqdkr` — not a stamp-only run.

## Applied migrations the registry was missing

| ledger version | migration name |
| --- | --- |
| 20260903202611 | `20260903150100_ledger_backed_commission_history` |
| 20260904023121 | `20260903160000_gate_number_generators_active_profile_role` |
| 20260904040643 | `20260903230000_commission_report_snapshot_contract` |
| 20260904130047 | `20260904160000_invoice_date_fallbacks_chicago` |
| 20260904152221 | `20260904180000_invoice_season_follows_invoice_date` |

`_meta.migrations_high_water` is now `20260904152221` and `applied_migration_names` covers all five
**by name** — the comparison the ordering and staleness guards actually make. A version-based check
would still be wrong here: `20260904180000_invoice_season_follows_invoice_date` carries ledger
version `20260904152221`, which sorts *below* its own filename timestamp.

## What changed in the registry

- **+3 tables** across `columns`, `not_null_columns` and `tables_without_updated_at`:
  `commission_earned_state_ledger`, `commission_history_cutover`, `commission_settlement_events`.
- **+3 parsed CHECK constraints**: `commission_earned_state_ledger.event_kind` / `.source_type`,
  `commission_settlement_events.event_kind`.
- **+13 skipped constraints** (0 removed, 0 modified), all on the commission surface.
- **~2 changed column lists**: `commissions`, `commission_payments`.
- `generated_columns`, `status_enums` and `sequences` are unchanged.

**Correction (Codex review of `a847cc1a`).** An earlier draft of this entry claimed all 208
pre-existing `skipped_constraints` were rewritten by an em-dash "encoding repair". That was wrong,
and the error was mine: the comparison script read `git show` output with
`subprocess.run(..., text=True)`, which decodes using the Windows locale codec (cp1252) rather than
UTF-8, so every correctly-encoded em-dash *appeared* as mojibake. Re-checked by decoding both sides
explicitly as UTF-8 and by scanning the raw bytes: both the old and new files contain proper UTF-8
em-dash bytes (`e2 80 94`) and neither contains mojibake. The real delta is
**+13 added / 0 removed / 0 modified**.

## Proof

Ran the hook that consumes the registry, against a value the new schema forbids:

```
node .claude/hooks/status-enum-check.mjs   # INSERT INTO commission_earned_state_ledger (event_kind) VALUES ('totally_bogus_value')
-> permissionDecision "deny": CHECK CONSTRAINT VIOLATION ... (allowed: 'baseline', 'legacy_excluded',
   'inserted', 'revised', 'cancelled', 'soft_deleted', 'restored')
```

The previous registry contained **zero** occurrences of `commission_earned_state_ledger.event_kind`,
so the hook could not have caught this before — it was silently passing any value on all three new
commission tables.

`npm run agent-health` is green (the prior `Session staleness` FAIL is gone). Typecheck, lint, 4,976
tests across 349 files, and the production build all pass.

## Two gaps this refresh exposes but does NOT close (Codex review of `a847cc1a`)

Both are pre-existing and neither is caused by this change. They are recorded here rather than
fixed, because fixing either inside a registry data refresh would mean editing a deterministic guard
or another lane's migrations.

1. **Three migrations are recorded as applied live but have no source SQL in this repo.**
   `20260903150100_ledger_backed_commission_history`, `20260903230000_commission_report_snapshot_contract`
   and `20260904180000_invoice_season_follows_invoice_date` are all in the live ledger; none has a
   file under `supabase/migrations/` on `main`. The last one exists only on an unmerged branch
   (`72fb19b10`). The repository therefore cannot reconstruct the recorded production schema, and no
   reviewer can check RLS, grants, `SECURITY DEFINER` safety, or idempotency for those changes from
   source. This is other lanes' unmerged work, not this PR's — but it is the reason the registry and
   the repo disagree, and it should be closed by merging those migration files.

2. **The migration-immutability guard still treats one applied migration as editable.**
   `classifyMigrationChanges()` (`scripts/check-migration-hard-rules.mjs:171`) compares a migration's
   **filename timestamp** against `_meta.migrations_high_water`, which is a **ledger version**. Those
   two number spaces are not comparable. `20260904160000_invoice_date_fallbacks_chicago` is applied
   (ledger version `20260904130047`) yet its filename `20260904160000` sorts above the high-water
   `20260904152221`, so an edit to that already-applied migration lands in `pendingChanges` and the
   guard does not fail it.

   This refresh **narrows** the hole rather than widening it — measured: 4 applied-but-editable
   migrations under the old high-water `20260903153402`, 2 under the new one. Closing it properly
   needs the guard to match on exact applied **names** (the registry already carries
   `applied_migration_names`), or a separate authored-name high-water. That is a guard change and
   belongs in its own reviewed PR.

## Two related items deliberately NOT done here

- **Pruning `_price_order_below_cost_impl_20260810` and `_save_invoice_lineage_unaware_impl_20260827`
  from `MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY` is still premature.** The standing note said to prune
  once the high-water passed `20260903170000`, which it now has. But both entries are gated on
  migration `20260904160000`, and `rpcContracts.test.ts` compares that **filename timestamp** against
  the high-water **version** `20260904152221` — `20260904160000 > 20260904152221`, so both are still
  discovered. Removing them was tried and fails `every generated direct or indirect mutating RPC is
  classified` with 2 unclassified entries. They can be pruned once a live apply pushes the ledger
  version past `20260904160000`.
- **`src/types/supabase.ts` was not regenerated.** The RPC contract suites pass against the refreshed
  registry as-is, so it is not required for this change to be correct. It remains the prerequisite
  for letting `rpcContracts.test.ts` stop force-registering six RPCs by hand, and is tracked
  separately.

## Also repaired (local git config, not a tracked file)

This worktree's `config.worktree` pinned `core.hooksPath` to `C:\CRX_Manager\.husky` — the **main
checkout's** hooks rather than its own. Commits here would have run another checkout's guards.
Cleared the per-worktree override so the correct repo-wide relative `.husky` applies. This is local
config in one worktree; no shared setting and no tracked file was touched.

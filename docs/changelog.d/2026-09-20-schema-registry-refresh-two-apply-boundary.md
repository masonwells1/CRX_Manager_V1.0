## 2026-09-20 — Refresh the schema registry and the ledger boundary after two live applies

`.claude/schema-registry.json` was two applies behind live. Four schema-aware hooks
(`status-enum-check`, `generated-column-check`, `sql-safety`, `session-staleness`) and three
review subagents read that file as their picture of the live schema, so every one of them was
judging new work against a stale applied-migration boundary.

### What changed

Regenerated the registry from live read-only introspection of project `rhyzpcqhnizqbxphqdkr`
(`node scripts/regenerate-schema-registry.mjs --from-introspection`, the real rebuild mode — not
the no-args stamp mode, which only bumps `generated_at`):

- `_meta.migrations_high_water`: `20260915033227` → `20260920052149`
- `_meta.applied_migration_names`: added `20260908140000_number_generators_year_chicago` and
  `20260911120000_bind_adjust_inventory_receipt_to_intent`
- `_meta.generated_at`: `2026-09-17` → `2026-09-20`

No schema-shape section moved: 11 generated columns, 38 status enums, 94 tables without
`updated_at`, 119 parsed CHECK IN-lists, 221 skipped constraints, 160 column entries and 7
sequences are all unchanged. The database's shape had not drifted — only the record of what had
been applied to it.

This change originally also rewrote the `THIS IS THE CURRENT BOUNDARY` block in
`docs/reference/migration-history.md`, which had drifted by the same two applies. PR #736 landed
that same correction first, with more detail (row numbers, apply order, and the downstream
consequences for the parked cohorts), so this branch dropped its own version and took #736's
wholesale. Nothing of this change's boundary edit survives in that file.

Worth recording: the two boundary reads were taken independently and agree exactly — 1004 ledger
rows / 997 distinct names, `max(version)` `20260920052149`, effective ordering high-water
`20260911120000_bind_adjust_inventory_receipt_to_intent`, with
`20260908140000_number_generators_year_chicago` applied earlier the same morning under
`20260920051333`. That agreement is a cross-check on the registry values below, which come from the
same read as the discarded block.

### Verification

- The refreshed registry was diffed before acceptance: four changed lines, all `_meta`. Content
  genuinely changed, so this was not a timestamp-only stamp run.
- `session-staleness.mjs` re-run now reports the new applied high-water rather than the old one,
  which is direct evidence a registry-reading hook picked up the refresh.
- `status-enum-check.mjs` was fed an invalid `invoices.status` value and **denied** it, quoting the
  allowed list out of the refreshed registry.
- Zero `REGISTRY-STALE.flag` files exist across all 135 worktrees, so the stale-flag sweep was a
  genuine no-op and nothing is blocking migration writes.

### Two things the refresh deliberately did not "fix"

- The five `20260914100*` commission migrations still raise the session-staleness banner. They are
  **written but not applied** — confirmed by name against the live ledger. The banner is correct.
- `997` distinct names against `1004` ledger rows is not a loss: seven migrations were applied twice
  under different versions, and the generator correctly counts unique names.

### Drift noted, not changed here

PR #726's title still calls `20260908140000_number_generators_year_chicago` `PARKED, not applied`.
The live ledger shows it applied on 2026-09-20 under version `20260920051333`, and the registry
refreshed here now lists it among the applied names. Nothing in this change edits that PR title —
trust the ledger read and the refreshed registry over it.

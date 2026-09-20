## 2026-09-17 - refresh the schema registry from live, protecting the two migrations applied since 2026-09-05

`.claude/schema-registry.json` was generated on 2026-09-05 and its newest applied filename stamp
was `20260904180000`. Two migrations have run on the live database since:

- `20260908120000_close_pr535_live_gaps` — applied 2026-09-08 (ledger version `20260909023300`)
- `20260908130000_bind_create_inventory_hold_receipt_to_intent` — applied 2026-09-15 (ledger version `20260915033227`)

`scripts/check-migration-hard-rules.mjs` bands migrations by that stamp: anything **above** it is
pending and may still be revised; anything at or below it already ran and is protected from edits,
renames and deletion. Both files above sat in the revisable band, so the CRX hard rule "never edit
an applied migration" was not being enforced for either of them. This refresh moves the boundary to
`20260908130000` and closes that.

This was the real `--from-introspection` rebuild against project `rhyzpcqhnizqbxphqdkr`, not a
no-argument `generated_at` stamp run. The distinction matters: a stamp run publishes a false
freshness claim while leaving the hooks reading the same stale data.

**Nothing but metadata moved.** All eight schema sections — `generated_columns`, `status_enums`,
`tables_without_updated_at`, `check_constraints`, `skipped_constraints`, `not_null_columns`,
`columns`, `sequences` — are byte-identical to `origin/main`. No table, enum value, generated column
or sequence was added or removed. The only changes are `_meta.generated_at` (`2026-09-05` →
`2026-09-17`), `_meta.migrations_high_water` (`20260904152221` → `20260915033227`), and four names
added to `_meta.applied_migration_names` (991 → 995, none removed): the two above plus
`20260906120000_preview_field_app_season_follows_invoice_date` and `refuse_null_job_field_acres`.

The live ledger holds 1,002 rows and 995 distinct names; the 7-row difference is repeated names, not
dropped ones.

### The registry is read from the MERGE-BASE, not from `--base`

`runDiffCheck` resolves `git merge-base <base> <head>` and reads the registry from **that** commit
(`scripts/check-migration-hard-rules.mjs:279-280`). The script header's phrase "the BASE tree's
registry" reads as the `--base` argument and is easy to get backwards.

The practical consequence is a trap worth naming, because it produces a convincing false negative:
swapping the refreshed registry into a synthetic `--base` commit and watching the check PASS looks
like a disproof of the refresh, and is not one. The boundary never moved, because a registry that
lands on `main` *after* a branch point is invisible to that branch. A real proof has to put the
refreshed registry in the merge-base itself. Both halves are now pinned as regression tests, so the
next person meets the distinction as a failing assertion rather than as a puzzle.

The same property means this correction protects nothing until it is the base other branches are
measured against. Until it merges, the hole stays open exactly as described above.

### Expected noise at the new boundary

Touching the seven unapplied `20260914100*` restamped candidates (PR #704) now reports **seven**
pending-band warnings rather than eight. `20260908130000` is no longer among them: it is *equal* to
the new boundary, so it classifies as applied and would be refused outright, which is correct — it
ran live on 2026-09-15. The eight-warning figure describes the **pre-refresh** boundary. The seven
warnings are by design: the pending band is the still-editable band, and those seven files are
genuinely unapplied.

### The refresh exposed a latent boundary bug in `src/lib/rpcContracts.test.ts`

CI caught this; it was not predicted. `registryMigrationHighWater()` returned `_meta.migrations_high_water`
raw, and `generatedMutatingRpcInventory()` compares it against a migration's **authored 14-digit filename
prefix** (`timestamp > highWater`, line 2818). Those are different number spaces:
`migrations_high_water` is the ledger's **apply-time version**, which Supabase assigns at apply.

Before this refresh the two happened not to collide. After it, `migrations_high_water` became
`20260915033227` — which sorts **above** the seven authored-`20260914100*` restamped files. Those seven are
**not applied** and are **not in `src/types/supabase.ts`**, so the raw number falsely asserted "the registry
already knows about these". Their RPCs dropped out of the mutator inventory, and
`record_commission_earned_state` / `record_commission_settlement_event` then read as stale exemptions:

    AssertionError: expected [ "record_commission_earned_state",
                               "record_commission_settlement_event" ] to deeply equal []

The file's own comment (lines 2707-2714) already names this trap from the other direction — six `20260831*`
migrations sorting *below* an apply-time high-water — and worked around it with the
`MIGRATIONS_AWAITING_TYPE_REGENERATION` constant rather than correcting the comparison.

**Fixed at the cause, not papered over.** `registryMigrationHighWater()` now prefers the **max authored
stamp across `_meta.applied_migration_names`**, keeping `migrations_high_water` only as the fallback for a
registry whose names carry no stamps. That is the identical rule `scripts/check-migration-hard-rules.mjs`,
`.claude/hooks/migration-ordering-lib.mjs` and `session-staleness.mjs` already apply, for the same reason.
The boundary resolves to `20260908130000`, the seven restamped files sort above it and are discovered again.

Two entries were deliberately **not** added to `MIGRATIONS_AWAITING_TYPE_REGENERATION`. Suppressing the
symptom that way would have left the wrong comparison in place to misfire on the next refresh, and the
constant's own comment warns against exactly that.

## Verification

- Live ledger read read-only on 2026-09-17 before any file was written:
  `max(version)` = `20260915033227`, 1,002 rows, newest applied name
  `20260908130000_bind_create_inventory_hold_receipt_to_intent`.
- **Before/after proof by execution.** The same edit to
  `supabase/migrations/20260908120000_close_pr535_live_gaps.sql`, in throwaway repositories whose
  merge-base carries each registry:
  - pre-refresh registry (boundary `20260904180000`) → exit **0**, "revises a pending migration",
    check **PASSES**;
  - refreshed registry (boundary `20260908130000`) → exit **1**,
    "MODIFIES an applied migration", check **FAILS**.
- **Pending-band proof by execution.** Touching `20260908130000` plus the seven `20260914100*`
  candidates: pre-refresh → exit 0, 8 warnings, 0 violations; refreshed → exit 1, 7 warnings,
  1 violation (`20260908130000`).
- `node scripts/check-migration-hard-rules.test.mjs`: 90 assertions across 22 repository scenarios
  (was 79 across 20). The two new scenarios are the merge-base pair above, and the new pure
  assertions read the **committed** registry rather than a fixture, so a rollback of this file fails
  the suite instead of silently re-opening the band.
- `node .claude/hooks/migration-ordering-lib.test.mjs`: 22 assertions (was 18). New coverage for the
  `20260908120100` band (Codex P3): a candidate stamped between the two 2026-09-08 applies is
  refused as an out-of-order replay, the band edge at `20260908130000` is pinned, and the
  `20260914100*` stamps that replaced it are allowed — so the restamp is proven to have actually
  cleared the guard.
- **Non-vacuity check.** Both new tests were re-evaluated against `origin/main`'s pre-refresh
  registry. All three new assertions FAIL there — `readHighWater` returns `20260904180000`, the edit
  classifies as pending rather than protected, and `checkMigrationOrdering` returns `ok: true` for
  the `20260908120100` candidate. The tests are bound to this refresh rather than passing by
  construction.
- `npm run test:contracts`: 121 assertions across 3 files pass. The failing CI run was
  120 passed / 1 failed; the boundary fix above closes it at the cause.
- `npm run test:correction-guards` and `node scripts/check-doc-drift.mjs` both green.
- Registry sanity: `registry_version` 2, all 8 sections present, `status_enums` unchanged at 38.

**Not verified.** No migration was applied, no live data changed, and nothing was written to the
database — this change is read-only introspection plus a committed file. The guard's behaviour is
unchanged; only tests were added, per the guard-logic freeze through 2026-09-25.

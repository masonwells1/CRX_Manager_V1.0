## 2026-09-05 - refresh the schema registry from live, closing the applied-migration immutability hole

`.claude/schema-registry.json` recorded `_meta.migrations_high_water` as `20260903153402` while the
live ledger stood at `20260904152221`. `scripts/check-migration-hard-rules.mjs` uses that number as
the boundary of its "still revisable" band: a migration whose filename version is **greater** than
the high-water is treated as pending and may be edited; anything at or below it is an applied
migration and is protected from edits, renames and deletion.

**Corrected 2026-09-05 after Codex P2 on PR #601 — this list originally claimed five affected
migrations; four is right.** The five below were all applied live above the recorded *ledger*
mark, but the guard bands migrations by their **filename** stamp, not their apply-time version.
`20260903150100_ledger_backed_commission_history` has filename stamp `20260903150100`, which is
*below* the previous high-water `20260903153402`, so it was already protected and was never in the
hole. The remaining four were:

- `20260903150100_ledger_backed_commission_history` (applied as `20260903202611`)
- `20260903160000_gate_number_generators_active_profile_role` (applied as `20260904023121`) — the F2 security gate
- `20260903230000_commission_report_snapshot_contract` (applied as `20260904040643`)
- `20260904160000_invoice_date_fallbacks_chicago` (applied as `20260904130047`)
- `20260904180000_invoice_season_follows_invoice_date` (applied as `20260904152221`)

The refresh was the real `--from-introspection` rebuild against project `rhyzpcqhnizqbxphqdkr`, not a
`generated_at` stamp. That distinction matters here: the registry was stale in **substance**, not
only in its high-water number, and a stamp run would have published a false freshness claim while
leaving the hooks blind. Live introspection found three tables the registry had never seen —
`commission_earned_state_ledger`, `commission_history_cutover`, `commission_settlement_events` — so
their columns, NOT NULL sets and three parseable CHECK IN-lists
(`commission_earned_state_ledger.event_kind`, `commission_earned_state_ledger.source_type`,
`commission_settlement_events.event_kind`) were absent from the file that four PreToolUse hooks and
three review subagents read as their source of truth.

Nothing was removed: no table, status enum, generated column or sequence disappeared, and no enum
value set changed. Every delta is an addition, which is what a pure catch-up should look like.

### Why the gate only closes once this is on `main`

`check-migration-hard-rules.mjs` reads the registry from the **merge-base** tree, deliberately, so
that a pull request cannot widen its own revisable band by editing the registry in the same change
(the script says so in its header). The consequence is that this correction protects nothing until
it is the base other branches are measured against. Until then the hole stays open exactly as
described above.

## Verification

- Live ledger reconciled against the registry before and after: `max(version)` = `20260904152221`,
  998 ledger rows, 991 distinct names.
- Before/after proof run of `runDiffCheck` against a scratch commit that modifies the applied F2
  migration: with the pre-refresh registry as the base the edit is reported as a revisable pending
  migration and the check PASSES; with the refreshed registry as the base the same edit is refused
  as `MODIFIES an applied migration` and the check FAILS. Recorded in the commit message.
- `node scripts/check-migration-hard-rules.test.mjs` and the agent-workflow suites pass.
- Registry sanity: `registry_version` 2, all 8 top-level sections present, `status_enums` unchanged
  at 38 entries.

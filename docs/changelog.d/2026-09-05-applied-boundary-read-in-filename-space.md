## 2026-09-05 - read the applied-migration boundary in filename space, not apply-time version space

Answers the Codex GitHub App review of PR #601 on `09e90113`. Two findings, both accepted, both the
same root error in the original commit: **two different number spaces were treated as one.**

`classifyMigrationChanges()` bands migrations by their **filename** stamp
(`<YYYYMMDDHHMMSS>_name.sql`). The value fed to it was `_meta.migrations_high_water`, which is the
ledger's **apply-time `version`** — a number Supabase assigns when the migration runs, unrelated to
the authored filename. Refreshing that field therefore did not close the hole it claimed to close.

### P1 — two applied migrations were still editable

`20260904180000_invoice_season_follows_invoice_date` was applied as version `20260904152221`. Setting
the high-water to `20260904152221` left every migration *authored* after that instant still reading
as "newer than applied":

| Applied migration | Filename stamp | Under `20260904152221` |
| --- | --- | --- |
| `20260903160000_gate_number_generators_active_profile_role` | `20260903160000` | protected |
| `20260903230000_commission_report_snapshot_contract` | `20260903230000` | protected |
| `20260904160000_invoice_date_fallbacks_chicago` | `20260904160000` | **still editable** |
| `20260904180000_invoice_season_follows_invoice_date` | `20260904180000` | **still editable** |

`readHighWater()` now returns the **max authored stamp** across `_meta.applied_migration_names` —
the 14-digit prefix of each applied ledger name — which is `20260904180000` and protects all four.
The apply-time value remains the fallback for a registry whose names carry no stamps.

Membership in `applied_migration_names` is still not used: it matched only 252 of 900 files by name
on 2026-09-03, so "is this file in the list" proves nothing. Taking a **maximum over the stamps**
needs no per-file match and is unaffected by that mismatch. This is the same rule
`.claude/hooks/migration-ordering-lib.mjs` and `session-staleness.mjs` already apply, for the same
reason — the original commit read that reasoning and still supplied the apply-time number.

### P2 — the affected count was overstated

The original entry said five migrations sat in the revisable band. Four did.
`20260903150100_ledger_backed_commission_history` has filename stamp `20260903150100`, below the
previous high-water `20260903153402`, so it was already protected. The prior entry is corrected in
place rather than left standing.

## Verification

Same scratch commit, same base registry, only the boundary interpretation differs — so the
difference isolates the fix:

```
base registry apply-time high-water : 20260904152221
base registry AUTHORED boundary     : 20260904180000

OLD — apply-time boundary   highWater=20260904152221  -> ALLOWED (revisable)
NEW — authored boundary     highWater=20260904180000  -> REFUSED (protected)

real runDiffCheck verdict: ok=false
  applied high-water mark (from base registry): 20260904180000
  ✗ MODIFIES an applied migration: supabase/migrations/20260904160000_invoice_date_fallbacks_chicago.sql
```

`node scripts/check-migration-hard-rules.test.mjs` — 79 assertions across 20 scenarios pass.

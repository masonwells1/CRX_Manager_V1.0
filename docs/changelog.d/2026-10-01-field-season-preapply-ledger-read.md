## 2026-10-01 — fresh pre-apply live-ledger read recorded for the field-season install

The migration-drift reviewer charter (CHECK 6) needs a current read-only `list_migrations` preflight
before an apply. Both drift reviews of `20260914101000` and `20260914101100` on PR #857 returned one
HIGH and nothing else: the newest recorded read in `docs/reference/migration-history.md` was dated
2026-09-27, so it could not establish the live high-water on 2026-10-01.

- `migration-history.md` now opens with the 2026-10-01 11:07 UTC read-only capture: 1013 ledger
  rows (1006 distinct names), `max(version)` `20260928025520`, effective ordering high-water
  `20260914100900_repair_commission_history_label_snapshots` computed row by row, with
  `20260914101000`..`20260914101300` all above it and none in the ledger.
- The 2026-09-27 capture is kept below it, marked superseded.

Proof: the figures come from a read-only `select version, name from
supabase_migrations.schema_migrations` against production at 11:07 UTC, with the high-water computed
by `migrationTimestamp` from `.claude/hooks/migration-ordering-lib.mjs`. Not verified: nothing was
applied by this change; it is documentation only.

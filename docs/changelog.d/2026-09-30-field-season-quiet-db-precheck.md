## 2026-09-30 — field-season delivery: quiet-database pre-check for 101300 documented

CodeRabbit's full review of PR #843 (nitpick) asked that phase 2's quiet-database gate be kept and
that a quiet database be confirmed before applying it.

- `migration-history.md` now carries the read-only `pg_stat_activity` query to run right before
  `20260914101300`, next to the PRE-APPLY PROOF RULE.
- The migration's `GENERIC_FIELD_CUTOVER_NOT_QUIET` gate is unchanged. It was already present, and
  no SQL was edited.

This is on the refreshed delivery branch (lap20: #843's head plus `origin/main`), which replaces
#843.

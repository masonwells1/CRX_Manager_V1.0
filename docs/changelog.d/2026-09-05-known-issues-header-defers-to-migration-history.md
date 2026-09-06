## 2026-09-05 — KNOWN_ISSUES.md stops restating the migration boundary; migration-history.md is the single source

**Why.** The renumber commit `6c7929797` on PR #592 refreshed the live-ledger capture at the top of
`docs/reference/migration-history.md` (999 rows / 992 distinct names, effective high-water
`20260905185938_refuse_null_job_field_acres`) and the candidate-set lines of
`docs/manual/KNOWN_ISSUES.md`, but left that file's header paragraph naming the superseded afternoon
boundary (`20260904180000_invoice_season_follows_invoice_date`, 998 rows / 991 distinct). Codex
raised it as a P2 on the PR (`discussion_r3942081827`): the two manuals gave different answers to
"what is the newest applied migration", and the stale one was the more prominent, so a migration
stamped between the two boundaries would read as safe from the manual while the ordering guard
refused it. The mismatch was still present at PR head `5f76c5242`.

**What changed (docs only).** The `KNOWN_ISSUES.md` header no longer states a boundary, a row count
or a `max(version)` at all. It points at the "THIS IS THE CURRENT BOUNDARY" capture in
`docs/reference/migration-history.md` as the single source, records the 2026-09-05 drift as the
reason, and keeps the reading-trap guidance (`version` vs `name`, `max(name)` garbage, bare-name
rows synthesized to `<version>_<name>`). Pointing rather than restating was chosen deliberately: a
second correct copy would only reset the drift clock. `CURRENT_STATE.md` already carries the
current high-water and was not changed. No migration, guard, script, or code file changed.

**Proof observed.** `npm run check:docs` passes with the `Last verified:` stamp and freshness rows
green for `KNOWN_ISSUES.md`. `git diff --stat` shows exactly two files: this entry and
`docs/manual/KNOWN_ISSUES.md`.

**Not verified.** Nothing on live was re-read for this change; the boundary figures quoted above are
the ones already recorded in `migration-history.md` by the earlier 2026-09-05 evening capture.

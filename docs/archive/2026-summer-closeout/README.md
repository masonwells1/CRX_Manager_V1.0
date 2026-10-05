# Archive — 2026 Summer Closeout

Finished records moved out of the active folders during the 2026-07-16 and 2026-07-26 docs
cleanups. Most of what was moved here was deleted in the 2026-09-26 cleanup, after every file
was read in full and the still-open items found were copied to `TODO.md` §5 or
`docs/manual/KNOWN_ISSUES.md`. Deleted files remain recoverable from git history.

One exception: the lower-tier rows (tiers 1–3) of the deleted
`roadmap/app-wide-structure-audit-2026-07-01.md` were not re-checked one by one. `TODO.md` §5
("Not fully re-checked") says to re-read it with
`git show 4b6ff6293:docs/archive/2026-summer-closeout/roadmap/app-wide-structure-audit-2026-07-01.md`
before acting in that area.

⚠️ Verify current live behavior in code and the live database before acting on anything in
here. Statuses inside these files are frozen at their last edit.

## What is left

- `loops/structure-fix-ledger.md` — the structure-fix Wave A ledger. It holds the only
  detailed record of the **deferred month-end-close picker UI** (A9), tracked in `TODO.md` §4.
- `roadmap/product-units-scheduling-deep-dive-2026-07-01.md` — the source of the
  **Phase 4/5 scheduling leftovers** tracked in `TODO.md` §4.

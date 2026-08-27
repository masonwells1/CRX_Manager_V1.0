## 2026-08-26 — the stop hook now requires an ADDED fragment, not merely a touched one

Teaching the stop hook to recognise `docs/changelog.d/` made it LOOSER than before, and
the regression was mine. Its ledger matcher is status-blind, which is right for the legacy
files — appending to `CHANGELOG.md` or `DECISION_LOG.md` IS a modify — but wrong for a
fragment, where adding your own is the whole point. A session that committed application
work while merely modifying, renaming or deleting somebody else's entry matched the new
pattern and finished with no warning at all. Before this PR that session would have been
warned. Codex caught it on the same commit that introduced it.

The hook now reads `git log --name-status -M` instead of `--name-only`, carries the status
alongside each path, and counts a fragment only when it was ADDED. A rename destination
(`R100`) is not an addition, matching what pre-commit already refuses. Every other ledger
path stays status-blind, so nothing that satisfied the hook before stops satisfying it.

Proven by running the real hook end-to-end against real commits, not by asserting it:

- Session that ADDED a fragment (`18c0419d`) → no warning. Correct.
- Session that only MODIFIED and DELETED fragments (`979ff6df`, checked out in a scratch
  worktree) → the warning fires. Correct, and this is the case that was silent.
- Mutation: making the matcher status-blind again turns the second case silent, so the
  status split is what closes it rather than something else in the change.

The lesson worth keeping is that adding a pattern to an allow-list is not a neutral act.
The three previous rounds all tightened what the guard accepts; this one quietly widened
what the hook accepts, in the same change set, while looking like more of the same.

## 2026-08-31 - Restore the commit and push guards across every worktree

The shared `core.hooksPath` pointed at `.husky/_`, a directory husky generates
during `npm install` and `.gitignore`s. Worktrees created without an install in
them therefore resolved the setting to a directory that was not there, and git
skips a missing hook silently — `git commit` and `git push` reported nothing
unusual while running no guard at all. Hand-set absolute overrides pointed six
more checkouts at other worktrees, including an abandoned one, so those ran a
different branch's guard code.

Fourteen of forty-four registered worktrees were affected. Reproduced in a
throwaway worktree created the ordinary way: `git hook run pre-commit` reported
`cannot find a hook named pre-commit` before the change and ran the ledger and
containment guards over 2,892 paths after it.

Pointed the shared setting at the tracked `.husky` directory, which every
worktree resolves against its own root, and cleared all ten per-worktree
overrides. Re-scanned the fleet: every worktree now resolves to a real
`pre-commit`. The tracked hooks are plain shell and never sourced husky, so no
husky runtime is required.

Replaced the `prepare` script, which re-set the broken value on every
`npm install`, and added a `Git hooks installed` check to `agent-health` that
fails when `core.hooksPath` is unset, missing its hooks, or pointing outside the
worktree. Verified by breaking the setting and watching `npm run prepare` repair
it, and by mutating the new check and watching its tests go red.

Also corrected `AGENTS.md`, which credited `main`'s approval rules to the
`protect-main` ruleset. Those rules come from classic branch protection; the
ruleset requires zero approvals and does not dismiss stale reviews. Both are
live and nothing was weakened, but the documented mechanism was wrong in a way
that could have led someone to remove the one actually holding the gate.

No application code, schema, live database state, or production behavior was
changed.

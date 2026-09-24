## 2026-09-20 - The merge gate reads gh's short options the way gh does

Which short options take a VALUE decides which pull request the merge gate vets.
The bundle reader added earlier the same day used a guessed table, and all three
mistakes aimed the gate at a different pull request than the one gh merges —
letting objections, green checks, the risky-diff rule and the exact-SHA proof all
pass against a safe PR while another one landed.

Corrected against gh's own manual for `pr merge`: `-A` (`--author-email`), `-b`
(`--body`), `-F` (`--body-file`), `-t` (`--subject`) and the inherited `-R`
(`--repo`) take a value; `-d` (`--delete-branch`), `-m` (`--merge`), `-r`
(`--rebase`) and `-s` (`--squash`) are boolean.

Measured before and after, against the real shared parser:

| command | vetted before | gh actually merges | vetted now |
|---|---|---|---|
| `<merge> -dr 789` | the current branch's PR | PR 789 | PR 789 |
| `<merge> -dR other/repo 789` | 789 in *this* repository | `other/repo#789` | `other/repo#789` |
| `<merge> -A someone@… 789` | PR `someone@example.com` | PR 789 | PR 789 |

The short cluster is now read by shape, the same way the `gh api` cluster next to
it already was: walk the letters, stop at the first value-taking one, and take
its value from the rest of the token, from after an `=`, or from the next word.
A non-letter ends the cluster, so `-d=true` stays one boolean rather than being
re-read as more shorts. `-R` now yields the repository in every spelling it has —
bare, attached, `=`-joined and bundled.

Both merge guards import this one parser, so the correction covers
`.claude/hooks/pr-merge-guard.mjs` and `.codex/hooks/production-action-guard.mjs`
together. Locked in by assertions in `.claude/hooks/pr-merge-guard.test.mjs`
(selector and repository per spelling) and `.claude/hooks/guards.test.mjs` (the
whole guard process still refuses each spelling).

Found by the `gpt-5.6-sol` exact-SHA review of `7bf8bc9f5` (HIGH) on PR #630. The
review named `-r` and the bundled `-R`; reading gh's manual to confirm those
surfaced the `-A` case as well.

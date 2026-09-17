## 2026-09-14 — Agents close a superseded delivery PR instead of leaving it open

**Problem.** CodeRabbit reviews each PR once, so every fix round needs a fresh delivery PR.
`.claude/commands/ship.md`, the `deploy-check` skill and
`docs/reference/coderabbit-native-review.md` told agents to open that PR while
"preserving the prior PR", so every old copy stayed open. By 2026-09-14 the repository
had 55 open PRs, about 40 of them superseded copies. The #624 inventory work had 22 of
them, the #638 invoice work 10, and the migration restamp 6.

**Change.** The same three instructions now say that once the fresh delivery PR exists,
agents close the previous PR with a `Replaced by #N` comment. If a manual or status
document names the old PR as a task owner, it is updated only after delivery lands, or
in a separate docs PR. Committing it to the frozen candidate would change that candidate's
head and force another replacement, a gap the Codex GitHub App found on #705. The generated
Codex adapters were resynchronised. The fresh-PR requirement itself is unchanged, and no
hook or CI gate was added.

**Why closing is safe.** Closing keeps the branch, commits, comments and review findings,
and it can be undone. In `.github/scripts/coderabbit-final-review.cjs`, `closed` is one of
the `RESET_ACTIONS`, and it resets only that PR's own workflow labels. Nothing in the
workflow reads other PRs.

**Cleanup done the same day.** Mason approved the cleanup, and Codex gpt-5.6-sol
cross-checked the plan. 27 superseded PRs were closed after proving each one's head was
contained in its successor or in merged history: #647, 652, 654, 655, 656, 660, 662, 663,
668, 673–681, 683, 684, 685, 687, 689, 690, 696, 697 and 698.

**Not verified / left open.** Nine inventory PRs (#658, 659, 661, 665, 666, 667, 670, 671
and 672) contain file versions that never appear verbatim in the history of main or #691.
They were left open until their owner checks them. The new rule only reaches sessions that
read the updated instructions, so the three running sessions were messaged directly.

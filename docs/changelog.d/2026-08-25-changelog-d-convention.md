## 2026-08-25 — one changelog file per change, to stop parallel sessions colliding

`docs/CHANGELOG.md` is 15,445 lines and every parallel session appends to the top of
it. With nine sessions running, that made merge conflicts routine rather than
exceptional: measured on 2026-08-25, **12 of 13 open PRs** touched one of the three
shared ledger documents (`CHANGELOG.md` in 9, `DECISION_LOG.md` in 7,
`KNOWN_ISSUES.md` in 4). The only exception was a Dependabot PR. That day a conflict
in this file blocked a finished, fully-reviewed PR at the last step, and the manual
resolution introduced a markdownlint MD022 break that took another review round to
catch.

A shipped change now goes in a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` file.
Two sessions never write the same path, so there is nothing to conflict on.

- `scripts/check-ledger-update.mjs` accepts `docs/changelog.d/*.md` as a ledger
  update, and names it first in the blocked-commit message. `README.md` is
  explicitly excluded via negative lookahead — otherwise editing the folder's own
  instructions would satisfy the guard while recording nothing. Mutation-tested:
  removing the lookahead turns the suite red, so that exclusion is load-bearing
  rather than decorative. 48 assertions pass.
- `docs/changelog.d/README.md` states the convention and the rule against editing
  someone else's entry to get past a red hook.
- A consolidation tool is deliberately NOT included. It would delete the files it
  consumes, which needs a higher bar than the convention itself; it ships separately.
- `AGENTS.md` points sessions at the new path.

**Deliberately not done.** The ledger guard itself was left alone. It was first
suspected as the cause, but it only fires on agent-surface and migration changes and
already accepts any `docs/manual/*.md`, `agent-guardrails.md`, `migration-history.md`
or a loop ledger — it never forced anyone into `CHANGELOG.md`. Sessions pile in there
by convention. Removing the guard would have cost the written record that lets Mason,
who does not read code, discover what changed, while leaving the collisions untouched.
This is a convention fix, not a guard relaxation: nothing previously blocked is now
allowed.

`DECISION_LOG.md` and `KNOWN_ISSUES.md` are unchanged. Both are edited in place, not
only appended to, so the same treatment needs separate thought.

**Adoption is the risk.** A convention half the fleet ignores is worse than none.
This lands the mechanism; whether other sessions follow it is the open question.

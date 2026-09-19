## 2026-09-19 — The CodeRabbit gate's failure message now says to close the superseded PR

**Problem.** #706 changed the delivery docs to say: open a fresh delivery PR, then close
the old one with a `Replaced by #N` comment. The final-review gate's own error message
was missed. On 2026-09-17 (PR #711) it still said "preserve this PR and use a fresh PR",
and then "Re-apply ready-for-coderabbit after correcting the blocker". An agent reads
that message at the moment it decides what to do with the old PR, so the message
contradicted the policy.

**Change.** `.github/scripts/coderabbit-final-review.cjs` now uses one shared phrase for
every block that needs a fresh PR: "open a fresh delivery PR at the corrected head and
close this one with a "Replaced by #N" comment". When the block needs a fresh PR, the
closing line says to apply `ready-for-coderabbit` on the fresh PR once its checks pass,
not to relabel this PR. "Unspent state was cleared" and "a new commit is unnecessary"
are unchanged. Only the wording changed; no check or block condition changed.
`docs/reference/gotchas.md` had the same "preserve ... and use a fresh PR" advice and
now matches.

**Proof.** The gate test suite passes. A new test runs a candidate whose base changed
after the PR was opened and checks the whole message. That test and the tightened
existing test both fail against the old script from `main`.

## 2026-08-31 — A migration that is not applied live is not therefore abandoned

Seventh Codex pass on PR #529. One P2, verified and correct.

### What was wrong

The inventory offered a binary for any branch holding a migration absent from `main`: applied live,
or else "keep-and-finish or abandon". That misses the state most of these branches are actually in.

Two of the twelve are on **open PRs** — `codex/section9-ap-safety-remediation-v2` (#500) and
`claude/return-credit-cogs-reversal` (#361, itself titled "PARKED — wants live test before apply").
For a candidate still under review, `main` not carrying the migration is the *normal* state, not
evidence that anyone dropped it. A cleanup reviewer following the binary could discard live pending
work, or skip evaluating a rollout that is still planned.

The repository already distinguishes this state. `docs/reference/migration-history.md` marks rows
with `LOCAL CANDIDATE — NOT APPLIED` and `SOURCE ONLY — NOT APPLIED LIVE`, both meaning pending
rather than dead.

### Fixed

The absent-migration section now names three dispositions instead of two — **applied live**,
**pending**, **abandoned** — and states plainly that *"not applied live" does not mean abandoned*,
with disposition to be established from the PR and the ledger rather than from the absence of a live
apply. It notes the repository's own pending markers, and that branches on open PRs are pending by
default and should be left alone.

The review order was updated to match: step 2 now asks for the disposition and gives the action for
each, rather than offering a two-way choice.

### Proof observed

The two open-PR branches were confirmed present in the absent-migration table with their PR numbers;
the `LOCAL CANDIDATE` and `SOURCE ONLY` markers were read from `migration-history.md`.
`npm run check:docs` passes.

### Lesson

Same shape as the previous P1: the data was right and the instruction on top of it was wrong. A
two-way split is a claim that the world has two states, and here it quietly reclassified everything
pending as abandoned — the direction that loses work.

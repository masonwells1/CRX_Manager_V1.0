## 2026-08-31 — the identity check blocked the layout this repo actually uses

Seventh round. The exact-SHA `gpt-5.6-sol` review of `5eaa78e8` returned **CLEAN — no blocker
or high-severity security findings**, having matched all 5,830 snapshot files against their
manifests and confirmed exactly 13 changed paths. It raised one low-severity, fail-closed
issue, and it was a regression I introduced two rounds earlier.

**The problem.** Round 3 added "the file you pass must BE the approved file", comparing
`realpath(argument)` against `source.file` — the *first* match the resolver returns. When the
primary checkout and the session's worktree both hold the migration, the resolver returns the
**primary** one. Passing the worktree's own file — the normal thing to do from a worktree —
was then refused for "not being the approved artifact".

**Severity, stated accurately.** It could never authorize unsafe SQL and could not cause data
loss; it fails closed. But it blocks real work in the layout this repo actually uses, where
dozens of worktrees run at once, and a guard that refuses legitimate applies gets routed around
— which is how guards die.

**The fix.** Compare against **every** permitted location rather than the first match. That was
always the intended rule: the argument must *be one of* the permitted files. Every candidate is
equally approved — `ok: true` already guarantees the content matched a permitted file, and each
candidate lives in a session-scoped checkout the reviewer-proof lookup already trusts.

**Why this is not a loosening.** The set compared against is unchanged; only "first element of"
became "member of". An out-of-tree copy is still refused, because it is in none of them.

**Proof observed.**

- `migration-apply-lib.test.mjs` **171**, `migration-apply-guard.test.mjs` **109** — green,
  including the round-3 regression test that an identical-content copy outside the checkout is
  still refused.
- Real path, read-only: a parked wave-A migration is still refused by name.

**Pattern worth noting across this PR.** Three of the seven rounds found a defect introduced by
the *previous* round's fix — the round-2 bypass, the round-3 identity check, and the round-4
comment mismatch each created or exposed the next finding. Tightening a guard is not
monotonic: each narrowing changes which inputs reach which check, and the new arrangement needs
its own look rather than inheriting the previous round's confidence.

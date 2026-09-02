## 2026-08-31 — the same disarming bug, a second time, in a different pair of tests

Sixth round on the migration source-provenance gate. The exact-SHA `gpt-5.6-sol` review of
`b7ac7a8f` returned **CLEAN — no blocker or high-severity security findings**, having matched
both snapshots against every manifest SHA-256, reviewed all 12 changed paths, and confirmed by
read-only execution that valid repository SQL passes while altered content and parked or
traversal-spelled SQL fail. Two minor findings, both real.

**1. Two more tests were passing for the wrong reason — the same bug as round 1.**

The worktree-scoping cases at `migration-apply-guard.test.mjs` — "the session's own worktree
proof does NOT excuse a queryHash mismatch" and "…does NOT cover a different migration name" —
transmit SQL that has no matching repository file. Source provenance therefore refused *before*
either the content binding or the proof-name check was reached. Both still reported a denial, so
both stayed green while testing nothing they claimed to test.

This is the second occurrence of this exact failure in this PR. Round 1 fixed it in the
autopilot cases; the same reasoning was not carried to these two, even though the PR body
already stated the general rule. Worth recording plainly: **the lesson was written down and
still not applied.** Knowing the failure mode is not the same as sweeping for it — the sweep
has to be a deliberate step, over every test downstream of a newly-inserted gate, not a
principle one keeps in mind.

Both cases now seed the migration file so the intended check is reached, and both assert the
**denial reason** (`without subagent review proof` — the proof gate's message, not the
provenance guard's banner). That assertion is what proves the short-circuit is gone: if
provenance were still firing first, the message would read `MIGRATION SOURCE GUARD` and the
test would fail.

**2. `withinDir` became unused security-sensitive code.** The direct-child rule replaced it in
round 5. It is removed rather than kept: an unused containment predicate sitting in a security
file is an invitation for a later edit to reach for the looser of two available rules — and its
looseness is exactly what the previous round spent effort removing. A comment marks the spot so
the removal is legible rather than looking like an oversight.

**Proof observed.**

- `migration-apply-guard.test.mjs` 107 → **109**; `migration-apply-lib.test.mjs` 171;
  `guards.test.mjs` 168 — all green.
- The two new reason assertions pass, which is direct evidence the cases now reach the proof
  gate instead of being refused upstream.

**Not verified.** Unchanged from round 5: two of the three link-shaped cases skip on this
machine because Windows will not create a file symlink without elevation; only the
directory-junction case executes.

**Branch mechanics worth recording.** The rebase for this PR could not be force-pushed — the
push guard refused, which turned out to be correct for a reason unrelated to policy: a
concurrent session had merged `main` into the PR branch, creating a merge commit that existed
only on origin. A `--force-with-lease` evaluated against the stale local view would have
destroyed it. The branch was instead updated the non-rewriting way — take origin's actual
state, merge current `main`, cherry-pick the two newer commits — yielding a plain fast-forward.

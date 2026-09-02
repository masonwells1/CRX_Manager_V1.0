## 2026-09-02 - Stop the push policy claiming approval is both mandatory and removed

Codex flagged this on the exact-head review of this branch: the operational guidance "inconsistently
says formal approval is both mandatory and removed", which "fails conservatively but may
unnecessarily strand delivery."

It was real, and it predates this branch. `AGENTS.md`'s **Standing push policy** paragraph still
said the pipeline is green only once "formal GitHub approval remains mandatory", and described
landing as ending in "verify its formal exact-head approval → merge". The **Standing CodeRabbit
review policy** paragraph directly below it says the opposite — Mason removed
`required_pull_request_reviews` from `main` on 2026-09-02 (#559), and a green pull request now
merges with no approving review at all.

Two paragraphs of the same contract, disagreeing on the one question an agent asks before merging.
The failure mode is not theoretical: the decision log already records two sessions in a row reading
a stale approval requirement and drawing the wrong conclusion.

The push-policy paragraph now states the current rule — every required check must pass, any review
actually delivered must be clean, an approving GitHub review is **not** required, and CI rather than
a review is the merge gate — and the landing sequence no longer ends in an approval step. What did
**not** change: a `CHANGES_REQUESTED` verdict still blocks, both agent merge gates still refuse to
merge over one, and the exact-SHA `gpt-5.6-sol` proof is still required for risky diffs.

Scope note: this corrects a contradiction inside the paragraph this branch already edits. It does
not reopen the 2026-09-02 decision, and it does not touch the merge guards.

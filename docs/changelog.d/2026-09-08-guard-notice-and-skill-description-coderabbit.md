## 2026-09-08 — the merge notice and the deploy-check description stop implying a review is mandatory

Fourth Codex pass on PR #634, two more real findings. Both are the same defect as the third pass —
text that still treats a CodeRabbit review as a precondition — surviving in the two places the
earlier passes did not look: a runtime message, and a skill's advertised description.

**1. The merge guard's own notice (`.claude/hooks/pr-merge-guard.mjs`).** The notice this PR
rewrote still ended with a flat "Read the review and fix what it finds first." An agent merging an
otherwise-green PR the hourly job has not reached would be told, by the guard itself, at the moment
of merging, to go read a review that does not exist. It now reads: if a review DOES exist on this
head, read it and fix what it finds first; if none exists, that is not a blocker — CI is the merge
gate, do not wait for one.

**2. `deploy-check`'s frontmatter description.** Line 3 still advertised the landing sequence as
"branch → PR → checks → **CodeRabbit** → merge". That string is not documentation an agent reads
after opening the file — it is the one-line summary shown in the skill listing, so it is what an
agent sees *while deciding what to do*, and it named CodeRabbit as a step in the path. Now: "branch
→ PR → green required checks → merge … CI is the merge gate; a CodeRabbit review is not required."
Swept the rest of `.claude/skills/` and `.claude/commands/` for the same pattern in frontmatter —
this was the only one.

**Verified by running it, not by the suite.** The guard's 97-assertion suite passes, but a string
literal inside a branch the suite already covers can pass a test while saying the wrong thing. The
hook was executed against PR #634 with a real `gh pr merge` payload and the emitted stderr was read
directly; it printed the corrected wording.

That same run surfaced something worth recording: because this PR edits
`.claude/hooks/pr-merge-guard.mjs`, the guard classifies the diff as risky and **denies its own
merge** until a fresh `write-codex-push-proof.mjs` verdict is minted against the exact head and
base. The guard gating the change that edits the guard is correct behaviour, and the proof is the
intended path through it — not something to work around.

Codex adapters regenerated; `npm run test:agent-workflows` passes. Text only — no control flow, no
gate, and no CodeRabbit configuration key changed.

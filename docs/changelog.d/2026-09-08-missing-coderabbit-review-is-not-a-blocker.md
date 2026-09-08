## 2026-09-08 — a missing CodeRabbit review is not a reason to hold a green PR

Third and final Codex P1 on PR #634, and correct like the two before it. The earlier commits in
this PR added "if CodeRabbit has not reviewed, do not wait" to the landing workflows — then left an
unconditional **"confirm CodeRabbit actually reviewed the frozen candidate"** standing a few lines
later in `.claude/skills/codex-review/SKILL.md` and `docs/reference/gotchas.md`.

Both instructions cannot be followed at once. An agent whose PR the hourly
`crx-hourly-coderabbit-slot` job has not yet reached is told to proceed *and* to confirm a review
that does not exist. The safe reading of a contradiction is to wait — which is precisely the stall
this PR exists to remove, reintroduced by the fix for it.

**The old sentence was guarding something real, so it is kept, not deleted.** CodeRabbit's check
row reports green when automatic reviews are disabled, which they are here. The row is therefore
not evidence that a review happened, and merging on it would mean merging on a review nobody ran.
That is an anti-spoofing rule about *trusting* a review — it is not a precondition for merging.

Both files now separate the two ideas explicitly: a missing review is not a blocker (an absent
review and an unverified one are different things), while anyone who *relies* on a CodeRabbit
review must confirm it exists on the frozen candidate, and an approval's `commit_id` must equal the
final `headRefOid`. `CHANGES_REQUESTED` still blocks, unchanged.

Codex adapters under `.agents/` regenerated; `npm run test:agent-workflows` passes including the
parity assertion. Documentation only — no control flow, guard behaviour, or CI gate changed.

**Worth noting for the next person:** all three findings on this PR came from the Codex GitHub App
re-reviewing each push, and all three were real. The first two were incompleteness (the fix did not
reach far enough); this one was a contradiction *created* by the fix. A change that rewrites
instructions is exactly the kind where each pass can introduce a new inconsistency, so the
re-review per push earned its cost here.

## 2026-09-08 — the CodeRabbit review and the Codex proof are not symmetric

Fifth Codex pass on PR #634. One new finding, and correct: `.claude/skills/codex-review/SKILL.md`
and `.claude/skills/deploy-check/SKILL.md` both still closed their pre-merge section with
**"both run — neither replaces the other."**

Two sentences earlier, each file now says a missing CodeRabbit review is not a blocker. "Both run"
says the opposite: that a landing needs the CodeRabbit review *and* the exact-SHA Codex proof. On a
risky money/RLS/migration diff — exactly where an agent is most careful and least willing to
improvise — that reads as a hard requirement for a review the hourly job may not deliver for hours.

**The fix keeps the hard half hard.** These two gates were never actually equivalent, and the old
wording flattened them:

- The **exact-SHA `gpt-5.6-sol` Codex proof is always required** for risky money/RLS/migration
  diffs. Unchanged, still a hard gate, still enforced by the merge guard rather than by prose.
- **CodeRabbit participates only when a review has actually been delivered.** It never substitutes
  for the Codex proof, and its absence never holds a green PR.

Both files now say that explicitly instead of asserting symmetry.

`docs/manual/DECISION_LOG.md:2999` carries similar "both run" wording, and was deliberately left
alone: it sits inside a dated historical entry, and the 2026-09-08 entry added earlier in this PR
already supersedes it. A decision log records what was decided and when; the current rule lives in
the newest entry, not in edits to old ones.

Codex adapters regenerated; `npm run test:agent-workflows` passes. Text only.

**On the shape of this PR:** five Codex passes, seven real findings, every one a residue of the
same defect — guidance written when a CodeRabbit review was mandatory, surviving in a place the
previous pass did not look (a routed doc, then a runtime message, then a skill description, then a
closing summary sentence). The findings narrowed each round rather than repeating, which is what
convergence looks like. A change that rewrites instructions across a repo is precisely the kind
where per-push re-review pays for itself.

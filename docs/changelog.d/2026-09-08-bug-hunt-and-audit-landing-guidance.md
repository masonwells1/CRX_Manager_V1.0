## 2026-09-08 — the bug-hunt commands and the audit skill stop gating on a CodeRabbit review

Sixth Codex pass on PR #634. Three more active workflows still required a CodeRabbit review before
merging, in files the earlier passes never opened because they are not the *landing* workflows —
they are workflows that **hand off** to landing:

- **`.claude/skills/audit/SKILL.md`** — its closing line described landing as
  `branch → PR → checks → CodeRabbit → merge`. Now `branch → PR → green required checks → merge`,
  with CI named as the gate.
- **`.claude/commands/codex-driven-bug-hunt.md`** and **`.claude/commands/overnight-bug-hunt.md`** —
  the morning-handoff paragraph in each required "CodeRabbit's review read and resolved … before
  merge". These are the overnight runs: they finish while Mason is asleep and hand him a green PR.
  Requiring a review the hourly job may not have delivered is how an unattended run's output sits
  unmerged for a day. Both now qualify it — read and resolve the review **if** one has been
  delivered on that head — and state that a review is not required to merge.
- **`.claude/skills/deploy-check/SKILL.md`** — the never-do list still said "NEVER trigger
  CodeRabbit while implementation or Codex review is still changing the branch", which quietly
  presumes agents trigger reviews at all. Replaced with the actual current rule: never request a
  review yourself, by label or by comment; the hourly job owns that request.

**Then swept the rest by hand instead of waiting for a seventh pass.** Every `CodeRabbit` mention
across `.claude/commands/` and `.claude/skills/` was reviewed, and every one that survives is now
either correctly qualified, a reference to `.coderabbit.yaml` as the canonical config, or an
unrelated historical citation. `docs/manual/DECISION_LOG.md:2997` and
`docs/manual/KNOWN_ISSUES.md:3575` also mention a pre-merge review and were deliberately left
alone — both sit inside dated historical entries, and the log's 2026-09-08 entry supersedes them.

Codex adapters regenerated; `npm run test:agent-workflows` passes. Text only.

**Why this kept taking passes.** The stale instruction was not in one place; it was spread across
landing workflows, a runtime guard message, a skill's one-line description, a closing summary
sentence, and workflows that merely *hand off* to landing. Each pass found the next layer because
each pass was looking at what the previous fix touched. The hand sweep above is the correction to
that pattern — searching the whole surface for the *concept* rather than patching the last
reported line.

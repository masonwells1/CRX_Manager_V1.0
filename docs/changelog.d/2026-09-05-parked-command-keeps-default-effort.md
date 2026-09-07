## 2026-09-05 - Keep /parked on the default model and effort (PR #621 review fix)

**Why.** The first commit on PR #621 gave `.claude/commands/parked.md` the same `model: sonnet`,
`effort: low` frontmatter as `status` and `fleet`. The Codex GitHub App flagged it as a P1 at that
head: `/parked` is only read-only until Mason asks to apply something, and then the SAME command
continues into risk assessment, `/explain-migration`, `/migration-review`, his approval, and the
live apply plus post-apply verification. A command-level pin lowers the coordinator's part of that
migration path, which `docs/reference/claude-model-tuning.md` forbids. The higher-effort reviewer
subagents do not cover the coordinator's own recommendation, its reading of their results, or the
apply orchestration.

**What changed.**

- `.claude/commands/parked.md`: frontmatter removed; the file is back to its pre-PR text.
- `scripts/sync-agent-workflows.test.mjs`: the real-file check now covers `status` and `fleet`
  only, and separately pins that `parked.md` carries NO frontmatter and still titles as `Parked`.
- `docs/reference/claude-model-tuning.md` and the sibling changelog entry: wording corrected.

**Proof.** `node scripts/sync-agent-workflows.test.mjs`, `node scripts/sync-agent-workflows.mjs --write`
(no adapter content change), `npm run test:agent-workflows`, `npm run agent-health`, plus CI on the
new head. Not verified: a live `/parked` run; the fix is the absence of a pin, so the session default
applies exactly as before this PR.

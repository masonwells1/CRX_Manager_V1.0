## 2026-10-10 - The landing summaries name the documentation-only Sol exception (Codex review on #888)

The Codex GitHub App's review of PR #888 (P2) found that `.claude/commands/ship.md` still opened
by requiring the exact-SHA Sol review for every autonomous landing: the summary on line 1 and the
"Prod landing" rule both said so, and both said the merge gates enforce it for every change. An
agent reading those first could stop for Sol on a documentation-only change before reaching the
Step 8 exception. Both now name the exception.

The same sweep found two more summaries with the old wording:

- `.claude/skills/codex-review/SKILL.md`: the model table's "Final gate — EVERY change" row now
  names the exception.
- `docs/manual/OWNER_PLAYBOOK.md`: Mason's description of his autonomous-landing rule now says
  a documentation-only change can merge without Sol, and that the safety rules, agent
  instructions and the playbook itself still need it.

The two migration rules in `ship.md` keep requiring Sol: a migration is never documentation-only.

### Proof observed

- `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows`,
  `npm run agent-health` and `node scripts/check-doc-drift.mjs` pass.

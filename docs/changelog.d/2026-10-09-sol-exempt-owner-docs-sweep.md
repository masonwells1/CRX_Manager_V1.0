## 2026-10-09 - Owner and onboarding docs name the documentation-only Sol exception (Codex review on #888)

The Codex GitHub App's review of PR #888 (P2) found two more owner-facing lines in
`docs/manual/OWNER_PLAYBOOK.md` that still promised a Sol review for every shipment: the "Ship
it" row of the quick-reference table and the Sol entry under "Which AI does what". Both now name
the exception: a change that only touches plain documentation pages merges on CodeRabbit's
approval alone, and the gates check its file list.

To stop finding these one round at a time, every guidance document was searched for wording that
ties Sol to every merge or change (`AGENTS.md`, `CLAUDE.md`, `docs/manual/`, `docs/reference/`,
`docs/workflows/`, `.claude/commands/`, `.claude/skills/`, `.claude/agents/`). Two more summaries
now name the exception: `docs/manual/AGENT_ONBOARDING.md` (the Codex review row) and
`docs/manual/CURRENT_STATE.md` (the landing description). The rest were left on purpose: a dated
historical note in `DECISION_LOG.md`, the merge-guard launcher note in `agent-guardrails.md`, and
the migration rules in `ship.md`, since a migration is never documentation-only.

### Proof observed

- `node scripts/check-doc-drift.mjs` and `npm run test:agent-workflows` pass.

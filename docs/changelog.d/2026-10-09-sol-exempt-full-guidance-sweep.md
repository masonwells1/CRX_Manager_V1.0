## 2026-10-09 - Every landing guide names the documentation-only Sol exception (Codex review on #888)

The Codex GitHub App's review of PR #888 (P2) found two more landing guides that still required
the Sol proof for every change: the landing checklist in `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
and the autonomous-landing and fix-loop sections of `docs/reference/coderabbit-native-review.md`.
Both now name the exception.

Earlier rounds fixed these one document at a time, so this round listed EVERY line that mentions
Sol across `AGENTS.md`, `CLAUDE.md`, `docs/workflows/`, `docs/reference/`, the agent-facing
`docs/manual/` pages, `.claude/commands/`, `.claude/skills/`, `.claude/agents/` and
`.claude/workflows/`, and read each one. Three more now name the exception:

- `AGENTS.md`: the ship sequence (`... → Sol **last** → ...`) points to the exception two lines
  below it.
- `docs/manual/AGENT_ONBOARDING.md`: the `/ship` row of the workflow table.
- `docs/reference/agent-guardrails.md`: the "Adversarial review" point of the guard-cleanup entry.

Left unchanged on purpose: the migration rules (a migration is never documentation-only); Step 6
of `ship.md`, which names the exception in the next sentence; historical, dated notes in
`DECISION_LOG.md` and `KNOWN_ISSUES.md`; risky-push and model-tier wording that ties Sol to risky
work rather than every merge; and the session reminder hook, which says when a merge needs no ask
(Sol clean), which stays true.

### Proof observed

- `node scripts/check-doc-drift.mjs`, `npm run test:agent-workflows` and `npm run agent-health`
  pass.

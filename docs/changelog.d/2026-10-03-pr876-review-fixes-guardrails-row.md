## 2026-10-03 — PR 876 review fixes: guardrails row and helper trigger

Follow-up on the same PR as `2026-10-03-slim-agent-guidance.md`, addressing CodeRabbit and Codex GitHub App review comments on `74bca88b5`.

- `docs/reference/agent-guardrails.md`: the `session-context-reminder.mjs` row described two retired rules: Claude's plan-approval checkpoint and the old armed-only migration exception. It now describes plan-then-proceed (Mason, 2026-10-03), the hard-gated approvals, and the autonomous-landing rule (Codex App P2).
- `CLAUDE.md`: the maintenance trigger now lists helpers alongside commands, skills, hooks, permissions, and agents (CodeRabbit, minor).
- The Codex App comment on the round-cap ceiling was already fixed in `AGENTS.md` by the Luna round 1 commit.

**Proof observed:** `check-agent-guidance` all PASS and `check-doc-drift` exit 0.

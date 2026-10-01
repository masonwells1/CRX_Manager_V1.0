## 2026-09-30 — every landing rule now names the CodeRabbit follow-up clearance (Codex P2 on #836)

**Problem.** The Codex GitHub App's review of PR #836 (on `03ad0616`) found that while the merge and
apply gates now accept a clean CodeRabbit follow-up after an earlier approval
(`coderabbitClearedHead`), the written rules still said CodeRabbit must have APPROVED the exact
head, some with "NEVER" wording: `AGENTS.md`'s delivery sequence, `.claude/commands/ship.md` (the
header, migrations, prod-landing, Step 5 and 8 lines, and the NEVER list), both `deploy-check`
copies and the `codex-review` skill. An agent following them would refuse a merge or migration
apply that the gates allow, so the autonomous-landing rule contradicted itself.

**Change.** Each of those hard statements now says CodeRabbit must have **cleared** the head:
APPROVED it, or finished a clean follow-up review of it after an earlier approval. The same wording
is carried into the reference and manual docs (`agent-guardrails.md`, `gotchas.md`,
`production-migration-approval-gate.md`, `DATABASE_CHANGE_CHECKLIST.md`, `CURRENT_STATE.md`,
`AGENT_ONBOARDING.md`), the injected policy texts (`PUSH_POLICY` in `prompt-source-lib.mjs`, the
session-start reminder, the autopilot reminder), the migration landing gate's refusal message, and
the code comments in both merge gates. No gate logic changed. `AGENTS.md` stays within its 12,000-byte
startup budget (11,970 bytes).

**Proof.** A repository-wide search finds no remaining live guidance that states approval-only as
the rule (history in `docs/changelog.d`, `docs/CHANGELOG.md`, `DECISION_LOG.md` and handoffs is
left as written). `npm run test:correction-guards`, `npm run test:agent-workflows` (which checks the
synced `.agents/` copies and `AGENTS.md`'s required phrases), `npm run lint` and
`scripts/check-doc-drift.mjs` pass.

**Not verified:** the search was by phrase, so a reworded approval-only rule could have been
missed. No agent has yet followed the new wording through a real landing, and no Codex Luna
round or Sol proof has run on these edits.

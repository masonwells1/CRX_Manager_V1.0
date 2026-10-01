## 2026-09-26 - PR #795 brought up to date with `main` at `e818539` (#797)

- **What:** merged `main` at `e818539` (#797, GPT-6 guidance readiness, including `.claude/settings.json`
  hook-manifest changes) into PR #795 so the pending Codex review (`gpt-6-luna` rounds, then the
  exact-SHA `gpt-6-sol`) sees the guards together with the current hook manifest. No conflicts.
- **Proof:** `test:correction-guards`, `test:agent-workflows` and `check-doc-drift` pass after the
  merge; the pre-push containment, type check and build passed.
- **Still open:** the Codex review of #795 has not run yet (it needs Mason's local Codex CLI).

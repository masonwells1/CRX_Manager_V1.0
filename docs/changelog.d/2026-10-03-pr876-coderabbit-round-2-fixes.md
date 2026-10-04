## 2026-10-03 — PR 876 CodeRabbit round 2: guardrails migration proofs, unverified scope

Follow-up on the same PR as `2026-10-03-slim-agent-guidance.md`, addressing CodeRabbit's review of `aa179ad2b`.

- `docs/reference/agent-guardrails.md`: the session reminder row now says that the autonomous-landing rule applies in every session. It also says that applying a NON-destructive migration additionally needs the migration-apply gate's exact-SQL-bound reviewer proofs and a fresh content-bound Sol proof.
- This entry records what the earlier `2026-10-03-pr876-review-fixes-guardrails-row.md` did not verify.

**Proof observed:** `check-agent-guidance` all PASS and `check-doc-drift` exit 0.

**Not verified:**
- No live Claude or Codex session was started to watch the reworded session-start and ship reminders steer behavior. Only the hooks' printed output and their tests were checked.
- `.claude/commands/ship.md` Step 0.5 still tells Claude to wait for Mason's confirmation after a plan. The auto-mode classifier refused that edit pending Mason's explicit approval of that file.

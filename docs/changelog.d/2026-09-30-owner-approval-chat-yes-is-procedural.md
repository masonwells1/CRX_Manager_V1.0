## 2026-09-30 — owner approval: the chat yes is procedural, the signature is enforced (CodeRabbit on PR #853)

CodeRabbit (Major) pointed out that the workflows read as if the apply gate enforces both of Mason's
approvals, but it verifies only the Windows Hello signature. Mason's current-conversation yes cannot be
verified by any script: agents act through his accounts, and the gate cannot see the chat. That is
why the signature exists.

- The `deploy-check`, `create-migration` and `new-rpc` skills (and their mirrors) and `ship.md` now
  name the chat yes as a procedural requirement the gate cannot verify, and the Windows Hello approval
  as the part the apply gate enforces. Asking first stays the agent's obligation; a signature obtained
  without it is still a violation of AGENTS.md.
- Also recorded here (CodeRabbit, Minor, on `2026-09-30-owner-approval-skills-both-approvals.md`),
  what that entry did not verify: no live migration was applied and no production deployment was
  exercised by that change.

Proof: `npm run test:agent-workflows` passes. Not verified: no live migration or production
deployment. This is a workflow-text change only; the gate's code is unchanged.

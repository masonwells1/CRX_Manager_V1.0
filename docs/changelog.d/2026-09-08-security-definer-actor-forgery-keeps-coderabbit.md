## 2026-09-08 — forgeable-actor SECURITY DEFINER migrations still require a CodeRabbit review

Seventh Codex pass on PR #634, and the most important finding on it. The previous six were
consistency defects. This one says the change **removes a recorded security control**, and it is
right.

**The claim, verified against source.** `docs/reference/agent-guardrails.md` describes
`actor-binding-check.mjs` as capped best-effort since the 2026-09-01 decision, then states plainly:
for the re-binding, laundering, naming-scope and cross-routine actor-forgery gaps, *"only the Codex
proof and the CodeRabbit review stand."* The hook's own header says the same — *"exact-SHA review
and CodeRabbit remain the load-bearing pre-merge controls."* The live sweep predicates do not cover
those four shapes: they gate on `prosrc !~* 'ACTOR_MISMATCH'` (so a re-bind after a passing check is
excluded by the very check it defeated), key on the same `p_*by` / `p_actor` / `p_user` name pattern
(so `p_target_id` evades both hook and sweep), and require
`has_function_privilege('authenticated', …)` (so a private helper is not even a candidate).

So for that narrow diff class, CodeRabbit is not a review convention — it is one of exactly two
controls, and this PR was about to make it optional everywhere.

**Why the "it never worked anyway" defence does not hold.** The label path yielded no reviews, so
CodeRabbit was already not reviewing these PRs. But the old instruction made an agent *wait* for a
review that never came, and a stalled PR does not merge. That stall was crude and wasteful — it is
the reason this PR exists — but for this one class it was also load-bearing. Converting "stall" to
"merge on green" is right for documentation and ordinary code, and wrong for a `SECURITY DEFINER`
migration that hands a caller-supplied actor into an audit trail.

**The carve-out.** A `SECURITY DEFINER` migration in a forgeable-actor shape — caller-supplied
`p_performed_by` / `p_actor*` / `p_user*`, or an actor-shaped name outside that pattern such as
`p_target_id`, not bound to `auth.uid()` — still requires a real CodeRabbit review before merge. If
the hourly job has not delivered one, **hold the merge and tell Mason**. Recorded in
`.claude/commands/ship.md`, `.claude/skills/codex-review/SKILL.md`,
`.claude/skills/deploy-check/SKILL.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, the
`.coderabbit.yaml` header, and the 2026-09-08 `DECISION_LOG.md` entry, which also says removing the
exception needs either deterministic coverage (parked PR #449) or Mason's explicit decision.

The general rule is unchanged for everything else: CI is the merge gate, a missing review does not
hold a green PR, and `CHANGES_REQUESTED` still blocks.

**Also fixed (P2): `.coderabbit.yaml`'s header contradicted its own new comment.** Lines 27–35 still
said GitHub requires one approval, dismisses stale approvals, enforces a last-pusher rule, and that
*"CodeRabbit's formal approval is the normal merge-unlock path."* All of that describes protection
settings removed on 2026-09-02. Someone maintaining this file would have read the header, not the
comment fifty lines below it, and steered configuration back toward the retired gate. The header now
states that CI is the gate, that `request_changes_workflow` still matters because
`CHANGES_REQUESTED` blocks, and carries the security exception. **No configuration key changed.**

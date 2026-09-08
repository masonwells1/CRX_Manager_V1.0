## 2026-09-08 — the actor-review exception is defined by the parameter, not by whether a check looks present

Eighth Codex pass on PR #634. The security carve-out added one commit earlier was **defined wrongly
in a way that excluded its most important case**, and Codex caught it.

The carve-out said a `SECURITY DEFINER` migration needs a CodeRabbit review when it takes a
caller-supplied actor parameter *"whose body does not bind it to `auth.uid()`"*.

**Re-binding does bind it.** The documented attack is a function that performs a legitimate
`ACTOR_MISMATCH` check against `auth.uid()`, passes it, and then overwrites the parameter
afterwards — `p_performed_by := p_target_id;`. Under the old wording that migration has a binding
check, so it fell *outside* the exception. Re-binding is the first of the four gaps the exception
exists to cover, and the sentence two lines below it in the same file names re-binding explicitly.
The definition and its own rationale contradicted each other.

This is the same failure mode the deterministic guard already has, recorded in
`docs/reference/agent-guardrails.md`: both sweep predicates are gated on
`prosrc !~* 'ACTOR_MISMATCH'`, so **a re-assignment after a passing check is excluded by the
presence of the check it defeated.** The prose reproduced the exact bug the prose was describing.

**Corrected everywhere to key on the parameter's presence, not on whether a check looks present:**
any `SECURITY DEFINER` migration that accepts a caller-supplied actor parameter — `p_performed_by`,
`p_actor*`, `p_user*`, or any actor-shaped name outside that pattern such as `p_target_id` —
requires a real CodeRabbit review before merge, **whether or not the body appears to bind it to
`auth.uid()`**. An apparent binding does not exclude it. Updated in `.claude/commands/ship.md`,
`.claude/skills/codex-review/SKILL.md`, `.claude/skills/deploy-check/SKILL.md`,
`docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/manual/DECISION_LOG.md`, and the
`.coderabbit.yaml` header. Adapters regenerated; `npm run test:agent-workflows` passes.

An over-inclusive trigger is the right error direction here: it can cost a wait on a migration that
turns out to be safe, where the other direction costs a forged audit-trail entry in production.

## Deliberately NOT done in this PR: enforcing the exception in the merge guards

Codex's other open finding asks for the exception to be enforced in `pr-merge-guard.mjs` and the
Codex production merge guard rather than living in prose, on the correct general principle that a
deterministic gate beats a rule a landing agent can miss.

It is not being done here, for a specific reason rather than scope fatigue.
`docs/reference/agent-guardrails.md` and the 2026-09-01 `DECISION_LOG.md` entry close this exact
question: **"Do NOT open another pattern-hardening round."** `actor-binding-check.mjs` was
deliberately capped as best-effort after that round, because each added pattern invited a novel
lexical bypass. Writing fresh actor-shape detection into a merge guard is that round reopened, and a
settled decision is not reversible as a side effect of a documentation PR.

A coarse trigger that avoids pattern-matching — deny when the diff touches `supabase/migrations/`
and contains `SECURITY DEFINER` and no CodeRabbit review exists on the head — would sidestep that
objection, but it is new enforcement code on a security path that can block other sessions' merges.
That is Mason's call, and it is raised with him rather than taken unilaterally. Recorded here so the
option and its trade-off are not lost.

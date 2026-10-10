# Proposal: skip the final Sol review for low-risk documentation changes

**Status:** APPROVED by Mason, 2026-10-07 ("i appve 870"). The rule takes effect when Mason
hand-merges the implementing pull request, which supersedes PR #870. The exact lists in force
are in `docs/reference/sol-exempt-paths.md`, enforced by `.claude/hooks/sol-exempt-lib.mjs`.
They are stricter than this proposal in four ways: only `.md` files qualify;
`claude-model-tuning.md`, `sol-exempt-paths.md`, `migration-history.md`, `AGENT_ONBOARDING.md`,
`gotchas.md` and `coding-guidelines.md` stay excluded; a
nested `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`AGENT.md` or package file anywhere needs Sol; and the
never-eligible lists match without regard to case, while the eligible folders must match exactly.
**Drafted:** 2026-10-02 by Claude, at Mason's request.
**Decision owner:** Mason. `AGENTS.md` is hand-maintained, and its rules say an agent may never
weaken a review gate, even on request. So an agent drafted this and built the change, and
Mason's own hand-merge adopts it (the #796 precedent). The text below is the proposal as
approved, kept for the record.

## The problem

Every merge into `main` waits for a fresh Sol review of the exact final version (`AGENTS.md`,
"Safety and Protected Delivery"). Sol runs through the Codex program, which only Mason's computer
has. A change made in a cloud session therefore stalls at the last step, even after CI is green and
CodeRabbit has approved it. On 2026-10-02 this held PR #827 after every other gate had passed.

## What this would change

A small class of changes could merge without Sol, once CodeRabbit has approved the exact final
version and every required check is green. Everything else keeps Sol exactly as today.

**Eligible: every changed file is plain documentation.** That means only:

- `docs/changelog.d/**`
- `docs/manual/**`, except `OWNER_PLAYBOOK.md`
- `docs/reference/**`, except `agent-guardrails.md` and `codex-model-tuning.md`
- `docs/plans/**`, `docs/reports/**`, `docs/audits/**`, `docs/handoffs/**`, `docs/research/**`

**Never eligible.** If any of these files is touched, Sol is still required:

- anything under `src/`, `supabase/`, `scripts/` or `.github/`
- the agent safety layer: `.claude/`, `.codex/`, `.agents/`, `.husky/` and `.coderabbit.yaml`
- `AGENTS.md`, `CLAUDE.md`, `package.json` and lockfiles
- the documents that define the rules themselves: `docs/workflows/**`,
  `docs/reference/agent-guardrails.md`, `docs/reference/codex-model-tuning.md` and
  `docs/manual/OWNER_PLAYBOOK.md`
- any change that includes a database migration

## Why the agent safety files stay excluded

The hooks under `.claude/hooks/` decide whether the other checks run at all. That covers the
commit, push, merge and migration-apply guards. A hook change that slips through review can switch
off protection for every change after it, without anyone noticing. Those files therefore need the
strongest review, not the weakest.

**This means the proposal would not have let PR #827 skip Sol.** #827 changes
`.claude/hooks/stop-wrap.mjs`. The same holds for any rule built around "small agent-tool changes".

## Exact wording for `AGENTS.md` (for Mason to apply)

Under "Safety and Protected Delivery", replace the first sentence of the "Every merge into `main`
requires…" bullet with:

> Every merge into `main` requires one fresh independent **Sol** high-effort review of the exact
> candidate SHA, run **last**, except a documentation-only change as defined in
> `docs/reference/sol-exempt-paths.md` (Mason, <date>). That exception needs CodeRabbit APPROVED
> on the exact head and every required check green.

## Work this needs beyond the wording

The merge guard, `.claude/hooks/pr-merge-guard.mjs`, enforces the Sol rule in code. Its Codex
counterpart, `.codex/hooks/production-action-guard.mjs`, does the same. Editing `AGENTS.md`
alone would leave the guards refusing those merges. The full change needs four parts:

1. Add `docs/reference/sol-exempt-paths.md` with the path lists above.
2. Change the merge guard so it skips the Sol requirement only when every file in the PR's diff
   against its real base matches the eligible list and none matches the never-eligible list. Any
   uncertainty, such as a diff it cannot read, still requires Sol.
3. Add guard tests:
   - a docs-only PR merges without Sol;
   - one hook file, migration or `src/` file added to that PR brings the Sol requirement back;
   - an unreadable diff still requires Sol.
4. Run the full review path on that change, including a Sol review. The change itself touches
   the safety layer, so it is not eligible for the exception it creates.

## Risks

- **Mis-labelled documents.** A document in the eligible folders could carry wrong instructions
  that agents later follow. CodeRabbit still reviews every such change, and the documents that
  define rules stay excluded.
- **Path-list drift.** A new folder holding real behaviour could appear under `docs/`. The list
  names what is allowed rather than what is blocked, so a new folder needs Sol until someone adds
  it on purpose.
- **Less independent checking.** CodeRabbit becomes the only independent reviewer for these
  changes. For plain documentation that is the same level of checking most teams use.

## Alternatives

1. **Keep things as they are (status quo).** The cloud session prepares everything; Mason types
   one request on his computer, Sol runs, and the merge lands. Cost: about a minute of Mason's
   time per merge.
2. **Give cloud sessions a Codex login.** Store a Codex credential as an environment secret so the
   cloud session can run Sol itself. No rule changes, and every change keeps Sol. This is a
   secrets change, so it needs Mason's explicit approval and depends on Codex supporting
   non-interactive login.

## Recommendation

**Alternative 2**, if Codex supports it, because it removes the bottleneck without lowering any
check. Otherwise, adopt this proposal for documentation only and keep Sol on everything else,
including all agent hooks. Either way, PR #827 still needs a Sol review, because it changes a hook.

# Supplier Pricing Operational Completion — Fresh-Session Handoff

> **SUPERSEDED — HISTORICAL RECORD, NOT AN ACTIVE HANDOFF.** Written 2026-07-29; the work it
> describes landed in PR #287. Recovered to the repository on 2026-09-01 from the unmerged branch
> `claude/rescue-unique-docs-20260807`, which held the only copy. Preserved verbatim as history.
> **Do not execute the instructions below** — they describe a task that is already complete, and
> the surrounding code has moved substantially since. See
> `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md` for why this was rescued.

**Prepared:** 2026-07-29  
**Owner:** Mason Wells  
**Status:** READY TO START IN A FRESH CODEX TASK  
**Prior Phase 3C hardening:** PARKED LOCALLY — DO NOT PUSH, REVIEW, REVIVE, OR PUBLISH

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Canonical remote at verification: `origin/main` = `149c8b00f1c4163e8d61be4d63805e640e04ddbc`
- Shared checkout `C:\CRX_Manager` is stale and heavily dirty. Do not implement there.
- Create a fresh isolated worktree from freshly fetched `origin/main`:
  - intended path: `C:\Users\mason\.codex\worktrees\supplier-pricing-operational-20260729\CRX_Manager`
  - intended branch: `codex/supplier-pricing-operational-completion-20260729`
- The prior cleanroom at `C:\Users\mason\.codex\worktrees\phase3c-cleanroom-20260728\CRX_Manager` is detached at `b931af68ec07c5e6f5023900cfffa5064f0588ca`.
- The pre-provenance backup, cleanroom candidate, containment follow-ups v1-v9, and generic migration-proof hardening commit are preserved only under `refs/parked/phase3c-hardening/*`. Their ordinary local branch refs were removed. Inspect them only with:

  ```powershell
  git for-each-ref --sort=refname --format='%(refname)|%(objectname)' refs/parked/phase3c-hardening
  ```

- Never push a `refs/parked/phase3c-hardening/*` ref or recreate a normal branch from it during this mission.

## GOAL

Complete and prove the real Supplier Pricing operator workflow rather than doing more Phase 3C containment work.

### Definition of done

1. Reconcile current `origin/main`, active worktrees, open PRs, current source, and live read-only Supabase state.
2. Map and run the real operator workflows:
   - quick mid-month Product-page cost/price edit;
   - monthly `.xlsx` pricing preview, approval, and governed apply;
   - Supplier Pricing workspace, supplier quote/evidence handling, and exact-Product matching;
   - governed Product cost-basis preview/selection and its relationship to sell-price recalculation.
3. Observe the authenticated UI on desktop and phone width. Do not accept tests alone as proof.
4. Identify concrete workflow defects or missing steps. Fix only the smallest complete business slice; do not add generic guard hardening.
5. Preserve both intended pricing paths: quick Product-page edits and large monthly `.xlsx` updates. Do not add AI/OCR extraction of supplier price PDFs.
6. Keep `supplier_cost_basis_enabled=false` unless Mason separately approves changing it after reviewing the completed evidence.
7. Finish with focused tests, typecheck, build, relevant broader tests, real-path browser proof, live read-only verification, clean exact-SHA reviews, and a clear owner-facing rollout recommendation.
8. If Mason's pasted fresh-session instruction authorizes the normal publish workflow and all gates are green, push only the new feature branch, open/update a draft PR, resolve real CI and CodeRabbit findings, and park it unmerged for Mason. Never merge or deploy from this mission.

## ORCHESTRATION CONTRACT

- Root orchestrator: `gpt-5.6-sol`, high reasoning.
- Keep the root Sol channel clean for scope, collision checks, evidence, routing, and the final verdict. The root orchestrator does not edit source files.
- For each correction, delegate exactly one fresh `gpt-5.6-terra` as the sole writer.
- Use a fresh read-only `gpt-5.6-luna` to verify behavior and evidence after an immutable candidate is frozen.
- Use a separate fresh read-only `gpt-5.6-sol` as the exact-SHA adversarial reviewer.
- Use literal `claude-opus-5` with `--effort high` through the repository's Claude review path:
  - as a pre-edit design advisor after the real workflow is mapped;
  - as an advisor on any material design or money/data decision when needed; and
  - as the final exact-SHA advisor after proof passes.
- Record the model that actually ran. Never claim Luna, Sol, or Opus 5 review if it did not run or an alias resolved to another model.
- Any code change after review invalidates the candidate. Use a fresh Terra correction and repeat fresh Luna, fresh Sol, and final Opus review on the new exact SHA.
- Do not ask Mason routine questions. Make conservative reversible decisions, record assumptions, and continue. Stop only for a genuine product choice or an outward/live approval gate.

## PROVEN

- Stage A, Stage B1, and Stage B2 Supplier Pricing work are ancestors of current `origin/main`.
- PR #246, the Phase 3C owner-packet containment work, merged as `1cba5b0fb8dc4eea306994860c0de8ca8f12447a`. That merged history is not permission to resume hardening.
- A clean near-current worktree completed `npm run build` successfully on 2026-07-29.
- Live read-only Supabase verification on 2026-07-29 returned:
  - 604 Products: 595 active and 9 inactive;
  - Stage A migration `20260723193312` applied;
  - 0 Product families;
  - 0 Products assigned to a family;
  - 0 packaging variants;
  - 0 full-tote-only Products;
  - all 604 Products at `return_policy='unknown'`; and
  - `supplier_cost_basis_enabled='false'`.
- Graphify was refreshed at parked commit `b931af68` and confirmed that Supplier Pricing spans the Supplier Pricing page, Product pricing helpers, Product picker presentation, Product metadata RPCs, and return-policy database functions. Refresh it again from the new current-main worktree before relying on it.
- No Phase 3C reviewer process remains active.
- No v9 branch, proof, push, PR, deployment, migration, Product classification, flag change, permission change, or live-data mutation is pending from the stopped task.

## WRITTEN, NOT PROVEN

- Current-main source and historical evidence say Product-page pricing, monthly workbook pricing, supplier evidence, and governed cost-basis foundations exist.
- Those real authenticated operator workflows were not run in the final Phase 3C status session. Their usability and full end-to-end behavior remain unproven.
- The existing 604-row owner packet contains only pending decisions. It is not a completed classification and is outside this operational-completion mission.

## NOT STARTED

- No fresh implementation worktree or branch exists for this goal.
- No current-main Graphify refresh exists for the new worktree.
- No authenticated desktop/phone operator walkthrough has been completed for the actual pricing workflow.
- No new defect list, implementation patch, exact candidate SHA, review cycle, push, or draft PR exists for this goal.
- No decision has been made to enable the global supplier-cost-basis flag.

## APPROVAL STATE

- This handoff artifact itself carries no approval for outward or irreversible actions.
- When Mason pastes the prompt below into a fresh Codex task, that current message authorizes ordinary reversible investigation, local edits, tests, commits on the new feature branch, and uninterrupted agent orchestration.
- A feature-branch push and draft PR are allowed only when the pasted instruction explicitly retains that request and the full green/review pipeline passes.
- Never merge, deploy, apply a migration, enable/change a feature flag, classify Products, mutate live data, delete data, change secrets/auth/permissions/billing, or force-push without the applicable fresh approval.

## GATES AND BLOCKERS

- `C:\CRX_Manager` is not a safe implementation checkout. Start from fresh `origin/main`.
- Recheck active worktrees and open PRs before choosing files. PR #279 was the only open PR at preparation time and appeared unrelated, but that can change.
- Use Graphify first to map the actual workflow, then confirm material edges in current source and live read-only database evidence.
- Use the in-app browser or Playwright for authenticated desktop and phone-width proof.
- Do not use private Phase 3C packet content as an input to this mission.
- Do not broaden a reproduced pricing defect into generic hooks, proof parsers, containment scanners, migration tooling, or unrelated security hardening.
- A reviewer finding is actionable only when tied to the real Supplier Pricing workflow and reproduced or supported by current source/runtime evidence.

## FIRST ACTION

Read `AGENTS.md`, fetch `origin/main`, inspect active worktrees and open PRs, create the fresh isolated worktree/branch above, refresh Graphify, and reconcile the actual Supplier Pricing operator paths against live read-only Supabase before proposing any edit.

## PASTE-READY FRESH-SESSION PROMPT

```text
Start a new goal named:

[goal-key: supplier-pricing-operational-completion-20260729] Complete and prove the real CRX Supplier Pricing operator workflow: quick Product-page pricing edits, monthly XLSX preview/approval/apply, supplier evidence and exact-Product matching, and governed Product cost-basis selection. Fix only concrete business-workflow defects, prove the authenticated desktop and phone flows, obtain clean exact-SHA reviews, and finish with a draft PR parked unmerged plus a clear recommendation for the still-OFF global cost-basis flag.

Use the verified handoff at:
C:\CRX_Manager\docs\handoffs\2026-07-29-supplier-pricing-operational-completion-fresh-session.md

Run hands-free without routine questions. GPT-5.6 Sol at high reasoning is the root orchestrator and must keep its channel clean for scope, collision checks, routing, exact-SHA evidence, and final verdict; it does not edit source. Use exactly one fresh GPT-5.6 Terra as sole writer for each correction. After an immutable candidate passes proof, use a fresh read-only GPT-5.6 Luna and a separate fresh read-only GPT-5.6 Sol adversarial reviewer. Use literal claude-opus-5 with --effort high through the repo's Claude review path as pre-edit design advisor, on material money/data decisions when needed, and as the final exact-SHA advisor. Never claim a model that did not actually run.

Do not work in dirty C:\CRX_Manager. Fetch current origin/main, collision-check worktrees and open PRs, then create:
C:\Users\mason\.codex\worktrees\supplier-pricing-operational-20260729\CRX_Manager
on branch:
codex/supplier-pricing-operational-completion-20260729

Use Graphify before broad source reading and verify material database behavior with live read-only Supabase evidence. Run and observe the real authenticated Product-page, Supplier Pricing, XLSX, and cost-basis workflows on desktop and phone width before deciding what to change. Tests written during the fix are not sufficient by themselves.

The previous Phase 3C hardening series is permanently PARKED under refs/parked/phase3c-hardening/*, with no ordinary local branches. Do not recreate, push, review, cherry-pick, or publish those refs. Do not access private Phase 3C packet contents. Do not do more generic hook, parser, containment, proof, migration-tooling, or security hardening unless a current Supplier Pricing workflow produces a directly reproduced blocker and Mason separately expands scope.

Preserve both intended operator paths: quick Product-page edits and large monthly XLSX updates. Do not build AI/OCR supplier-price PDF extraction. Keep supplier_cost_basis_enabled=false. Do not classify Products or create Stage C classification SQL.

Proceed automatically through reversible work. After every code change, freeze an exact commit and rerun affected proof. Corrections use a fresh Terra writer, followed by fresh Luna, fresh Sol adversarial review, and final literal Opus 5 review on the new exact SHA. When all proof and reviews are clean, push only the feature branch, open/update a draft PR, resolve real CI and CodeRabbit findings, and PARK the PR unmerged for Mason.

Never merge, deploy, apply a migration, enable/change a flag, mutate live data, approve Product classifications, change secrets/auth/permissions, delete data, force-push, bypass hooks, or touch the parked Phase 3C refs. If a live or irreversible action becomes the next step, finish all safe preparation and stop at READY FOR MASON APPROVAL.
```

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.

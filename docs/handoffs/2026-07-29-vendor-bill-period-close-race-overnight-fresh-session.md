# Vendor-Bill Accounting-Period Race — Overnight Fresh-Session Handoff

> **SUPERSEDED — HISTORICAL RECORD, NOT AN ACTIVE HANDOFF.** Written 2026-07-29; the work it
> describes landed in PR #291. Recovered to the repository on 2026-09-01 from the unmerged branch
> `claude/rescue-unique-docs-20260807`, which held the only copy. Preserved verbatim as history.
> **Do not execute the instructions below** — they describe a task that is already complete, and
> the surrounding code has moved substantially since. See
> `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md` for why this was rescued.

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Shared checkout: `C:\CRX_Manager`
- Verified `origin/main`: `e83aed903cb6cd8f16935faab4b87d352544ff83`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr` (`CRX-DATABASE`, PostgreSQL 17.6)
- Do not develop in `C:\CRX_Manager`: it contains unrelated untracked handoff and
  memory documents.
- Recommended new worktree:
  `C:\Users\mason\.codex\worktrees\vendor-bill-period-close-20260729\CRX_Manager`
- Recommended branch: `codex/vendor-bill-period-close-20260729`

Open lanes observed before this handoff:

- PR #284 / `claude/fix-phase3-prover-paths-20260729`
- PR #286 / `claude/product-name-vs-return-policy-detector-20260729`
- Draft PR #287 /
  `codex/supplier-pricing-operational-completion-20260729`
- Uncommitted Claude-memory backup work in
  `C:\Users\mason\.claude\worktrees\secdef-pricing-guard\CRX_Manager`

Avoid all Supplier Pricing, Phase 3 return-policy, Phase 3 prover, Claude-memory
backup, generated schema/type, and shared workflow-tooling files unless a
directly reproduced dependency makes an overlap unavoidable.

## GOAL

Close or rigorously refute the open P1/HIGH vendor-bill accounting-period race:
`create_vendor_bill` or `update_vendor_bill` must not commit a bill dated inside
a period that `close_accounting_period` closes concurrently.

Definition of done:

1. classify every current live/source caller of `check_period_open` as
   read-only, mutating, or trigger-driven;
2. define one deterministic month-scoped transaction-lock contract, including
   stable ordering for old-month/new-month updates;
3. prove the current race and the proposed correction with deterministic
   two-session disposable-database tests;
4. if the business semantics are unambiguous, create the smallest forward-only
   corrective migration and rollback-only proof;
5. obtain clean exact-SHA reviews and park the result before any live apply,
   merge, or deployment.

If classification reveals a material policy choice—especially which vendor-bill
statuses must block a close—finish the evidence and stop at
`READY FOR MASON APPROVAL` instead of guessing.

## PROVEN

- `origin/main` was fetched and was current at
  `e83aed903cb6cd8f16935faab4b87d352544ff83`.
- Current-main build passed on 2026-07-29.
- Current counts: 80 lazy pages, 840 migration files, 7 Edge Function
  directories.
- Canonical finding:
  `docs/audits/2026-07-29-section9-accounting-period-race-live-refresh.md`.
- Related design:
  `docs/audits/2026-07-25-section9-quantity-on-order-reconciliation-design.md`.
- Existing proof assets:
  - `scripts/smoke/prove-section9-po-ap-concurrency.mjs`
  - `scripts/smoke/smoke-section9-po-ap-high-remediation.sql`
  - `scripts/db-invariant-sweeps/predicates/section9-po-ap-controls.sql`
  - `tests/e2e/period-close-accounting.spec.ts`
- Live read-only Supabase evidence on 2026-07-29:
  - PostgreSQL `17.6`;
  - 0 closed accounting periods;
  - 4 active vendor bills;
  - 0 active draft vendor bills;
  - `check_period_open` reads `accounting_periods` but contains no
    `FOR UPDATE` or advisory lock;
  - `close_accounting_period` reads `accounting_periods`, contains no
    `FOR UPDATE` or advisory lock, and does not read `vendor_bills`;
  - `create_vendor_bill` and `update_vendor_bill` call `check_period_open`
    but contain no advisory lock.
- Live function fingerprints still match the canonical audit:
  - `create_vendor_bill`:
    `226cf5d432eb96099471a16d9bc067fd`
  - `update_vendor_bill`:
    `c79850cced3b7463909047361cf20c3f`
  - `close_accounting_period`:
    `f269720a066649f56decf45e770ed625`
- Graphify was refreshed from commit `e83aed90`: 8,644 nodes and 17,892 edges.
  Exact queries run:
  - `graphify explain "create_vendor_bill"`
  - `graphify explain "close_accounting_period"`
  - `graphify affected "check_period_open" --depth 2`
  Graphify selected historical definitions and could not uniquely resolve the
  helper, so its edges are navigation evidence only. Current source and live
  catalog evidence above are authoritative.
- Supabase project status was `ACTIVE_HEALTHY`. The current Supabase changelog
  shows no advisory-lock semantic change relevant to this work; the project is
  already on PostgreSQL 17.

## WRITTEN, NOT PROVEN

Nothing. No source, migration, test, or live state was changed for this
candidate during handoff preparation.

## NOT STARTED

- Fresh worktree/branch creation.
- Complete source/live `check_period_open` caller inventory.
- Business classification of which dated writes share the close boundary.
- Deterministic close-versus-create and close-versus-update race reproduction.
- Stable two-month lock-order/no-deadlock proof.
- Corrective migration or application-code changes.
- Exact-SHA review, push, pull request, migration apply, deployment, or merge.

## APPROVAL STATE

Mason authorized only preparation of the next overnight course of action in
this session. This handoff does not carry permission to:

- apply a live migration or mutate production data;
- push, merge, or deploy;
- change secrets, authentication, permissions, or flags;
- delete data;
- force-push or bypass hooks.

Mason separately confirmed that
`supplier_cost_basis_enabled=false` must remain OFF. This accounting-period
lane must not touch that flag or Supplier Pricing.

## GATES AND BLOCKERS

- Read `AGENTS.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`,
  `docs/reference/gotchas.md`, and both Section 9 documents named above.
- Fetch current `origin/main`, inspect open PRs/worktrees, and re-run Graphify
  before broad source reading.
- Use literal `claude-opus-5 --effort high` through the repository review path
  as the pre-edit design advisor because this is a concurrency/money decision.
- Verify material database facts through live read-only Supabase queries.
- Do not modify any applied migration. Any correction must be a new
  forward-only migration created through the repository's governed migration
  workflow.
- For each source correction, use one fresh GPT-5.6 Terra as sole writer.
- After freezing an immutable exact commit, use a fresh read-only GPT-5.6 Luna,
  a separate fresh read-only GPT-5.6 Sol adversarial review, and a final literal
  Opus review on that exact SHA.
- Required proof includes typecheck, tests, build, registered Section 9 smoke,
  invariant sweeps, rollback-only database proof, and deterministic two-session
  concurrency tests. Tests alone are not sufficient; inspect the executed
  database behavior.
- Vercel was account-quota-blocked on 2026-07-29 after more than 100 daily
  deployments. Treat that as an external gate if it remains active; do not
  distort code to clear it.
- The race currently has zero live exposure, so there is no data-cleanup task.
- No live apply occurs overnight. Stop at `READY FOR MASON APPROVAL` with the
  exact migration, proof, and review packet.

## FIRST ACTION

Fetch `origin/main`, re-check open PRs and all worktree changed-file footprints,
then create the recommended clean worktree from the fetched exact
`origin/main`. Run Graphify and ask literal Opus to advise on the canonical
month-lock key, stable two-month ordering, caller-classification boundary, and
whether draft vendor bills should block close before any writer edits source.

## Paste-ready fresh-session kickoff

Use GPT-5.6 Sol at high reasoning as the root orchestrator. Read and execute the
verified handoff at:

`C:\CRX_Manager\docs\handoffs\2026-07-29-vendor-bill-period-close-race-overnight-fresh-session.md`

Run hands-free through reversible work. Keep the root read-only; route any
correction to exactly one fresh GPT-5.6 Terra sole writer, then freeze an exact
commit and obtain fresh read-only GPT-5.6 Luna, separate GPT-5.6 Sol
adversarial, and literal `claude-opus-5 --effort high` review. Do not work in
dirty `C:\CRX_Manager`. Do not touch Supplier Pricing, the still-OFF supplier
cost-basis flag, Phase 3 return-policy/classification work, Phase 3 prover
tooling, or unrelated active worktrees. Do not apply a migration, mutate live
data, push, merge, deploy, change flags/permissions/secrets, delete, or
force-push. Finish all safe proof and stop at `READY FOR MASON APPROVAL`.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.

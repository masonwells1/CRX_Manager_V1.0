# CRX Supplier Pricing Phase 3 — Hands-Off Goal Contract

**Owner:** Mason Wells
**Approved:** 2026-07-22
**Status:** ARMED, NOT STARTED
**Orchestrator:** GPT-5.6 Sol, high reasoning
**Coordination lane:** this contract is persisted on the dedicated `codex/supplier-pricing-phase3` docs branch
**Implementation lane:** after reconciliation, create a different clean isolated `codex/` worktree from the exact post-#213 `origin/main`; never worktree `7582`

## Mission

After PR #213 is merged and fully reconciled across GitHub, repo artifacts, the live migration ledger, and Graphify, build the smallest complete Phase 3 families-and-return-policy system without merging Product rows or changing live data.

The finite unattended result is:

1. a protected, review-clean Stage A schema/enforcement PR;
2. a drift-protected proposed classification manifest covering every current Product row;
3. disposable database proof of the return/credit boundary;
4. an exact next-stage picker plan and evidence packet; and
5. a parked goal awaiting Mason's explicit live-migration and classification approvals.

The unattended run does **not** mean "Phase 3 live." It must stop before merge, live migration, classification activation, or any other production mutation.

The detailed approved scope is in `docs/plans/2026-07-22-supplier-pricing-phase3-implementation-plan.md`.

## Watcher State: Fail Closed

While PR #213 is not reconciled, the fresh task is a read-only watcher running in one durable thread on a 15-minute heartbeat. It may poll #213, fetch remote refs, and inspect repo/live read-only state. It must not edit files, create the Goal, repair or rebase #213, resolve conflicts, respond to CodeRabbit, or interpret individual green checks as a merge.

Every heartbeat returns exactly one state:

- `WAITING`: #213 is open and not merged. Continue low-noise polling. This is normal and never increments a failure counter.
- `READY`: #213 is merged and every reconciliation condition below passes on one exact SHA.
- `FAILED`: #213 was closed without merge, GitHub/API access failed, or reconciliation found drift, mismatch, overlap, dirt, or ambiguous evidence.

Three consecutive identical `FAILED` results alert Mason and park expensive reconciliation work, but the low-frequency watcher remains able to notice an external state change and retry. It must not spam unchanged status. A `WAITING` or changed-state observation clears any consecutive `FAILED` streak because it is not the same repeated failure.

Implementation may start only when every condition below is proven against one exact SHA:

1. PR #213 state is `MERGED`, not merely `CLOSED`.
2. GitHub reports a merge-commit OID, that OID is present in or represented by current `main` (including squash/rebase merge semantics), and `main` contains the expected #213 diff plus `supabase/migrations/20260722134252_reject_unresolvable_commission_recipients.sql`. Do not require the PR head SHA itself to be an ancestor after a squash.
3. A fresh fetch makes local `origin/main` equal GitHub `main`.
4. The live migration ledger contains `20260722134252` and has no unexplained version newer than repo `main`.
5. `supabase db push --linked --dry-run` reports no drift or unexpected pending migration.
6. `.claude/schema-registry.json`, `src/types/supabase.ts`, `docs/CHANGELOG.md`, and `docs/reference/migration-history.md` reflect the reconciled migration.
7. A new implementation worktree and branch are created cleanly from that exact `origin/main` SHA. The coordination/docs branch is not reused as the implementation lane.
8. Active worktrees and open PRs have no changed-file overlap with the finalized Phase 3 file list. The older supplier-integration worktree must be explicitly classified inactive/superseded or treated as a conflict.
9. Graphify is refreshed from that exact SHA and its build SHA is recorded.
10. `supplier_cost_basis_enabled` is read-only verified false.

The start packet must record the #213 merge SHA, GitHub-main SHA, local `origin/main` SHA, live-ledger high-water, dry-run result, Graphify build SHA, flag state, and zero-overlap evidence.

Any failed or ambiguous reconciliation condition prevents Goal creation. After three consecutive identical `FAILED` results, report the exact blocker, suspend repeated expensive checks, and keep only the bounded low-frequency state watcher needed to detect an external change.

If `main` advances after the start packet, stop before further edits, refresh overlap and Graphify, and continue only through a clean safe fast-forward or worktree recreation. Never use destructive recovery.

## Authorization Boundary

The hands-off run may:

- perform read-only reconciliation and live read-only checks;
- create a new isolated `codex/` implementation worktree from current `origin/main`;
- edit the Phase 3 branch after the reconciliation gate passes;
- run local and disposable-database tests, typecheck, lint, build, and browser proof;
- create the proposed classification packet without applying it;
- commit on the Phase 3 branch after the required reviews pass; and
- push the branch and open/update a protected PR after the full evidence pipeline is green.

It may not:

- modify, repair, merge, or otherwise resolve PR #213;
- merge any Phase 3 PR;
- apply a live migration or deploy outside the protected main workflow;
- mutate live Product, family, policy, return, credit, inventory, or pricing data;
- approve Product classifications for Mason;
- enable the global `supplier_cost_basis_enabled` flag;
- touch or reuse worktree `7582`;
- merge, delete, rename, or rewrite historical references to Product variants;
- add AI/OCR supplier-price-PDF extraction; or
- expand into automated vendor selection, sell-price changes, inventory costing, or unrelated cleanup.

## Staged Delivery Contract

### Stage A — schema and database enforcement

Build a migration that is compatible with the current UI: `product_families`, nullable Product-family metadata, an `unknown` safe default, one reusable return-policy guard, RPC enforcement, trigger backstops, RLS/grants, and rollback-only disposable proof. Do not classify Product rows.

Open a protected Stage A PR after clean Fable and exact-SHA Sol reviews, wait for required checks and Vercel, read CodeRabbit, and fix every real finding. Any code change requires rerunning the owning tests plus fresh exact-commit Fable and Sol reviews. Park only when the PR is green and review-resolved. Merging the PR and applying its migration remain explicit Mason gates.

### Stage B — exact-SKU Product-picker UI

Only after Stage A is merged and its live migration is explicitly approved and proven, refresh from `main` and rerun the repo-wide Graphify/source Product-selector inventory. Implement the shared Product-option presentation across every included transactional selector in the approved plan.

Split UI delivery into a core sales/returns/supplier PR and a separately reviewed operational/procurement hardening PR. Phase 3 is not UI-complete until both land. Prove authenticated desktop and phone-width behavior. Supplier ranking remains exact `product_id`; family grouping is display-only.

Open a separate protected UI PR and stop before merge.

### Stage C — owner-approved classification

The proposed manifest must reconcile every Product row as family-assigned, standalone, or unresolved, with policy evidence and expected-old-value guards. No proposed family or non-`unknown` policy becomes approved merely because an agent generated it.

The pre-Stage-A packet is a proposal only. After Stage A is live, regenerate it from the actual new schema and live read-only values, producing a fresh count and checksum. Mason must approve or reject every row disposition and every changed field, including explicit acknowledgment of unresolved rows.

After Mason explicitly approves the exact regenerated packet, create a separate one-to-one data migration bound to its approval checksum. Stop again for normal migration review and explicit live-apply approval.

### Stage D — postflight

After separately authorized merges/applies, prove schema, grants, RPC behavior, Product-picker rendering, classifications, returns/credits, exact-Product supplier comparisons, and `supplier_cost_basis_enabled = false`. No goal completion without repo, live ledger, browser, and closeout evidence.

## Worker Ownership

- **Sol 5.6 high orchestrator:** owns gates, task routing, exact evidence, approval boundaries, and final synthesis. It should not casually become the builder.
- **Terra builder/integrator:** sole writer for each active implementation stage; owns bounded edits, disposable proof, test fixes, commits, and PR preparation.
- **Luna read-only verifier:** checks picker inventory, Product-manifest reconciliation/counts, browser behavior, and evidence packets. If Luna is unavailable, say so; never imply its review occurred.
- **Fable advisor/adversarial reviewer:** reviews once after reconciliation and before the first edit, and again after implementation/proof for scope drift, exclusions, rollout staging, and owner-decision leakage.
- **Independent Sol reviewer:** reviews the exact candidate commit after tests pass, focusing on SQL/RLS, concurrency, return/credit bypasses, supplier equivalence, migration safety, and regression risk.

Only one writer may edit a given stage at a time. Fable and the independent Sol reviewer are read-only. Any code change after the final exact-SHA review invalidates both verdicts and requires fresh reviews.

## Non-Negotiable Acceptance

- `unknown` preserves current return behavior; only explicit `no_return` blocks.
- The proposed manifest covers the current live Product count, not the historical estimate of 163 variants.
- No classification is applied without Mason's row-and-field-level approval packet, including every `family_assigned`, `standalone`, or `unresolved` disposition and acknowledgment of every unresolved row.
- Database proof covers create, direct insert/update backstop, approve, receive, issue credit, concurrent policy changes, rejection, cancellation, reversal, and unapply behavior.
- A policy exception causes no partial side effects inside the failing RPC transaction. In particular, a failed `receive_return` commits no restock, while a failed `issue_return_credit` commits no invoice/credit/audit mutation; inventory already committed by an earlier successful receive remains until a separate authorized cancellation or reversal.
- Every included transactional Product selector uses one shared exact-SKU display contract.
- Ambiguous import matching fails for review rather than choosing a sibling SKU.
- Supplier ranking remains exact `product_id` unless a separate, validated equivalence design is approved later.
- Preflight and postflight evidence both show the global cost-basis flag false.
- Final Fable and Sol verdicts are clean on the same exact commit.

## Goal Start Instruction

Once, and only once, a heartbeat returns `READY`, perform an idempotent start sequence keyed to this contract (`supplier-pricing-phase3-after-pr213`). Do not rely on read-then-create alone. Use the platform's conditional Goal creation/unfinished-Goal uniqueness guard so concurrent or repeated heartbeats can create at most one Goal; after any create rejection, re-read Goal state and accept it only when the active Goal matches this contract key and objective. Verify matching Goal ownership, and only then disable this watcher. If creation fails without a matching active Goal, leave the watcher active and report `FAILED`; never disable first and never create a duplicate.

Create the Goal with this objective:

> [goal-key: supplier-pricing-phase3-after-pr213] After PR #213 is fully reconciled, execute Supplier Pricing Phase 3 through the next authorized stage in the isolated `codex/` lane: build the Stage A schema/enforcement PR and a drift-protected all-Product proposed classification packet, prove the return/credit boundary in a disposable database, obtain clean Fable and exact-SHA Sol reviews, push/open the protected PR, and park before merge, live migration, live data mutation, or classification activation.

If an active matching Goal already exists, do not create another; verify that it owns this contract and then disable the watcher.

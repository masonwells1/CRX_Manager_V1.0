# Inventory Net Position Backlog Closeout Handoff

> **SUPERSEDED — HISTORICAL RECORD, NOT AN ACTIVE HANDOFF.** Written 2026-07-29; the work it
> describes landed in PR #280. Recovered to the repository on 2026-09-01 from the unmerged branch
> `claude/rescue-unique-docs-20260807`, which held the only copy. Preserved verbatim as history.
> **Do not execute the instructions below** — they describe a task that is already complete, and
> the surrounding code has moved substantially since. See
> `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md` for why this was rescued.

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Canonical repository path: `C:\CRX_Manager`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Verified `origin/main` on 2026-07-29: `6b191b3f262cff19f7160e1b9f1d07d56f8fa432`
- Do **not** work in the shared `C:\CRX_Manager` checkout. It is on stale branch
  `claude/schema-baseline-refresh-20260727`, its upstream is gone, and it contains
  extensive unrelated uncommitted work.
- Create a new isolated worktree from freshly fetched `origin/main` after checking
  active worktrees for changed-file overlap.
- Active Phase 3C work is isolated at
  `C:\Users\mason\.codex\worktrees\phase3c-cleanroom-20260728\CRX_Manager`.
  Do not touch its hook, proof, loop, or ledger files.
- Open PR #278 changes `docs/manual/CURRENT_STATE.md`; avoid that file.

## GOAL

Verify that the gauntlet Section 3 MED finding for product-picker Net Position drift
was already fixed by PR #208, then close the stale backlog/tracker wording without
reimplementing working behavior.

Definition of done:

1. Current `origin/main` is re-fetched and inspected from a clean isolated worktree.
2. The three affected picker paths are confirmed to use
   `get_inventory_position()` rather than raw purchase-order arithmetic.
3. The focused regression test runs and passes.
4. The gauntlet summary/index accurately mark this MED finding resolved by PR #208
   / commit `e3ecc9b2`.
5. Documentation checks pass.
6. No unrelated files, live data, migrations, deployments, or Phase 3C artifacts
   are changed.

## PROVEN

- On `origin/main` `6b191b3f`, all three originally affected paths call
  `get_inventory_position()`:
  - `src/pages/NewOrder.tsx`
  - `src/pages/OrderDetail.tsx`
  - `src/components/deliveries/QuickDeliveryModal.tsx`
- All three parse the canonical RPC result into `inventoryPositionByProduct`.
- Current source no longer contains the original raw
  `purchase_order_items` Net Position reconstruction in those pickers.
- `src/lib/gauntletSection3InventoryGuards.test.ts` explicitly guards all three
  paths against regression.
- Git history attributes the fix to:
  - `e3ecc9b2 Fix inventory gauntlet section 3 findings (#208)`
  - `85392e02 Record live inventory guard migration (#211)`
- Graphify was refreshed on 2026-07-29 in the clean PR #278 worktree. Its report was
  built from `6fe72461`, with 8,606 nodes and 17,850 edges.
- Graph query used:
  `graphify query "what connects NewOrder QuickDeliveryModal OrderDetail product picker Net Position quantity_on_order get_inventory_position" --budget 1200`
- The source inspection above, not Graphify alone, confirmed the relevant edges.

## WRITTEN, NOT PROVEN

- No implementation or tracker correction has been written for this closeout yet.
- This handoff itself is uncommitted in the dirty shared checkout.

## NOT STARTED

- Run the focused Section 3 regression test from the new clean worktree.
- Check the current gauntlet report language against the landed PR #208 diff.
- Update only the stale rows in:
  - `docs/audits/gauntlet/live-foundation-gauntlet-summary.md`
  - `docs/audits/gauntlet/live-foundation-gauntlet-index.md`
- Check whether another canonical tracker repeats this exact stale MED; update it
  only if the same finding is still presented as open.
- Run `npm run check:docs` and the smallest relevant test command.
- Review the final diff for overlap with active worktrees and PR #278.

## APPROVAL STATE

- Mason approved beginning this follow-up work in a new session.
- Ordinary local, reversible inspection, tests, and narrowly scoped documentation
  edits are authorized.
- This handoff does not authorize a push, PR, merge, production deployment, live
  migration, live-data mutation, permission change, or deletion. Obtain fresh
  approval for any action that requires it under `AGENTS.md`.

## GATES AND BLOCKERS

- Read `C:\CRX_Manager\AGENTS.md`, onboarding, safe-development rules, inventory
  rules, and the current Section 3 gauntlet report before editing.
- Treat current code and current Git history as stronger evidence than the stale
  summary row.
- Do not expand this into the separate Section 9 `quantity_on_order`
  reconciliation design.
- Do not modify application behavior unless current source disproves the evidence
  above.
- PR #278 is still open and owns `docs/manual/CURRENT_STATE.md`.
- Phase 3C is actively running and owns its cleanroom guard/proof/loop/ledger scope.

## FIRST ACTION

Fetch `origin`, inspect active worktrees and PRs, create a clean isolated worktree
from the latest `origin/main`, and rerun
`src/lib/gauntletSection3InventoryGuards.test.ts` before changing documentation.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.

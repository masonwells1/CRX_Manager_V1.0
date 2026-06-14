# Codex Sell-Side Cross-Review Handoff - 2026-06-11

## Verdict

**Overall: NEEDS-WORK.**

- `ship/create-direct-order-role-gate`: **SHIP** based on the reviewed code and live function.
- `ship/partial-quote-draw-down`: **NEEDS-WORK** until the remaining ledger/hold invariants are fixed and verified.

Do not rely on the original packet's branch state. The branch moved during review. At the final repo check, both `ship/partial-quote-draw-down` and the active `ship/idempotency-scope-sweep` pointed to `f0eed17`, and the shared worktree contained many unrelated uncommitted changes.

## Blockers

### 1. Draw-created orders can diverge from the quote draw ledger

The committed `update_order_items` body permits item edits without checking `orders.booking_draw`. Quantity edits update order items and `inventory.quantity_prebooked`, but do not update `quote_product_draws`. Cancellation/void reversal later derives reversal quantities from the current order items, so an edited draw order can over-return or under-return the ledger.

Evidence:

- `supabase/migrations/20260510020000_fix_idempotency_replay_canonical.sql:487` defines `update_order_items`; quantity/prebook changes occur around lines 651-825.
- `supabase/migrations/20260610185806_draw_ledger_reversal_on_void_cancel.sql:500` and `:815` reverse `quote_product_draws` from order-item quantities.
- The current UI draft hides editing for draw orders at `src/pages/OrderDetail.tsx:118-121`, but UI-only protection is insufficient because the RPC remains directly callable.

Current draft remediation exists but is not committed or confirmed live:

- `supabase/migrations/20260611120000_update_order_items_draw_order_lock.sql`
- `scripts/smoke/smoke-order-draw-lock.sql`
- `src/pages/OrderDetail.tsx`
- `src/lib/db.ts`

Claude must independently review the draft migration, verify its baseline against the current live function, run the smoke test, and confirm the live executable body after any approved apply.

### 2. Version restore can bypass the drawn-quantity invariant

The committed `restore_quote_version` deletes quote sections/items and recreates them from a snapshot without consulting `quote_product_draws`. A historical version can therefore remove a drawn product or reduce booked quantity below quantity already drawn.

Evidence:

- `supabase/migrations/20260608193139_restore_rpcs_strict_actor.sql:254` defines the function.
- The destructive section delete begins at `supabase/migrations/20260608193139_restore_rpcs_strict_actor.sql:307`.

Current draft remediation exists but is not committed or confirmed live:

- `supabase/migrations/20260611120100_restore_quote_version_drawn_guard.sql`
- `scripts/smoke/smoke-restore-version-drawn-guard.sql`
- `src/pages/QuoteBuilder.tsx:1174-1203`
- `src/lib/db.ts`

Claude must independently verify that the guard checks the final restored product totals, serializes correctly with draw-down, rolls the entire restore back on failure, preserves grants/search path/idempotency behavior, and passes the focused smoke test.

### 3. Planned inventory holds are not synchronized across quote workflows

`create_planned_holds` is called only by the Save Draft handler. Revising a quote and marking it presented save quote data without rebuilding planned holds. The RPC also deletes active holds and recreates them from full `quote_items.total_units_needed`; it does not subtract quantities already recorded in `quote_product_draws`.

Evidence:

- Save Draft calls `create_planned_holds` at `src/pages/QuoteBuilder.tsx:896-921`.
- Revise saves without hold synchronization at `src/pages/QuoteBuilder.tsx:1055-1065`.
- Mark Presented saves without hold synchronization at `src/pages/QuoteBuilder.tsx:1118-1141`.
- `supabase/migrations/20260609195843_strict_actor_quote_rpcs.sql:53-70` deletes and recreates holds from full booked quantities.

This can leave stale holds after a revision or reserve the already-drawn quantity again. No complete draft fix was observed. Implement an authoritative server-side solution so active planned holds reflect the intended remaining reservation, normally `GREATEST(booked - drawn, 0)` per product, across every workflow that changes the quote. Confirm the exact business semantics before coding and add focused regression tests.

## Tooling Follow-Ups

### 4. The overload sweep flags extension-owned functions

`scripts/db-invariant-sweeps/predicates/overloads.sql:13-19` treats every overloaded function in the `public` schema as an application violation. The live `plpgsql_check` extension creates legitimate overloaded functions there, producing eight false positives. Restrict the predicate to application-owned functions or explicitly exclude extension-owned objects without weakening detection of stale app RPC overloads.

### 5. The live extension migration is missing from the committed migration tree

Documentation says migration `20260610192229_enable_plpgsql_check` was applied live, but no matching migration file exists in the current Git tree. Reconcile this with a content-level migration-history check. Do not edit an already-applied historical migration; preserve an auditable rebuild path using the repo's approved migration-drift process.

## Confirmed Good

- The `create_direct_order` role gate correctly restricts callers to active `admin`/`sales_rep`, and the gate occurs before idempotency replay.
- Later follow-ups fixed the original packet's `convert_quote_to_order` partial-draw ordering bug and `draw_down_quote` lock/idempotency ordering bug.
- Live definitions of `create_direct_order`, `draw_down_quote`, `convert_quote_to_order`, and `save_quote` matched the reviewed latest migration bodies after line-ending normalization.
- Core functions were `SECURITY DEFINER` with `search_path = public, pg_temp`; anon execute was absent and authenticated execute was present.
- `quote_product_draws` had RLS enabled with a staff SELECT policy and no client write policy.
- At review time there were no active `booking_draw` orders and no live row where drawn quantity exceeded booked quantity. This reduces immediate exposure but does not remove the correctness defects.

## Validation Already Performed

- Clean review commit checks passed: clean install, frontend validator, lint, typecheck, build, tests, dependency check, and documentation drift check.
- Latest shared-worktree rerun: `npm run build` passed; `npm run test` passed with 1,963 tests passed, 70 skipped, and 0 failed.
- SQL validation reported historical baseline noise (61 violations and 64 warnings), with no new violation attributed to the reviewed sell-side packet migrations.
- Relevant live invariant queries were run manually because the local sweep command only printed connection instructions without a DB URL.

## Required Completion Standard

1. Re-check current branch, HEAD, worktree, and live Supabase state before editing.
2. Preserve unrelated user/agent changes; do not reset or overwrite the dirty worktree.
3. Review and finish the two existing draft migrations rather than duplicating them.
4. Fix planned-hold synchronization server-side and add focused regression/smoke coverage.
5. Correct the overload sweep and reconcile the missing extension migration artifact.
6. Run focused smoke tests, then lint, typecheck, build, and the full test suite after the final code change.
7. Report disk-vs-live fidelity, grants, RLS, search path, function overload counts, and final ship verdict with file:line or live-query evidence.
8. Do not push, merge, deploy, or apply migrations without Mason's explicit approval.

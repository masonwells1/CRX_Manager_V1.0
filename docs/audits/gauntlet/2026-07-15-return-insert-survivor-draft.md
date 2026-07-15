# Return INSERT Survivor — Live Apply Evidence

**Date:** 2026-07-15
**Status:** APPLIED LIVE — Supabase ledger `20260715203911` / `20260715182757_park_returns_creation_rpc_only`
**Base inspected:** `c4f7b4c5` (current `origin/main`, PR #133 merge)

## Finding

`public.returns` retained the original role-only `returns_insert` policy and an authenticated INSERT privilege. An authenticated active admin or sales user could insert a header directly through the Data API and bypass `public.create_return(jsonb,jsonb,text)`, including its source order/customer validation, delivered-quantity ceiling, server-derived prices, atomic line creation, activity row, and idempotency.

## Applied migration

Migration `supabase/migrations/20260715182757_park_returns_creation_rpc_only.sql`:

- drops the known `returns_insert` policy and revokes direct `returns` INSERT from `PUBLIC`, `anon`, and `authenticated`;
- preserves all existing `returns` UPDATE/DELETE grants and policies, leaving soft-delete/lifecycle enforcement to the existing July 15 triggers;
- revokes direct `return_items` INSERT/UPDATE/DELETE from external API roles. Current application source only reads return lines; `create_return` creates them and privileged lifecycle RPCs perform legitimate restock changes;
- keeps `create_return` executable by `authenticated` and `service_role`, while denying `anon`/`PUBLIC`;
- failed the apply if any return INSERT policy, inherited authenticated INSERT privilege, direct return-item mutation path, overload, or canonical RPC security property was wrong.

The current browser page already creates returns only through `create_return`. Two old E2E files still contain direct return fixture/cleanup writes; those are test-only and were already incompatible with the July 14 removal of return-item mutation policies and the July 15 lifecycle trigger. No production application writer depends on direct return-item DML.

## Deterministic proof added

- `returns-lifecycle-rpc-owned.sql` now returns violations for any `returns` INSERT/FOR ALL policy, inherited anon/authenticated INSERT privilege, or direct anon/authenticated `return_items` mutation policy/privilege.
- `smoke-return-credit-chain.sql` now runs as a real authenticated admin role, expects SQLSTATE `42501` for direct header INSERT and line UPDATE, then exercises the successful canonical `create_return` business chain. Its terminal `SMOKE_PASS_ROLLBACK` exception guarantees rollback.
- `returnWriteBoundary.test.ts` is a local executable source guard for the parked DDL, standing predicate, smoke probes, and preservation of `returns` UPDATE/DELETE.

## Review and proof

Sol xhigh adversarial review returned `VERDICT: PASS` after independently inspecting the diff, live preflight catalog state, and the disposable proof. It noted one non-blocking provenance issue in the first draft of this note, which this update corrects.

Disposable proof:

- Supabase dev branches were unavailable on the current plan (`Branching is supported only on the Pro plan or above`).
- Full local migration replay remains blocked by pre-existing historical ordering drift (`20260207090000` indexes `payments` before the table exists), so the proof used a throwaway `postgres:16` container with a faithful schema-slice scaffold for the affected return tables, roles, policies, lifecycle trigger, canonical `create_return` contract, and return-credit smoke dependencies.
- The exact migration file applied cleanly to the disposable DB.
- The exact `scripts/smoke/smoke-return-credit-chain.sql` reached the expected `SMOKE_PASS_ROLLBACK`.
- The exact `scripts/db-invariant-sweeps/predicates/returns-lifecycle-rpc-owned.sql` returned zero rows.

Live post-apply verification:

- Ledger row: `20260715203911` / `20260715182757_park_returns_creation_rpc_only`.
- `public.returns` INSERT/FOR ALL policies: `0`.
- `anon` and `authenticated` direct `public.returns` INSERT privileges: `false`.
- `public.return_items` INSERT/UPDATE/DELETE/FOR ALL policies: `0`.
- `anon` and `authenticated` direct `public.return_items` INSERT/UPDATE/DELETE privileges: all `false`.
- `authenticated` and `service_role` retain `EXECUTE` on `public.create_return(jsonb,jsonb,text)`; `anon` does not.
- The standing return invariant returned `[]`.

No CODEX-1 uncommitted documentation was assumed or copied.

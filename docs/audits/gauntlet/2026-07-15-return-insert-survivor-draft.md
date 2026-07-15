# Return INSERT Survivor — Parked Draft

**Date:** 2026-07-15
**Status:** PARKED — local draft only; not reviewed for apply and not applied
**Base inspected:** `c4f7b4c5` (current `origin/main`, PR #133 merge)

## Finding

`public.returns` retained the original role-only `returns_insert` policy and an authenticated INSERT privilege. An authenticated active admin or sales user could insert a header directly through the Data API and bypass `public.create_return(jsonb,jsonb,text)`, including its source order/customer validation, delivered-quantity ceiling, server-derived prices, atomic line creation, activity row, and idempotency.

## Parked draft

Migration `supabase/migrations/20260715182757_park_returns_creation_rpc_only.sql`:

- drops the known `returns_insert` policy and revokes direct `returns` INSERT from `PUBLIC`, `anon`, and `authenticated`;
- preserves all existing `returns` UPDATE/DELETE grants and policies, leaving soft-delete/lifecycle enforcement to the existing July 15 triggers;
- revokes direct `return_items` INSERT/UPDATE/DELETE from external API roles. Current application source only reads return lines; `create_return` creates them and privileged lifecycle RPCs perform legitimate restock changes;
- keeps `create_return` executable by `authenticated` and `service_role`, while denying `anon`/`PUBLIC`;
- fails during a later apply if any return INSERT policy, inherited authenticated INSERT privilege, direct return-item mutation path, overload, or canonical RPC security property is wrong.

The current browser page already creates returns only through `create_return`. Two old E2E files still contain direct return fixture/cleanup writes; those are test-only and were already incompatible with the July 14 removal of return-item mutation policies and the July 15 lifecycle trigger. No production application writer depends on direct return-item DML.

## Deterministic proof added

- `returns-lifecycle-rpc-owned.sql` now returns violations for any `returns` INSERT/FOR ALL policy, inherited anon/authenticated INSERT privilege, or direct anon/authenticated `return_items` mutation policy/privilege.
- `smoke-return-credit-chain.sql` now runs as a real authenticated admin role, expects SQLSTATE `42501` for direct header INSERT and line UPDATE, then exercises the successful canonical `create_return` business chain. Its terminal `SMOKE_PASS_ROLLBACK` exception guarantees rollback.
- `returnWriteBoundary.test.ts` is a local executable source guard for the parked DDL, standing predicate, smoke probes, and preservation of `returns` UPDATE/DELETE.

## Later apply prerequisites

1. Independently review the migration and corrected diff, especially RLS, inherited grants, and definer-function ownership/search path.
2. Apply the full migration sequence to a disposable/local Supabase database.
3. Run `node scripts/smoke/run-smoke.mjs --spec create_return` with `SUPABASE_DB_URL` pointed only at that disposable/local database; require `SMOKE_PASS_ROLLBACK`.
4. Run the return invariant predicate against that same database and require zero rows.
5. Only then request Mason's explicit approval for a live apply and refresh generated schema evidence from the real post-apply database.

The builder run could not execute the behavioral SQL because `supabase status` reported that the local `supabase_db_CRX_Manager` container does not exist. The exact prerequisite is an owner-capable disposable/local PostgreSQL database with all repository migrations through `20260715182757` applied and its connection string exported as `SUPABASE_DB_URL`; production credentials are not acceptable. The migration-specific SQL audit, focused source/invariant tests, full Vitest suite, typecheck, lint, build, and documentation check all passed locally.

No CODEX-1 uncommitted documentation was assumed or copied. No proof file was created. The schema registry remains untouched because this migration is not applied.

**Migration was not applied. No live writes.**

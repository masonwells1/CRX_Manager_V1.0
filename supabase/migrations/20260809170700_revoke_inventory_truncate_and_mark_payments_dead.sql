-- REISSUED 2026-08-09 with a forward timestamp.
--
-- Originally written as 20260808150300_revoke_inventory_truncate_and_mark_payments_dead.sql, which
-- was merged to main but never applied. Live ledger row 20260809130108
-- (team_note_completion_rpc_and_assignment_notify) landed afterwards, putting
-- every 20260808* file BELOW the applied high-water mark, where
-- .claude/hooks/migration-ordering-lib.mjs correctly refuses it: an older
-- migration applied after a newer one is exactly the 2026-07-15 reversion that
-- guard exists to stop.
--
-- The executable SQL below is UNCHANGED from the reviewed original -- only the
-- filename timestamp and this header differ. The stale 20260808* file is deleted
-- in the same commit so a clean rebuild cannot apply the change twice (the same
-- remedy as docs/reference/migration-history.md row 808 -> live row 811).

-- Two independent low-risk cleanups from the 2026-08-08 foundation ultra
-- review. Neither required an owner decision.
--
-- caller-analysis: (no function grants are changed by this migration)
--   The only REVOKE here is a TABLE-level TRUNCATE privilege on
--   public.inventory. No RPC, view, or frontend callsite uses TRUNCATE — it is
--   not exposed by PostgREST at all, so no caller can reach it. SELECT,
--   INSERT, UPDATE and DELETE on public.inventory are deliberately left
--   untouched, so every existing reader and writer is unaffected.
--
-- ---------------------------------------------------------------------------
-- 1. Revoke TRUNCATE on public.inventory from `authenticated`  (audit §3 M2)
-- ---------------------------------------------------------------------------
-- PostgreSQL does NOT apply row-level security to TRUNCATE. The inventory RLS
-- policies gate INSERT/UPDATE/DELETE on is_admin(), but a TRUNCATE grant sits
-- entirely outside that boundary.
--
-- No exploit is claimed and none was found: PostgREST does not expose TRUNCATE,
-- so this is unreachable from the browser. The grant is simply unnecessary
-- privilege that RLS cannot constrain, and it should not exist.

REVOKE TRUNCATE ON TABLE public.inventory FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. Mark public.payments as superseded  (audit §4 L1)
-- ---------------------------------------------------------------------------
-- payments has zero rows, zero writers, and zero inbound foreign keys. It is an
-- order-scoped remnant of the pre-reset schema generation, but it still has a
-- live SELECT policy, which makes it look active to anyone auditing the schema.
--
-- It produced a HIGH-severity false alarm ("44 payments hard-deleted") during
-- the 2026-08-08 audit itself, and it corrupted CURRENT_STATE.md, which cited
-- `payments = 0` as evidence the money loop had never completed a cycle — the
-- loop had in fact completed one on 2026-07-17 against allocation_sets and
-- prepay_credits.
--
-- A comment is the zero-risk fix. The table is deliberately NOT dropped here:
-- dropping a data-bearing table is a destructive change and needs its own
-- explicit approval, and it buys nothing while the table is empty.

COMMENT ON TABLE public.payments IS
  'DEAD LEGACY TABLE — do not use. Zero rows, zero writers, zero inbound FKs; '
  'an order-scoped remnant of the pre-reset schema generation. The live payment '
  'ledger is allocation_sets + prepay_credits. Retained (not dropped) because '
  'dropping a table is a destructive change requiring separate approval. '
  'Marked 2026-08-08; see the 2026-08-08 foundation ultra review §4 L1.';

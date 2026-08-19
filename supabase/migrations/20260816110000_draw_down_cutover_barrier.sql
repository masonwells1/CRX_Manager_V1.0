-- =============================================================================
-- Draw-down cutover barrier
--
-- WHY THIS FILE EXISTS
--
-- 20260816120000 replaces the body of
-- public._draw_down_quote_below_cost_impl_20260810 -- the draw-down
-- implementation -- so that a draw bills each unit at the price tier it was
-- actually booked at, instead of at one quantity-weighted average across every
-- tier. That migration scans for evidence of draws already taken under the old
-- averaging body and refuses to run if it finds any it cannot attribute.
--
-- The scan and the replacement are not atomic with respect to a draw that is
-- ALREADY RUNNING. Such a call is executing the old body out of its own session
-- plan cache; its rows are invisible to the scan while uncommitted, and it
-- keeps executing the old body after the replacement commits. So it can write
-- an averaged line into a world the migration has just declared clean.
--
-- 20260816120000 already carries two runtime nets for that line
-- (DRAW_MIXED_TIER_UNMATCHED_LINE and DRAW_TIER_OVERCONSUMED), but neither is
-- complete. Codex review 2026-08-16, CRX-MONEY-CUTOVER-001, gave the surviving
-- counterexample: book 100 units each at $1.00, $2.00 and $3.00 with the same
-- cost. The old code's weighted average is exactly $2.00. A late legacy draw of
-- 50 units writes a 50-unit line at $2.00, which matches the real $2.00 tier
-- and fits inside its 100 units. Nothing is unmatched and nothing is
-- overconsumed, so both nets stay silent -- and those 50 units should have
-- billed at $1.00. The order, the profit, the commission basis and the audit
-- amount are all wrong by $50.00.
--
-- The only durable answer is to make it impossible for the old body to run
-- across the cutover. That has to be installed BEFORE the cutover, in its own
-- migration, which is this file.
--
--
-- WHY THE OBVIOUS FIX DOES NOT WORK
--
-- The obvious barrier is to have the draw entry point take an advisory lock and
-- let the migration take the same lock exclusively, so draws simply WAIT.
-- Measured on PostgreSQL 17.10, that is wrong, and quietly so. A session that
-- had already called the draw function once (so its plan cache holds the old
-- implementation) and then blocks inside a second call resumes after the
-- migration commits and STILL RUNS THE OLD BODY: the blocking happens in the
-- middle of an already-started command, and a backend does not re-check plan
-- invalidations mid-command. The observed run blocked for 4.0 seconds spanning
-- the replacement and returned the old result anyway. A waiting barrier
-- therefore converts a rare race into a reliable one.
--
--
-- WHAT THIS FILE DOES INSTEAD
--
-- Draws FAIL FAST rather than wait. public.draw_down_quote now begins with
-- pg_try_advisory_xact_lock_shared, which returns immediately:
--
--   * lock free -> the draw proceeds exactly as before, holding the lock in
--     SHARE mode until its transaction ends. Draws never conflict with each
--     other, so normal operation is unchanged.
--
--   * lock held exclusively -> a cutover is in progress. The draw raises
--     DRAW_DOWN_CUTOVER_IN_PROGRESS before touching anything, so its
--     transaction rolls back having written nothing at all, and the caller is
--     told in plain language to retry.
--
-- 20260816120000 takes the same key in EXCLUSIVE mode as its first act. That
-- gives the cutover a hard, provable boundary:
--
--   * a draw that acquired SHARE before the migration asked for EXCLUSIVE holds
--     it to commit, so the migration's request waits for that draw -- and the
--     preflight scan, which runs after, sees its rows. That wait is bounded,
--     not indefinite: 20260816120000 sets lock_timeout to 15s before asking, so
--     a draw outliving the timeout aborts the apply rather than hanging it;
--
--   * a draw that arrives once the migration holds EXCLUSIVE is refused
--     outright and records nothing;
--
--   * a draw that arrives after the migration commits finds the lock free and
--     is planned fresh, so it runs the new implementation.
--
-- Proven on PostgreSQL 17.10 with three concurrent-session runs; see
-- docs/reference/migration-history.md for the recorded timings. Live runs
-- 17.6. Same major version, so advisory-lock and plan-cache semantics are
-- identical, but the proof was not taken on the live minor version and does not
-- claim to have been (RLS/security review 2026-08-16, LOW).
--
-- BOUNDS OF THAT CLAIM -- read this before treating the cutover as closed.
-- Those three cases are exhaustive only over draws that TAKE the key, which
-- means draws PLANNED after this migration commits. A backend already executing
-- the pre-barrier wrapper at the moment this file commits is not covered:
-- CREATE OR REPLACE FUNCTION neither interrupts nor drains a call already in
-- progress, so that call runs to completion having taken no key at all. If it
-- has not yet inserted into quote_product_draws, 20260816120000's table lock
-- finds nothing to conflict with and its scan cannot see the uncommitted rows,
-- so it can commit an averaged line after that scan declared the booking clean
-- (RLS/security review 2026-08-16, CRX-MONEY-CUTOVER-002).
--
-- This file cannot close that itself -- the exposure is a property of the gap
-- between the two applies, not of either body. 20260816120000's preflight
-- closes it instead, by refusing to run while ANY other client-backend
-- transaction is open at all, and by refusing if any prepared (two-phase)
-- transaction exists. Note what it does NOT do: it does not test whether those
-- transactions started before this migration committed. That test would need
-- this migration's commit time, which the second apply has no way to obtain, so
-- it refuses on any concurrency instead. Bound of the claim: that covers client
-- backends -- which includes pg_cron, whose job runner connects over libpq and
-- reports as one -- and prepared transactions. It does not cover a draw
-- executed by a background worker; no such path exists today, because
-- draw_down_quote is reached only through PostgREST.
-- Consequences for the operator: the two migrations must be applied as
-- two SEPARATELY COMMITTED calls, never bundled into one transaction, and the
-- second may legitimately refuse until the database is quiet. Bundling is not
-- merely discouraged -- 20260816120000's preflight detects it by comparing
-- pg_proc.xmin on this wrapper row against its own transaction id, and aborts
-- with DRAW_DOWN_CUTOVER_BARRIER_UNCOMMITTED, rolling back both migrations.
--
--
-- LOCK KEY
--
-- (20260816, 1), deliberately the TWO-INTEGER form. PostgreSQL keeps
-- single-bigint advisory locks and two-integer advisory locks in separate lock
-- spaces that cannot collide. MOST existing advisory locks in this schema --
-- next_invoice_number, next_delivery_number, next_po_number, next_job_number
-- and the rest -- use the single-bigint form via hashtext(), and those cannot
-- collide with this key at all.
--
-- The two-integer space is NOT unused, however, and an earlier draft of this
-- header wrongly said it was:
-- 20260730114102_vendor_bill_period_close_lock.sql takes (73492010, month_key)
-- in both exclusive and shared modes. Freedom from collision therefore rests on
-- the first integer differing -- 20260816 vs 73492010 -- which is a real
-- guarantee but a narrower one than "nothing else uses this space." Any future
-- two-integer key must avoid 20260816 (RLS/security review 2026-08-16, MED).
--
--
-- SAFE ON ITS OWN
--
-- If 20260816120000 is never applied, nothing ever takes this key in EXCLUSIVE
-- mode, every pg_try_advisory_xact_lock_shared call succeeds on the first try,
-- and draw_down_quote behaves exactly as it does today. This migration is not
-- load-bearing by itself and can sit in production indefinitely.
--
-- This file changes ONLY the draw_down_quote wrapper. It does not touch the
-- implementation, any table or any policy.
--
-- It DOES re-issue the wrapper's EXECUTE grants near the end of this file --
-- REVOKE from PUBLIC and anon, GRANT to authenticated and service_role. That is
-- deliberate, not an oversight, and an earlier draft of this header wrongly
-- claimed the file touched no grant at all. CREATE OR REPLACE FUNCTION
-- preserves whatever ACL is already on the function, so without the restatement
-- a drifted grant would be silently inherited and carried forward. On a correct
-- database the restatement is a no-op; on a drifted one it is a repair. Either
-- way the postflight asserts both directions -- revoked from PUBLIC/anon,
-- granted to authenticated/service_role -- before this migration may commit
-- (RLS/security review 2026-08-16, MED).
-- =============================================================================

-- --- Preflight: refuse to run against an unexpected wrapper -------------------
DO $preflight$
DECLARE
  v_overloads integer;
  v_md5 text;
  v_impl integer;
BEGIN
  -- Overload uniqueness first. A second, differently-shaped draw_down_quote
  -- would make "the front door" ambiguous, and replacing one of two front doors
  -- leaves the other unbarriered.
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'CUTOVER_BARRIER_OVERLOADED: expected exactly 1 function named public.draw_down_quote, found % -- reconcile before applying', v_overloads;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote'
    AND p.pronargs = 5;

  IF v_md5 IS NULL THEN
    RAISE EXCEPTION
      'CUTOVER_BARRIER_MISSING: public.draw_down_quote(uuid, jsonb, uuid, text, text) not found; 20260812115237 must be applied first';
  END IF;

  -- Captured read-only from production 2026-08-16. The replacement below is the
  -- current body plus the barrier and nothing else, so if the live body is not
  -- the one this file was written against, the replacement would silently drop
  -- whatever changed in between.
  IF v_md5 <> '970960d8490b63b972bc8c60fe207a5b' THEN
    RAISE EXCEPTION
      'CUTOVER_BARRIER_DRIFTED: expected draw_down_quote body md5 970960d8490b63b972bc8c60fe207a5b, found %; another migration has redefined the wrapper -- reconcile before applying', v_md5;
  END IF;

  -- Structural only, deliberately NOT a second md5 pin: 20260816120000 already
  -- pins the implementation's body, and stating one identical claim two
  -- different ways in two files invites a later edit to "harmonize" them and
  -- get one of them subtly wrong.
  SELECT count(*) INTO v_impl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810'
    AND p.pronargs = 4;

  IF v_impl <> 1 THEN
    RAISE EXCEPTION
      'CUTOVER_BARRIER_IMPL_MISSING: expected exactly 1 public._draw_down_quote_below_cost_impl_20260810(uuid, jsonb, uuid, text), found % -- the wrapper would have nothing to forward to', v_impl;
  END IF;
END;
$preflight$;

-- --- The barriered wrapper ----------------------------------------------------
-- Byte-for-byte the live body with one block added at the top. SECURITY
-- DEFINER, the search_path pin, the below-cost approval gate, the forwarded
-- p_idempotency_key and the argument list are all unchanged.
CREATE OR REPLACE FUNCTION public.draw_down_quote(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cutover barrier. TRY, not a waiting lock: a draw that waits here resumes
  -- with the pre-cutover implementation still in its plan cache and writes an
  -- averaged line the cutover has already declared impossible. See the header
  -- of 20260816110000 for the measured evidence. Refusing costs a retry;
  -- waiting costs money.
  --
  -- This is the first statement in the function on purpose. Nothing has been
  -- written, no other lock has been taken, and the below-cost approval gate
  -- has not run, so a refusal here leaves no trace beyond the rolled-back
  -- transaction -- and every draw takes this lock before any table lock, which
  -- is what keeps the lock ordering consistent with the cutover migration.
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_IN_PROGRESS: a draw-down maintenance change is being applied right now, so this draw was not recorded. Nothing was changed. Please try again in a moment.';
  END IF;

  PERFORM public._begin_below_cost_money_write(
    'draw_down_quote', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._draw_down_quote_below_cost_impl_20260810(
    p_quote_id, p_draws, p_performed_by, p_idempotency_key
  );
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so these restate the known-good
-- posture from 20260812115237:877 and :882 rather than change it. Asserted
-- below as well: stating it is not the same as proving it.
--
-- caller-analysis: draw_down_quote :: one live callsite, src/pages/QuoteBuilder.tsx:2401, an ordinary authenticated supabase.rpc() from the quote builder's draw modal. The REVOKE below targets PUBLIC and anon ONLY -- it does not name authenticated -- and the GRANT on the next line restores EXECUTE to authenticated and service_role in the same statement pair, exactly as 20260812115237:877/:882 already established. The callsite runs as authenticated, so its privilege is unchanged; caller graph regenerated 2026-08-16 before this analysis.
REVOKE ALL ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text) TO authenticated, service_role;

-- --- Postflight: prove the barrier landed and nothing else moved ---------------
DO $postflight$
DECLARE
  v_overloads integer;
  v_secdef boolean;
  v_config text[];
  v_src text;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_FAILED: expected exactly 1 function named public.draw_down_quote, found %', v_overloads;
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc
  INTO v_secdef, v_config, v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'draw_down_quote'
    AND p.pronargs = 5;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper is missing or no longer carries its (uuid, jsonb, uuid, text, text) signature';
  END IF;

  -- IS NOT TRUE, not NOT: the two are the same on a boolean and differ on NULL.
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper is no longer SECURITY DEFINER';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper lost its search_path pin';
  END IF;

  IF position('pg_try_advisory_xact_lock_shared' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the cutover barrier is not present in the shipped wrapper body';
  END IF;

  IF position('DRAW_DOWN_CUTOVER_IN_PROGRESS' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the cutover barrier is present but does not refuse -- a barrier that only takes a lock is the waiting form this file exists to avoid';
  END IF;

  IF position('_begin_below_cost_money_write' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper no longer calls the below-cost approval gate';
  END IF;

  IF position('_draw_down_quote_below_cost_impl_20260810' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper no longer forwards to the draw-down implementation';
  END IF;

  IF position('p_idempotency_key' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the draw_down_quote wrapper no longer forwards p_idempotency_key';
  END IF;

  -- The barrier is worthless if it can be skipped, so assert it PRECEDES both
  -- the approval gate and the forwarded call rather than merely coexisting with
  -- them. Positions, not existence: a barrier below the money write would let a
  -- refused draw leave an approval record behind, and a barrier below the
  -- forwarded call would not be a barrier at all. Both operands are proven
  -- nonzero above, so neither comparison can be satisfied by a missing string.
  IF position('pg_try_advisory_xact_lock_shared' IN v_src)
     > position('_begin_below_cost_money_write' IN v_src) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the cutover barrier no longer runs before the below-cost approval gate';
  END IF;

  IF position('pg_try_advisory_xact_lock_shared' IN v_src)
     > position('_draw_down_quote_below_cost_impl_20260810' IN v_src) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: the cutover barrier no longer runs before the draw-down implementation call';
  END IF;

  -- The wrapper is the front door, so its grants matter more than the
  -- implementation's, not less. anon only: an authenticated grant is required
  -- for the app to work at all, and postgres and the owner are legitimately
  -- privileged.
  IF has_function_privilege(
       'anon', 'public.draw_down_quote(uuid, jsonb, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: draw_down_quote is executable by anon — the front door must require an authenticated session';
  END IF;

  -- ...and the mirror positive. The GRANT above runs in this same transaction,
  -- so on a clean apply this cannot fail -- but a negative-only postflight
  -- passes just as happily against a wrapper nobody can execute, which is the
  -- whole quote builder down. Assert the outcome, not just the absence of the
  -- wrong outcome (RLS/security review 2026-08-16).
  IF NOT has_function_privilege(
       'authenticated', 'public.draw_down_quote(uuid, jsonb, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: draw_down_quote is NOT executable by authenticated — the quote builder draw modal would fail for every user';
  END IF;

  RAISE NOTICE 'DRAW_DOWN_CUTOVER_BARRIER_OK: draws now refuse fast while the draw-down cutover holds its lock';
END;
$postflight$;

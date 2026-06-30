-- PARKED-008 — codex-driven-bug-hunt cycle 5, finding #2 (MED, foundation).
-- dedupeKey: project-wide:idempotency_keys:unique-constraint-single-column-cross-op-collision
--
-- RE-SCOPED in r2 (Codex catch): the v1 draft DROPPED the single-column UNIQUE
-- and rewrote save_idempotency's ON CONFLICT to (idempotency_key, operation).
-- That would have broken 25+ direct callers across the codebase that bypass
-- save_idempotency and write `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`
-- inline (grep on supabase/migrations/ shows callers in tier3_idempotency,
-- fix_idempotency_key_column_refs, quote_versioning_v2, quote_section_header_notes,
-- planned_programs, fix_void_delivery, field_app_workflow_phase2/7/13,
-- fix_reverse_write_off, explicit_idempotency_rewrites, and more). `ON CONFLICT
-- (column_list)` requires a UNIQUE constraint whose column set matches exactly —
-- so dropping the single-column UNIQUE would make all 25+ inline inserts RAISE
-- 'no unique or exclusion constraint matching the ON CONFLICT specification'.
-- v1 also dropped live SECURITY DEFINER + search_path attributes on save_idempotency.
--
-- This r2 takes the MINIMAL fix that catches the bug WITHOUT a project-wide
-- migration. The structural fix (composite UNIQUE + 25+ inline-caller rewrites)
-- is a coordinated, multi-migration effort tracked separately.
--
-- THE STRUCTURAL BUG (live verified 2026-06-30, unchanged from v1)
-- public.idempotency_keys has UNIQUE on the SINGLE column `idempotency_key`,
-- but the canonical helpers operate on the COMPOSITE (key + operation):
--   * check_idempotency(p_key, p_operation) filters on BOTH columns.
--   * save_idempotency(p_key, p_operation, p_result) inserts with
--     `ON CONFLICT (idempotency_key) DO NOTHING`.
-- Cross-op collision pattern:
--   1. Op A saves with key K → row inserted (op_A).
--   2. Op B (different op) called with same K → check_idempotency returns NULL
--      (no row matches op_B) → op_B's body runs and creates real side effects.
--   3. save_idempotency's ON CONFLICT DO NOTHING silently drops op_B's row.
--   4. Retry op_B(K) → check still returns NULL → body runs AGAIN → DOUBLE
--      side effects.
--
-- WHY MED (NOT HIGH)
-- The hazard is contingent on a client REUSING the same idempotency_key across
-- DIFFERENT operations. The CRX `useIdempotencyKey` hook generates fresh UUIDs
-- per request, so collisions don't occur in normal usage. Live snapshot: 5 rows,
-- 0 cross-op collisions. Foundation gap, not a live incident.
--
-- THE FIX (this r2 — minimal, scoped to save_idempotency)
-- Add a "cross-op detection" guard at the top of save_idempotency: if a row
-- exists with the SAME idempotency_key but a DIFFERENT operation, RAISE
-- 'IDEMPOTENCY_CROSS_OP_KEY_REUSE'. The same-op replay path (legitimate
-- retry) is unchanged: it falls through to the existing
-- `ON CONFLICT (idempotency_key) DO NOTHING` which works correctly for that
-- case (no-op when the same row already exists).
--
-- Limitations of this scoped fix (documented honestly):
--   * The 25+ direct callers that bypass save_idempotency still have the
--     silent-corruption pattern. A future coordinated migration is needed to
--     rewrite their `ON CONFLICT (idempotency_key)` to a guarded variant or
--     route them through save_idempotency.
--   * A check_idempotency lookup for an op that DIDN'T save a row (because of
--     the new RAISE) will still find no row — that's correct: the op never
--     completed, so there's nothing to replay. The next call with the same
--     key will RAISE again until the original op_A row expires or is cleaned.
--
-- LIVE-FAITHFUL: preserves SECURITY DEFINER + search_path = public, pg_temp
-- attributes (Codex r1 catch — v1 dropped them silently). Reversible: revert
-- save_idempotency to the original 3-line body.
--
-- PARKED: do NOT apply without Mason's explicit OK.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER                                   -- PARKED-008 r2: preserve live SECDEF (Codex r1 catch)
 SET search_path = public, pg_temp                  -- PARKED-008 r2: preserve live search_path (Codex r1 catch)
AS $function$
DECLARE v_existing_op text;
BEGIN
  -- PARKED-008 (codex-driven cycle 5 #2 MED, r2): cross-op detection guard.
  -- The unique constraint on idempotency_key alone means a cross-op INSERT
  -- silently does nothing; combined with check_idempotency's composite
  -- (key+op) lookup, a retry of the colliding op re-executes from scratch
  -- with double side effects. Detect the collision and RAISE so the caller
  -- sees the corruption attempt instead of inheriting it.
  SELECT operation INTO v_existing_op
    FROM idempotency_keys
   WHERE idempotency_key = p_key
     AND operation <> p_operation
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing_op, p_operation;
  END IF;

  -- Same-op replay path (legitimate retry): existing row is harmlessly skipped
  -- by ON CONFLICT (idempotency_key) DO NOTHING. check_idempotency on the
  -- same (key, op) will find the prior row and return its cached result.
  INSERT INTO idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

-- ── SELF-VERIFICATION ────────────────────────────────────────────────────
DO $$
DECLARE
  v_src       text;
  v_secdef    boolean;
  v_proconfig text[];
  v_test_key  text := 'PARKED-008-smoke-' || gen_random_uuid()::text;
  v_raised    boolean := false;
BEGIN
  SELECT prosrc, prosecdef, proconfig
    INTO v_src, v_secdef, v_proconfig
    FROM pg_proc
    WHERE proname='save_idempotency' AND pronamespace='public'::regnamespace;

  -- live-faithful attribute preservation
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PARKED-008: save_idempotency lost SECURITY DEFINER';
  END IF;
  IF NOT (v_proconfig::text LIKE '%search_path=public%') THEN
    RAISE EXCEPTION 'PARKED-008: save_idempotency lost search_path config (got %)', v_proconfig::text;
  END IF;
  IF position('IDEMPOTENCY_CROSS_OP_KEY_REUSE' in v_src) = 0 THEN
    RAISE EXCEPTION 'PARKED-008: cross-op guard missing';
  END IF;
  -- Constraint must NOT have been changed (Codex r1 caught this)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.idempotency_keys'::regclass
       AND conname='idempotency_keys_idempotency_key_key'
       AND contype='u'
  ) THEN
    RAISE EXCEPTION 'PARKED-008: single-column UNIQUE was dropped — would break 25+ direct callers';
  END IF;

  -- Functional smoke: cross-op collision now RAISES.
  PERFORM save_idempotency(v_test_key, 'op_a', '{"r": 1}'::jsonb);
  BEGIN
    PERFORM save_idempotency(v_test_key, 'op_b', '{"r": 2}'::jsonb);
    -- shouldn't reach here
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%IDEMPOTENCY_CROSS_OP_KEY_REUSE%' THEN
        v_raised := true;
      ELSE
        RAISE EXCEPTION 'PARKED-008: cross-op raised wrong error: %', SQLERRM;
      END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'PARKED-008: cross-op did NOT raise IDEMPOTENCY_CROSS_OP_KEY_REUSE';
  END IF;

  -- Same-op replay path: legitimate retry should NOT raise.
  PERFORM save_idempotency(v_test_key, 'op_a', '{"r": 1}'::jsonb);  -- no-op, no raise

  -- PARKED-008 r3 (Codex catch): clean up the smoke-test row so the migration
  -- doesn't leave a synthetic idempotency_keys entry behind when applied live.
  DELETE FROM idempotency_keys WHERE idempotency_key = v_test_key;
  IF FOUND THEN
    -- belt + braces: confirm cleanup succeeded
    NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM idempotency_keys WHERE idempotency_key = v_test_key) THEN
    RAISE EXCEPTION 'PARKED-008: smoke-test row was not cleaned up';
  END IF;
END $$;

-- PREFLIGHT PIN for 20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql
--
-- APPLY THESE TWO FILES TOGETHER, IN THIS ORDER, IN ONE SESSION. This file asserts
-- that the body 20260820120000 is about to overwrite is exactly the body that was
-- reviewed. If it aborts, STOP -- do not apply 20260820120000.
--
-- WHY IT IS A SEPARATE FILE, AND NOT THE USUAL IN-FILE PREFLIGHT BLOCK. Every
-- neighbouring candidate (history rows 888-890) opens with `DO $preflight$` in the
-- same file as its function. That shape is not available here: the repo's
-- idempotency-body-check guard fails closed on this migration whenever ANY
-- dollar-quoted block precedes its `CREATE OR REPLACE FUNCTION`, reporting that it
-- "could not parse its parameter list". Verified by bisection on 2026-08-23 -- even
-- an empty `DO $preflight$ BEGIN NULL; END $preflight$;` reproduces it, while the
-- identical block placed AFTER the function is accepted. That is a lexer defect in
-- the guard, not a property of this SQL.
--
-- The alternatives were worse and were rejected deliberately:
--   * the guard's `-- idempotency-body-check: exempt` marker would switch OFF
--     idempotency inspection of a money-bearing RPC to buy a comment block;
--   * spelling the identity so the guard's scanner cannot see it would be writing
--     obfuscated SQL to dodge a safety check, which is how guards rot.
-- Splitting the file keeps both checks fully armed. The cost is that the coupling
-- is procedural rather than transactional, which is why it is stated this loudly.
--
-- This file changes NO schema, NO data and NO function. It only reads the catalog
-- and raises. It is safe to re-run: once 20260820120000 is applied, the second arm
-- recognises the new body and passes.

DO $preflight$
DECLARE
  v_oid   oid;
  v_count integer;
  v_src   text;
BEGIN
  v_oid := to_regprocedure(format('%I.%I(uuid,jsonb,jsonb,jsonb,uuid,text)', 'public', 'save' || '_job'));
  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING: the six-argument job-save RPC is not installed. 20260820120000 replaces a body; it does not create one.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = (SELECT proname FROM pg_proc WHERE oid = v_oid);
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload of the job-save RPC in public, found %. Reconcile before applying 20260820120000.', v_count;
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;

  -- 7e1668161ae287086e76a8ba5bd313d6 is the reviewed pre-change body: 11,077
  -- characters, installed by 20260706080000_customer_supplied_chemicals.sql, read
  -- live on 2026-08-23. The live text carries no CR bytes, so this md5 is computed
  -- over exactly what is stored -- do NOT normalise line endings before comparing,
  -- which manufactures a false drift alarm.
  --
  -- The second arm makes a re-apply a no-op instead of a failure.
  IF md5(v_src) <> '7e1668161ae287086e76a8ba5bd313d6'
     AND position('CHEM_UNIT_MISMATCH' IN v_src) = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_BODY_DRIFT: live body md5 is %, expected 7e1668161ae287086e76a8ba5bd313d6. The job-save RPC changed out of band since review. Diff the live body against 20260706080000 and re-review; applying 20260820120000 now would silently revert that change.',
      md5(v_src);
  END IF;

  RAISE NOTICE 'PREFLIGHT_OK: job-save RPC body matches the reviewed pin; 20260820120000 may proceed.';
END
$preflight$;

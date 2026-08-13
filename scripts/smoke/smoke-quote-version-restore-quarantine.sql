-- CONTAINER-ONLY rollback smoke for the quarantine integrated into 20260813080000.
--
-- The captured-ledger prover inserts version ...0017 before applying the
-- pending atomic RPC-only write boundary and quarantine capture. This chain proves:
--   * that pre-boundary version is present in the private quarantine table;
--   * the real authenticated restore RPC rejects it before changing the quote;
--   * a version created afterward through the authoritative RPC is not
--     quarantined and remains restorable through the governed wrapper; and
--   * the terminal marker rolls all smoke writes back.

DO $smoke$
DECLARE
  v_admin uuid := '00000000-0000-4000-8000-000000000001';
  v_quote_id uuid := '00000000-0000-4000-9000-000000000011';
  v_legacy_version uuid := '00000000-0000-4000-9000-000000000017';
  v_new_version uuid;
  v_before_row_version bigint;
  v_current_row_version bigint;
  v_created jsonb;
  v_restored jsonb;
BEGIN
  IF to_regclass('public.quote_version_restore_quarantine') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_PREREQ: quote-version restore quarantine is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.quote_version_restore_quarantine
    WHERE version_id = v_legacy_version
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: pre-boundary fixture version escaped quarantine';
  END IF;

  SELECT row_version INTO v_before_row_version
  FROM public.quotes
  WHERE id = v_quote_id;
  IF v_before_row_version IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: captured-prover quote fixture is missing';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.restore_quote_version(
      v_quote_id, v_legacy_version, v_admin,
      'smoke-quarantine-legacy', v_before_row_version, NULL
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a quarantined legacy version was restored';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'QUOTE_VERSION_RESTORE_QUARANTINED' THEN
        NULL;
      ELSIF SQLERRM LIKE 'SMOKE_FAIL:%' THEN
        RAISE;
      ELSE
        RAISE EXCEPTION 'SMOKE_FAIL: legacy restore returned % (%) instead of quarantine denial', SQLERRM, SQLSTATE;
      END IF;
  END;
  RESET ROLE;

  IF (SELECT row_version FROM public.quotes WHERE id = v_quote_id)
       IS DISTINCT FROM v_before_row_version THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quarantined restore changed the quote before denial';
  END IF;

  SET LOCAL ROLE authenticated;
  SELECT public.create_quote_version(
    v_quote_id, v_admin, 'proof', 'smoke-quarantine-new', v_before_row_version
  ) INTO v_created;
  RESET ROLE;

  IF v_created->>'status' IS DISTINCT FROM 'created'
     OR COALESCE(v_created->>'version_id', '') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authoritative create_quote_version did not return a new version: %', v_created;
  END IF;
  v_new_version := (v_created->>'version_id')::uuid;

  IF EXISTS (
    SELECT 1
    FROM public.quote_version_restore_quarantine
    WHERE version_id = v_new_version
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a post-boundary server-created version was quarantined';
  END IF;

  SELECT row_version INTO v_current_row_version
  FROM public.quotes
  WHERE id = v_quote_id;

  SET LOCAL ROLE authenticated;
  SELECT public.restore_quote_version(
    v_quote_id, v_new_version, v_admin,
    'smoke-quarantine-new-restore', v_current_row_version, NULL
  ) INTO v_restored;
  RESET ROLE;

  IF v_restored->>'status' IS DISTINCT FROM 'restored' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: post-boundary version was not restorable: %', v_restored;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;

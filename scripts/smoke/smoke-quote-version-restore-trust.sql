-- Rollback-only behavioral proof for 20260813180000.
--
-- This script creates one version through the trusted RPC, clones that snapshot
-- as an unmarked legacy row under the database owner, and then proves:
--   1. authenticated restore of the unmarked row raises
--      QUOTE_VERSION_LEGACY_UNTRUSTED before quote/header/section/item mutation;
--   2. the marked RPC-created version still restores successfully; and
--   3. every fixture and successful restore rolls back at the terminal raise.
--
-- Run only through psql -1 / run-smoke.mjs. The script performs deliberate
-- transaction-local writes and must never be split into individually committed
-- statements or run through the live-data MCP guard.

-- Session-level advisory locks are deliberately used as an attempt sentinel.
-- A caught PL/pgSQL exception rolls table changes back to its subtransaction,
-- which makes after-state equality alone unable to prove that no write was
-- attempted. Session advisory locks survive that rollback, so these temporary
-- triggers leave observable evidence if the owner restore path reaches any
-- quote/header/section/item mutation before the trust rejection. The terminal
-- transaction rollback removes this function and all three triggers.
CREATE FUNCTION public._smoke_quote_restore_attempt_sentinel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $sentinel$
DECLARE
  v_target_quote uuid;
  v_row_quote uuid;
BEGIN
  v_target_quote := nullif(current_setting('crx.smoke_quote_restore_target', true), '')::uuid;
  IF TG_TABLE_NAME = 'quotes' THEN
    v_row_quote := coalesce(NEW.id, OLD.id);
  ELSE
    v_row_quote := coalesce(NEW.quote_id, OLD.quote_id);
  END IF;
  IF v_target_quote IS NOT NULL AND v_row_quote = v_target_quote THEN
    PERFORM pg_advisory_lock(
      hashtext('crx-quote-restore-attempt'),
      hashtext(current_setting('crx.smoke_quote_restore_marker', true))
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$sentinel$;

DO $smoke$
DECLARE
  v_admin uuid;
  v_quote_id uuid;
  v_expected_row_version bigint;
  v_trusted_version_id uuid;
  v_legacy_version_id uuid;
  v_result jsonb;
  v_restore_result jsonb;
  v_quote_before jsonb;
  v_quote_after jsonb;
  v_sections_before jsonb;
  v_sections_after jsonb;
  v_items_before jsonb;
  v_items_after jsonb;
  v_attempted_mutation boolean;
  v_attempt_marker integer;
  v_suffix text := substr(md5(random()::text), 1, 8);
BEGIN
  IF to_regprocedure('public.create_quote_version(uuid,uuid,text,text,bigint)') IS NULL
     OR to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_attribute a
        WHERE a.attrelid = 'public.quote_versions'::regclass
          AND a.attname = 'restore_trusted_at'
          AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION 'SMOKE_PREREQ: 20260813180000 quote-version restore trust boundary is not deployed';
  END IF;

  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active
   ORDER BY id
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile is available';
  END IF;

  SELECT id INTO v_quote_id
    FROM public.quotes
   WHERE deleted_at IS NULL
     AND status IN ('draft', 'revised', 'accepted', 'sent')
     AND NOT EXISTS (
       SELECT 1
         FROM public.quote_items qi
        WHERE qi.quote_id = quotes.id
          AND (qi.current_cost IS NULL OR qi.current_cost <= 0)
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.quote_product_draws qpd
        WHERE qpd.quote_id = quotes.id
          AND qpd.quantity_drawn > 0
     )
   ORDER BY created_at, id
   LIMIT 1;
  IF v_quote_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no restorable live quote with positive item costs, no drawn ledger, and status draft/revised/accepted/sent is available';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  SELECT row_version INTO v_expected_row_version
    FROM public.quotes
   WHERE id = v_quote_id;

  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT public.create_quote_version(
      v_quote_id,
      v_admin,
      'smoke',
      'SMK-QV-TRUST-CREATE-' || v_suffix,
      v_expected_row_version
    ) INTO v_result;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'SMOKE_FAIL: trusted create_quote_version failed: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  IF coalesce(v_result->>'status', '') <> 'created'
     OR coalesce(v_result->>'version_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: trusted create did not return a created version: %', v_result;
  END IF;
  v_trusted_version_id := (v_result->>'version_id')::uuid;

  IF NOT EXISTS (
    SELECT 1
      FROM public.quote_versions
     WHERE id = v_trusted_version_id
       AND quote_id = v_quote_id
       AND restore_trusted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: RPC-created quote version was not marked trusted';
  END IF;

  INSERT INTO public.quote_versions (
    quote_id,
    version_number,
    sent_by,
    sent_at,
    sent_method,
    snapshot_data,
    pdf_url,
    notes,
    restore_trusted_at
  )
  SELECT
    qv.quote_id,
    (SELECT coalesce(max(existing.version_number), 0) + 1
       FROM public.quote_versions existing
      WHERE existing.quote_id = qv.quote_id),
    qv.sent_by,
    clock_timestamp(),
    qv.sent_method,
    qv.snapshot_data,
    qv.pdf_url,
    'SMK-UNTRUSTED-' || v_suffix,
    NULL
  FROM public.quote_versions qv
  WHERE qv.id = v_trusted_version_id
  RETURNING id INTO v_legacy_version_id;

  IF v_legacy_version_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: failed to create rollback-only untrusted version fixture';
  END IF;

  SELECT to_jsonb(q), q.row_version
    INTO v_quote_before, v_expected_row_version
    FROM public.quotes q
   WHERE q.id = v_quote_id
   FOR UPDATE;
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
    INTO v_sections_before
    FROM public.quote_sections s
   WHERE s.quote_id = v_quote_id;
  SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
    INTO v_items_before
    FROM public.quote_items i
   WHERE i.quote_id = v_quote_id;

  v_attempt_marker := hashtext(v_suffix);
  PERFORM set_config('crx.smoke_quote_restore_target', v_quote_id::text, false);
  PERFORM set_config('crx.smoke_quote_restore_marker', v_suffix, false);
  EXECUTE 'CREATE TRIGGER zz_smoke_quote_restore_attempt_quote
             BEFORE UPDATE OR DELETE ON public.quotes
             FOR EACH ROW EXECUTE FUNCTION public._smoke_quote_restore_attempt_sentinel()';
  EXECUTE 'CREATE TRIGGER zz_smoke_quote_restore_attempt_section
             BEFORE INSERT OR UPDATE OR DELETE ON public.quote_sections
             FOR EACH ROW EXECUTE FUNCTION public._smoke_quote_restore_attempt_sentinel()';
  EXECUTE 'CREATE TRIGGER zz_smoke_quote_restore_attempt_item
             BEFORE INSERT OR UPDATE OR DELETE ON public.quote_items
             FOR EACH ROW EXECUTE FUNCTION public._smoke_quote_restore_attempt_sentinel()';

  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.restore_quote_version(
      v_quote_id,
      v_legacy_version_id,
      v_admin,
      'SMK-QV-TRUST-LEGACY-' || v_suffix,
      v_expected_row_version,
      'rollback smoke legacy trust rejection'
    );
    RAISE EXCEPTION 'SMOKE_FAIL: untrusted legacy quote version restored successfully';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF SQLERRM <> 'QUOTE_VERSION_LEGACY_UNTRUSTED' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: expected QUOTE_VERSION_LEGACY_UNTRUSTED, got % (%)', SQLERRM, SQLSTATE;
      END IF;
  END;
  RESET ROLE;

  v_attempted_mutation := pg_advisory_unlock(
    hashtext('crx-quote-restore-attempt'),
    v_attempt_marker
  );
  EXECUTE 'DROP TRIGGER zz_smoke_quote_restore_attempt_quote ON public.quotes';
  EXECUTE 'DROP TRIGGER zz_smoke_quote_restore_attempt_section ON public.quote_sections';
  EXECUTE 'DROP TRIGGER zz_smoke_quote_restore_attempt_item ON public.quote_items';
  IF v_attempted_mutation THEN
    RAISE EXCEPTION 'SMOKE_FAIL: legacy rejection occurred only after an attempted quote, section, or item mutation';
  END IF;

  SELECT to_jsonb(q) INTO v_quote_after
    FROM public.quotes q
   WHERE q.id = v_quote_id;
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
    INTO v_sections_after
    FROM public.quote_sections s
   WHERE s.quote_id = v_quote_id;
  SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
    INTO v_items_after
    FROM public.quote_items i
   WHERE i.quote_id = v_quote_id;

  IF v_quote_after IS DISTINCT FROM v_quote_before
     OR v_sections_after IS DISTINCT FROM v_sections_before
     OR v_items_after IS DISTINCT FROM v_items_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rejected legacy restore mutated the quote, sections, or items';
  END IF;

  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT public.restore_quote_version(
      v_quote_id,
      v_trusted_version_id,
      v_admin,
      'SMK-QV-TRUST-GOOD-' || v_suffix,
      v_expected_row_version,
      'rollback smoke trusted restore'
    ) INTO v_restore_result;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'SMOKE_FAIL: trusted quote version did not restore: % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  IF coalesce(v_restore_result->>'status', '') <> 'restored'
     OR coalesce(v_restore_result->>'row_version', '') !~ '^[1-9][0-9]*$'
     OR (v_restore_result->>'row_version')::bigint <> v_expected_row_version + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: trusted restore did not succeed with the authoritative N+1 token: %', v_restore_result;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK quote-version restore trust boundary';
END;
$smoke$;

-- Rollback-only behavioral proof for 20260826220000.
--
-- This script creates one version through the trusted RPC, clones that snapshot
-- as an unmarked legacy row under the database owner, and then proves:
--   1. authenticated restore of the unmarked row raises the exact
--      QUOTE_VERSION_LEGACY_UNTRUSTED error and leaves quote state unchanged;
--   2. the marked RPC-created version still restores successfully; and
--   3. every fixture and successful restore rolls back at the terminal raise.
--
-- Run only through psql -1 / run-smoke.mjs. The script performs deliberate
-- transaction-local writes and must never be split into individually committed
-- statements or run through the live-data MCP guard.

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
    RAISE EXCEPTION 'SMOKE_PREREQ: 20260826220000 quote-version restore trust boundary is not deployed';
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
     -- CodeRabbit 2026-08-25 (P2): filtering only on a positive drawn ledger is
     -- NOT the predicate the restore path actually enforces.
     -- `_restore_quote_version_owner_impl` raises QUOTE_RESTORE_BLOCKED_BY_DRAW
     -- from an UNFILTERED `order_items -> quote_items` join, so a quote whose
     -- draws were later cancelled or voided -- quantity_drawn back to 0, but the
     -- reversed order_items rows retained for audit and still carrying their
     -- quote_item_id stamp -- is admitted by the filter above and then rejected
     -- by the guard. The trusted-restore half of this smoke would report
     -- SMOKE_FAIL even though the migration works correctly. Mirror the guard's
     -- own predicate verbatim so the fixture can only pick a genuinely
     -- restorable quote. (That over-breadth is itself a deliberate, recorded
     -- decision -- Mason 2026-08-20 -- so this filter tracks it rather than
     -- second-guessing it.)
     AND NOT EXISTS (
       SELECT 1
         FROM public.order_items oi
         JOIN public.quote_items qi2 ON qi2.id = oi.quote_item_id
        WHERE qi2.quote_id = quotes.id
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

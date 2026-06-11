-- ============================================================================
-- IDEMPOTENCY LOOKUP OPERATION-SCOPING SWEEP (C6 control follow-through)
-- ============================================================================
-- STAGED DRAFT (DRAFT role, 2026-06-11, second attempt — re-verified against
-- LIVE this session, after live version 20260611190251). Lives in
-- scripts/.staging-migrations/ per the race guard — only the APPLY role moves
-- this under supabase/migrations/, stamped with the MCP-assigned version.
--
-- SUPERSEDES the phantom draft "20260611080937_idempotency_lookup_operation_
-- scope_sweep.sql" from a prior session, which sat under supabase/migrations/
-- with a self-assigned stamp but was NEVER applied (verified: version
-- 20260611080937 absent from supabase_migrations.schema_migrations). That
-- file has been relocated to scripts/.staging-migrations/SUPERSEDED-
-- 20260611080937_idempotency_lookup_operation_scope_sweep.sql. This file was
-- regenerated from live FROM SCRATCH (build-idemscope-sweep.mjs — zero manual
-- transcription); the stale draft was used for nothing but a final diff.
--
-- THE BUG CLASS (restore_quote_version class, Codex 2026-06-08 LOW, at scale):
-- 22 live RPCs' inline idempotency lookup filtered ONLY on the key
-- (`WHERE idempotency_key = p_idempotency_key`) with no operation filter, so
-- a key collision across operations honors ANOTHER operation's cached row:
-- the second RPC silently skips its work and reports success. Root cause: the
-- historical CLAUDE.md copy-paste snippet omitted the operation filter
-- (snippet itself fixed in this change set). Every INSERT already recorded
-- the correct own-name operation; only the LOOKUP was unscoped.
--
-- THE FIX (uniform, minimal): each body below is VERBATIM from the live
-- catalog with exactly ONE change — the lookup gains
-- ` AND operation = '<function's own name>'`. No other behavior change.
--
-- CARVE-OUT (2 of the 22 — race safety, same call as the prior reviewed
-- draft's rls-security-reviewer B1): create_planned_holds and save_quote are
-- EXCLUDED because the pending disk migration
-- 20260611132115_planned_holds_drawn_sync.sql (on disk, NOT in live
-- schema_migrations as of this draft) rebuilds both functions — with
-- operation-scoped lookups of its own (verified: its bodies filter
-- `AND operation = '<own name>' AND created_at > now() - interval '24
-- hours'`). Sweeping them here would let whichever change applied second
-- silently revert the other. They stay on the test's gap list (cap ratcheted
-- 22 -> 2) and fall off when that migration lands.
--
-- LIVE EVIDENCE (all read this session, 2026-06-11, via pg_catalog):
--   * All 20 swept functions: exactly 1 overload; SECURITY DEFINER;
--     proconfig search_path=public, pg_temp; ACL = postgres/authenticated/
--     service_role EXECUTE (NO anon, NO PUBLIC) — uniform across all 20.
--   * The lookup pattern occurs EXACTLY ONCE per body (catalog-counted), in
--     an idempotency_keys WHERE clause (builder context-asserted).
--   * Every body's INSERT already writes its own name as operation
--     (insert_ops catalog scan) — no INSERT fixes needed anywhere.
--   * plpgsql_check_function_tb: 0 errors on all 20 live bodies (the 2026-06-10
--     latent-break class was already fixed by the 2026-06-11 00:0x migrations).
--   * idempotency_keys columns: idempotency_key / operation / result (NOT
--     key / entity_type / entity_id), plus id, created_at, expires_at.
--
-- COLLISION SEMANTICS AFTER THIS FIX (deliberate, fail-loud):
--   idempotency_keys has UNIQUE (idempotency_key) — the key is globally
--   unique across operations. Post-fix, if a caller ever reuses one key for
--   two DIFFERENT operations: the second RPC no longer sees the foreign
--   cached row (the fix), does its real work, and its terminal INSERT raises
--   unique_violation 23505 — loud failure instead of the old silent
--   wrong-result success. (create_quote_version and start_job save with ON
--   CONFLICT (idempotency_key) DO NOTHING, matching the canonical
--   save_idempotency helper's fail-soft save; complete_job's ON CONFLICT is
--   on jobs applied-info, unrelated.) Cross-operation key reuse is a caller
--   bug in every case; the UI mints one key per call site via
--   useIdempotencyKey.
--
-- FIDELITY GATES (three, independent):
--   1. build-idemscope-sweep.mjs asserted, at fetch time, live md5(prosrc) ==
--      baseline AND md5(emitted body minus the one clause) == baseline.
--   2. scripts/.staging-migrations/verify-idemscope-md5.mjs re-checks this
--      file offline against the same baselines (20 PASS + 2 documented SKIPs).
--   3. The terminal DO block below re-asserts IN-DATABASE, post-apply:
--      overload=1, clause present exactly once, md5(prosrc minus clause) ==
--      baseline, SECURITY DEFINER + search_path intact, grants posture
--      unchanged (authenticated+service_role EXECUTE, anon NOT).
--
-- GRANTS: no GRANT/REVOKE statements anywhere in this file — CREATE OR
-- REPLACE preserves each function's existing ACL; the DO block asserts it.
--
-- SMOKE (run post-apply; rolled back by design):
--   scripts/smoke/smoke-idempotency_operation_scope_sweep.sql — representative
--   function batch_post_invoices: a key cached under a DIFFERENT operation is
--   NOT honored (call proceeds into the real body), its OWN duplicate IS
--   (cached short-circuit); ends RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
--
-- BASELINE md5(prosrc) MANIFEST (live, this session):
--   batch_approve_blend_tickets          ecef62c9154d1246e0df5715d1d7ae82
--   batch_post_invoices                  8414b078aa51d5774960c22387d9c3cc
--   batch_reject_blend_tickets           5619eafd51a48b0d44e17fb2b77cc9ff
--   complete_job                         8620e40a6f5f8ae2634815f818005c4e
--   create_invoice_from_blend_ticket     036091796baa73eb0754e5c2dd4de95b
--   create_job_from_quote_section        79f38c109f6549c5808ba7fec5f373cb
--   create_quote_from_template           d8d57dca6f3f5f091e7a2a754bef2a5f
--   create_quote_version                 06ac27b08a9714130d02a1a326bcd188
--   create_split_invoices_from_order     d515f71b72dfbcf290ec258776b46502
--   delete_prepay_credit                 77b21cf7ef8fbbbb711eedd057178706
--   edit_delivery                        06cce0a277cf84cd8605712d6be03d0c
--   edit_prepay_credit                   5f3a14d6abd35301db438d3dd72075a4
--   post_invoice_group                   767b0fbb8954f1009112c0b6880b34f3
--   reverse_receiving_record             08d1026caed844d7ba41bf43e825d378
--   rollover_quote_to_season             dda42120a85a4fb4c3d0c5751fd97c65
--   save_blend_ticket_fields             4b642537dfdf73b3c25d4ce9d024c5bb
--   save_field_app_invoice               76b1e62b6bec2ee5aecb9ca482d00abb
--   save_quote_template                  afc3a240238f9049c3d94239b81522cc
--   start_job                            72a2fb6ff788378b216e9dd84f4a423c
--   void_payment                         8e18a5090bc1093b1836651beba3a780
--   -- carved out (NOT in this sweep; live baselines recorded for the record):
--   create_planned_holds                 912db30f89fce14b0d114f6c1ea20c01
--   save_quote                           980a624c4e29ce01de0c977a007c0a15
-- ============================================================================

-- ============================================================================
-- [IDEMSCOPE 01/20] public.batch_approve_blend_tickets(p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): ecef62c9154d1246e0df5715d1d7ae82   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'batch_approve_blend_tickets'`
-- [IDEMSCOPE-DELTA batch_approve_blend_tickets BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.batch_approve_blend_tickets(p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_count integer := 0;
  v_existing text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_approved_by IS NOT NULL AND p_approved_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'batch_approve_blend_tickets';
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  UPDATE blend_tickets
  SET review_status = 'approved',
      reviewed_by = v_actor,
      reviewed_at = now()
  WHERE id = ANY(p_ticket_ids)
    AND status = 'completed'
    AND review_status = 'unreviewed'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_approve_blend_tickets', jsonb_build_object('approved_count', v_count));
  END IF;

  RETURN jsonb_build_object('approved_count', v_count);
END;
$function$
;
-- [IDEMSCOPE-DELTA batch_approve_blend_tickets END]

-- ============================================================================
-- [IDEMSCOPE 02/20] public.batch_post_invoices(p_invoice_ids uuid[], p_idempotency_key text)
--   baseline md5(prosrc): 8414b078aa51d5774960c22387d9c3cc   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'batch_post_invoices'`
-- [IDEMSCOPE-DELTA batch_post_invoices BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.batch_post_invoices(p_invoice_ids uuid[], p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid; v_count int := 0; v_total bigint := 0; v_actor uuid; v_actor_role text; v_existing jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'batch_post_invoices';
    IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'count', 0, 'idempotent', true); END IF;
  END IF;
  v_actor := auth.uid();
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role != 'admin' THEN RAISE EXCEPTION 'Admin access required to batch post invoices'; END IF;
  IF array_length(p_invoice_ids, 1) IS NULL THEN RAISE EXCEPTION 'No invoice IDs provided'; END IF;
  FOREACH v_id IN ARRAY p_invoice_ids LOOP
    PERFORM post_invoice(v_id);
    v_count := v_count + 1;
    v_total := v_total + COALESCE((SELECT total_amount_cents FROM invoices WHERE id = v_id), 0);
  END LOOP;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_ids[1], v_actor_role,
    jsonb_build_object('batch_count', v_count, 'invoice_ids', to_jsonb(p_invoice_ids)),
    v_total, 'Batch posted ' || v_count || ' invoices totaling $' || (v_total / 100.0)::numeric(12,2));
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result) VALUES (p_idempotency_key, 'batch_post_invoices', to_jsonb(v_count::text));
  END IF;
  RETURN jsonb_build_object('success', true, 'count', v_count, 'total_cents', v_total);
END;
$function$
;
-- [IDEMSCOPE-DELTA batch_post_invoices END]

-- ============================================================================
-- [IDEMSCOPE 03/20] public.batch_reject_blend_tickets(p_ticket_ids uuid[], p_rejected_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 5619eafd51a48b0d44e17fb2b77cc9ff   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'batch_reject_blend_tickets'`
-- [IDEMSCOPE-DELTA batch_reject_blend_tickets BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.batch_reject_blend_tickets(p_ticket_ids uuid[], p_rejected_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_count integer := 0;
  v_existing text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_rejected_by IS NOT NULL AND p_rejected_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'batch_reject_blend_tickets';
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  UPDATE blend_tickets
  SET review_status = 'rejected',
      reviewed_by = v_actor,
      reviewed_at = now()
  WHERE id = ANY(p_ticket_ids)
    AND status = 'completed'
    AND review_status = 'unreviewed'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_reject_blend_tickets', jsonb_build_object('rejected_count', v_count));
  END IF;

  RETURN jsonb_build_object('rejected_count', v_count);
END;
$function$
;
-- [IDEMSCOPE-DELTA batch_reject_blend_tickets END]

-- ============================================================================
-- [IDEMSCOPE 04/20] public.complete_job(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 8620e40a6f5f8ae2634815f818005c4e   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'complete_job'`
-- [IDEMSCOPE-DELTA complete_job BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_job            record;
  v_record_number  text;
  v_record_id      uuid;
  v_product_data   jsonb;
  v_weather        jsonb;
  v_chem           record;
  v_inv            record;
  v_inv_found      boolean;
  v_jf             record;
  v_first_field_id uuid;
  v_field_count    int := 0;
  v_short_count    int := 0;
  v_hold_qty       numeric;
  v_decrement_pb   numeric;
  v_remaining      numeric;
  v_take           numeric;
  v_hold_row       record;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'complete_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.*, c.farm_name AS customer_name
    INTO v_job
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
   WHERE j.id = p_job_id
   FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF NOT (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND v_job.applicator_id = v_actor)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this job';
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time      = COALESCE(EXCLUDED.actual_start_time,      job_applied_info.actual_start_time),
    actual_end_time        = EXCLUDED.actual_end_time,
    wind_speed             = EXCLUDED.wind_speed,
    wind_direction         = EXCLUDED.wind_direction,
    temperature            = EXCLUDED.temperature,
    humidity               = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes                  = EXCLUDED.notes;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       jc.product_id,
        'product_name',     p.product_name,
        'quantity',         jc.quantity,
        'unit',             jc.unit,
        'rate_per_acre',    jc.rate_per_acre,
        'rate_unit',        jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false)
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  v_weather := jsonb_build_object(
    'wind_speed',     (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature',    (p_applied_info->>'temperature')::numeric,
    'humidity',       (p_applied_info->>'humidity')::numeric
  );

  v_record_number := next_application_record_number();

  SELECT field_id INTO v_first_field_id
    FROM job_fields
   WHERE job_id = p_job_id
   ORDER BY sort_order, id
   LIMIT 1;

  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id, v_job.applicator_id, v_first_field_id,
    v_job.job_date, v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id, v_weather, v_job.notes, v_job.season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  FOR v_jf IN
    SELECT jf.field_id,
           COALESCE(jf.acres_to_treat, f.total_acres, 0) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order);
    v_field_count := v_field_count + 1;
  END LOOP;

  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
      FROM job_chemicals jc
     WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    -- Phase 7 #2: planned holds keyed by quote_id, NOT quote_section_id.
    v_hold_qty := 0;
    IF v_job.quote_id IS NOT NULL THEN
      SELECT COALESCE(SUM(ih.quantity), 0) INTO v_hold_qty
        FROM inventory_holds ih
       WHERE ih.product_id  = v_chem.product_id
         AND ih.is_active   = true
         AND ih.source_id   = v_job.quote_id;
    END IF;

    v_decrement_pb := LEAST(v_chem.quantity, COALESCE(v_hold_qty, 0));
    IF COALESCE(v_inv.quantity_prebooked, 0) < v_decrement_pb THEN
      v_decrement_pb := COALESCE(v_inv.quantity_prebooked, 0);
    END IF;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_chem.quantity;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_chem.quantity, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_chem.quantity,
        quantity_prebooked = quantity_prebooked - v_decrement_pb,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;

    -- Phase 7 #3: drain matching holds oldest-first, never going negative.
    v_remaining := v_decrement_pb;
    IF v_remaining > 0 AND v_job.quote_id IS NOT NULL THEN
      FOR v_hold_row IN
        SELECT id, quantity FROM inventory_holds
         WHERE product_id  = v_chem.product_id
           AND is_active   = true
           AND source_id   = v_job.quote_id
         ORDER BY created_at, id
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_hold_row.quantity);
        UPDATE inventory_holds SET
          quantity   = quantity - v_take,
          is_active  = (quantity - v_take) > 0,
          updated_at = now()
        WHERE id = v_hold_row.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, job_id, requires_review
    ) VALUES (
      v_chem.product_id, 'job_applied', v_chem.quantity, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_chem.quantity || ' units applied' ||
        CASE WHEN v_short_flag    THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        CASE WHEN v_decrement_pb > 0 THEN ' [linked prebook released: ' || v_decrement_pb || ']' ELSE '' END,
      p_job_id,
      v_short_flag
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed across ' || v_field_count || ' field(s). Application record: ' || v_record_number ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END,
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success',                true,
    'job_id',                 p_job_id,
    'application_record_id',  v_record_id,
    'record_number',          v_record_number,
    'field_count',            v_field_count,
    'short_stock_count',      v_short_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;
-- [IDEMSCOPE-DELTA complete_job END]

-- ============================================================================
-- [IDEMSCOPE 05/20] public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 036091796baa73eb0754e5c2dd4de95b   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'create_invoice_from_blend_ticket'`
-- [IDEMSCOPE-DELTA create_invoice_from_blend_ticket BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_ticket              record;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_btf                 record;
  v_field_acres         numeric;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_btp                 record;
  v_share_row           jsonb;
  v_share_acres         numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_quote_section_id    uuid;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_chem_qty_a          numeric;
  v_chem_qty_b          numeric;
  v_rate                numeric;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_created_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create blend ticket invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_invoice_from_blend_ticket';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved (status: %)', v_ticket.review_status;
  END IF;
  IF v_ticket.payment_status = 'billed' THEN
    RAISE EXCEPTION 'Blend ticket already billed';
  END IF;

  FOR v_btf IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS field_acres
      FROM blend_ticket_fields btf
      JOIN fields f ON f.id = btf.field_id
     WHERE btf.blend_ticket_id = p_blend_ticket_id
  LOOP
    v_field_ids := array_append(v_field_ids, v_btf.field_id);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_btf.field_id::text, v_btf.field_acres);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    IF v_ticket.field_id IS NOT NULL THEN
      v_field_ids := ARRAY[v_ticket.field_id];
      SELECT COALESCE(v_ticket.total_acres, f.total_acres, 0) INTO v_field_acres
        FROM fields f WHERE f.id = v_ticket.field_id;
      v_applied_acres_map := jsonb_build_object(v_ticket.field_id::text, v_field_acres);
    ELSE
      RAISE EXCEPTION 'Blend ticket has no fields';
    END IF;
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from blend ticket fields';
  END IF;

  IF v_ticket.application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = v_ticket.application_service_id;
  END IF;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := gen_random_uuid();
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_number := next_invoice_number();

    INSERT INTO invoices (
      blend_ticket_id, customer_id, invoice_type, status, season,
      invoice_number, salesman_id, created_by,
      total_amount_cents, total_cost_cents,
      invoice_date, invoice_group_id, application_service_id
    ) VALUES (
      p_blend_ticket_id, v_customer_id, 'field_application', 'draft',
      COALESCE(v_ticket.season, current_season()),
      v_invoice_number, v_ticket.salesman_id, p_created_by,
      0, 0,
      CURRENT_DATE, v_invoice_group_id, v_ticket.application_service_id
    ) RETURNING id INTO v_invoice_id;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres        := (v_share_row->>'share_acres')::numeric;
      v_field_override     := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note := v_share_row->>'pricing_note';
      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );
      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_btp IN
      SELECT btp.*, p.tier1_price, p.tier2_price, p.tier3_price,
             -- DELTA-BLEND-INV-COLFIX BEGIN (D1: p.unit_cost -> p.current_cost; D2: + p.unit_size, p.rate_unit)
             p.product_name AS full_product_name, p.current_cost AS product_cost,
             p.unit_size, p.rate_unit
             -- DELTA-BLEND-INV-COLFIX END
        FROM blend_ticket_products btp
        LEFT JOIN products p ON p.id = btp.product_id
       WHERE btp.blend_ticket_id = p_blend_ticket_id
       ORDER BY btp.sequence_order
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE(v_btp.rate_per_acre, 0);

      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value ->> 'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_a > 0 THEN
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a, 4), v_btp.unit_size,
          0, 0, 0,
          v_btp.sequence_order, v_rate, v_btp.rate_unit,
          false, 'manual'
        );
      END IF;

      IF v_chem_qty_b > 0 THEN
        v_unit_price   := NULL;
        v_quoted_price := NULL;
        v_price_source := NULL;

        IF v_btp.unit_price_cents IS NOT NULL THEN
          v_unit_price   := v_btp.unit_price_cents;
          v_price_source := 'manual';
        ELSIF v_quote_section_id IS NOT NULL AND v_btp.product_id IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
           WHERE qi.section_id = v_quote_section_id
             AND qi.product_id = v_btp.product_id
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN
            v_unit_price   := ROUND(v_qi_price * 100)::bigint;
            v_quoted_price := v_unit_price;
            v_price_source := 'quoted';
          END IF;
        END IF;

        IF v_unit_price IS NULL THEN
          IF v_btp.product_id IS NOT NULL THEN
            v_unit_price := CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(v_btp.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(v_btp.tier2_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(v_btp.tier3_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(v_btp.tier1_price * 100), 0)
            END;
          ELSE
            v_unit_price := 0;
          END IF;
          IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
        END IF;

        v_unit_cost := COALESCE(v_btp.unit_cost_cents,
                                ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);
        v_extended := safe_cents_qty(v_unit_price, v_chem_qty_b);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          quoted_price_cents, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name),
          ROUND(v_chem_qty_b, 4), v_btp.unit_size,
          v_unit_price, v_extended, v_unit_cost,
          v_btp.sequence_order, v_rate, v_btp.rate_unit,
          v_quoted_price, false, v_price_source
        );
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b);
      END IF;
    END LOOP;

    IF v_ticket.application_service_id IS NOT NULL AND v_app_service IS NOT NULL AND v_app_service.is_active THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = v_ticket.application_service_id
         AND car.season                 = COALESCE(v_ticket.season, current_season())
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost
    WHERE id = v_invoice_id;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'price_override_cents')::bigint
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'pricing_note')
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END
    );
  END LOOP;

  UPDATE blend_tickets SET payment_status = 'billed' WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
          'Invoice(s) created from blend ticket ' || v_ticket.ticket_number ||
            CASE WHEN v_invoice_group_id IS NOT NULL
                 THEN ' (group of ' || v_customer_count || ')' ELSE '' END,
          p_created_by, 'invoice', v_invoice_ids[1], v_ticket.customer_id);

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_invoice_from_blend_ticket', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;
-- [IDEMSCOPE-DELTA create_invoice_from_blend_ticket END]

-- ============================================================================
-- [IDEMSCOPE 06/20] public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 79f38c109f6549c5808ba7fec5f373cb   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'create_job_from_quote_section'`
-- [IDEMSCOPE-DELTA create_job_from_quote_section BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_existing jsonb; v_quote RECORD; v_section RECORD; v_item RECORD;
  v_job_id uuid; v_job_number text; v_job_date date; v_season integer;
  v_total_acres numeric := 0; v_total_cost_cents bigint := 0;
  v_total_price_cents bigint := 0; v_sort integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_job_from_quote_section';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  IF v_quote.status IN ('declined', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot schedule job from quote with status: %', v_quote.status;
  END IF;

  SELECT qs.* INTO v_section FROM quote_sections qs WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found or does not belong to quote'; END IF;

  IF EXISTS (SELECT 1 FROM jobs WHERE quote_section_id = p_section_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A job already exists for this quote section. Delete or cancel the existing job first.';
  END IF;

  v_job_date := COALESCE(v_section.needed_by_date, CURRENT_DATE);
  v_season := CASE WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1 ELSE EXTRACT(YEAR FROM v_job_date)::integer END;
  v_job_number := next_job_number();

  INSERT INTO jobs (
    job_number, customer_id, status, job_date, notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents, created_by
  ) VALUES (
    v_job_number, v_quote.customer_id, 'scheduled', v_job_date,
    COALESCE(v_section.section_name, 'Untitled') || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season, p_quote_id, p_section_id, 0, 0, 0, v_actor
  ) RETURNING id INTO v_job_id;

  IF v_section.field_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit, qi.actual_rate, qi.rate_unit,
           qi.price_per_unit, qi.current_cost, qi.acres, qi.sort_order, p.unit_size
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents, sort_order
    ) VALUES (v_job_id, v_item.product_id, COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size), v_item.actual_rate, v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint, v_sort);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents + ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;
  UPDATE jobs SET total_acres = v_total_acres, total_cost_cents = v_total_cost_cents, total_price_cents = v_total_price_cents WHERE id = v_job_id;

  -- F1<<< 42P01 fix (plpgsql_check, 2026-06-10): the logging INSERT targeted
  -- the old log relation (named in the migration header; deliberately NOT
  -- spelled here — this comment lands in prosrc, and the self-verification
  -- block asserts the old relation name appears NOWHERE in the deployed
  -- body), which does not exist — every call aborted here at runtime.
  -- Re-pointed to activity_feed using its live column shape, the exact
  -- pattern draw_down_quote logs with; the old jsonb details payload
  -- (job_number / quote_id / quote_number / section_name) is folded into the
  -- description text. Event token 'job_created_from_quote' kept.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('job_created_from_quote',
    'Job ' || v_job_number || ' scheduled from quote ' || v_quote.quote_number ||
    COALESCE(' — section ' || v_section.section_name, ''),
    v_actor, 'job', v_job_id, v_quote.customer_id);
  -- >>>F1

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', jsonb_build_object('job_id', v_job_id));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$function$
;
-- [IDEMSCOPE-DELTA create_job_from_quote_section END]

-- ============================================================================
-- [IDEMSCOPE 07/20] public.create_quote_from_template(p_template_id uuid, p_customer_id uuid, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): d8d57dca6f3f5f091e7a2a754bef2a5f   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'create_quote_from_template'`
-- [IDEMSCOPE-DELTA create_quote_from_template BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_quote_from_template(p_template_id uuid, p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_template quote_templates%ROWTYPE;
  v_customer customers%ROWTYPE;
  v_quote_id uuid;
  v_quote_number text;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_tier_price numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_quote_from_template' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_from_template', to_jsonb(p_template_id));
  END IF;

  SELECT * INTO v_template FROM quote_templates WHERE id = p_template_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template not found: %', p_template_id; END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  SELECT generate_quote_number() INTO v_quote_number;

  INSERT INTO quotes (quote_number, customer_id, created_by, tier, status, valid_days,
    commission_split)
  VALUES (v_quote_number, p_customer_id, v_actor, v_customer.assigned_tier, 'draft', 15,
    v_customer.default_commission_split)
  RETURNING id INTO v_quote_id;

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_template.sections)
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_quote_id, v_section->>'section_name', (v_section->>'sort_order')::integer,
      v_section->>'section_notes', v_section->>'section_header_notes')
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      SELECT CASE v_customer.assigned_tier
        WHEN 1 THEN COALESCE(tier1_price, 0)
        WHEN 2 THEN COALESCE(tier2_price, tier1_price, 0)
        WHEN 3 THEN COALESCE(tier3_price, tier1_price, 0)
        ELSE COALESCE(tier1_price, 0)
      END INTO v_tier_price
      FROM products WHERE id = (v_item->>'product_id')::uuid;

      INSERT INTO quote_items (quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit, calc_mode)
      VALUES (v_quote_id, v_section_id, (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer, v_item->>'notes',
        v_tier_price,
        (SELECT current_cost FROM products WHERE id = (v_item->>'product_id')::uuid),
        v_item->>'suggested_rate', (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit', v_item->>'calc_mode');
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'quote_id', v_quote_id, 'quote_number', v_quote_number);
END;
$function$
;
-- [IDEMSCOPE-DELTA create_quote_from_template END]

-- ============================================================================
-- [IDEMSCOPE 08/20] public.create_quote_version(p_quote_id uuid, p_performed_by uuid, p_method text, p_idempotency_key text)
--   baseline md5(prosrc): 06ac27b08a9714130d02a1a326bcd188   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'create_quote_version'`
-- [IDEMSCOPE-DELTA create_quote_version BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_quote_version(p_quote_id uuid, p_performed_by uuid, p_method text DEFAULT 'presented'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_version_number integer;
  v_snapshot jsonb;
  v_version_id uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
  FROM quote_versions WHERE quote_id = p_quote_id;

  SELECT jsonb_build_object(
    'quote', jsonb_build_object(
      'quote_number', v_quote.quote_number,
      'customer_id', v_quote.customer_id,
      'tier', v_quote.tier,
      'status', v_quote.status,
      'total_price', v_quote.total_price,
      'total_cost', v_quote.total_cost,
      'total_profit', v_quote.total_profit,
      'total_margin_pct', v_quote.total_margin_pct,
      'valid_days', v_quote.valid_days,
      'expires_at', v_quote.expires_at,
      'header_notes', v_quote.header_notes,
      'footer_notes', v_quote.footer_notes,
      'is_planned', v_quote.is_planned,
      'commission_split', v_quote.commission_split
    ),
    'sections', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'section_name', qs.section_name,
          'sort_order', qs.sort_order,
          'section_notes', qs.section_notes,
          'section_header_notes', qs.section_header_notes,
          'needed_by_date', qs.needed_by_date,
          'items', (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'product_id', qi.product_id,
                'product_name', p.product_name,
                'sku', p.sku,
                'sort_order', qi.sort_order,
                'notes', qi.notes,
                'price_per_unit', qi.price_per_unit,
                'current_cost', qi.current_cost,
                'suggested_rate', qi.suggested_rate,
                'actual_rate', qi.actual_rate,
                'rate_unit', qi.rate_unit,
                'oz_per_acre', qi.oz_per_acre,
                'price_per_acre', qi.price_per_acre,
                'acres', qi.acres,
                'total_units_needed', qi.total_units_needed,
                'unit_size', qi.unit_size,
                'profit', qi.profit,
                'total_price', qi.total_price,
                'net_margin', qi.net_margin,
                'calc_mode', qi.calc_mode,
                'price_unit', qi.price_unit
              ) ORDER BY qi.sort_order
            ), '[]'::jsonb)
            FROM quote_items qi
            JOIN products p ON p.id = qi.product_id
            WHERE qi.section_id = qs.id
          )
        ) ORDER BY qs.sort_order
      ), '[]'::jsonb)
      FROM quote_sections qs
      WHERE qs.quote_id = p_quote_id
    )
  ) INTO v_snapshot;

  INSERT INTO quote_versions (quote_id, version_number, sent_by, sent_at, sent_method, snapshot_data)
  VALUES (p_quote_id, v_version_number, v_actor, now(), p_method, v_snapshot)
  RETURNING id INTO v_version_id;

  UPDATE quotes SET status = 'sent', sent_at = now(), updated_at = now()
  WHERE id = p_quote_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_version', to_jsonb(v_version_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'version_id', v_version_id,
    'version_number', v_version_number
  );
END;
$function$
;
-- [IDEMSCOPE-DELTA create_quote_version END]

-- ============================================================================
-- [IDEMSCOPE 09/20] public.create_split_invoices_from_order(p_order_id uuid, p_salesman_id uuid, p_invoice_type text, p_idempotency_key text)
--   baseline md5(prosrc): d515f71b72dfbcf290ec258776b46502   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'create_split_invoices_from_order'`
-- [IDEMSCOPE-DELTA create_split_invoices_from_order BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing text; v_order record; v_split record; v_has_splits boolean := false;
  v_group_id uuid; v_invoice_id uuid; v_invoice_ids uuid[] := '{}';
  v_item record; v_total_cents bigint; v_split_ext bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    -- [DELTA:split_invoices_jsonb_fix:read-begin] result column is jsonb; #>> {}
    -- extracts the stored JSON string as bare text so string_to_array sees
    -- id1,id2 without surrounding double quotes (42804-class fix, read side).
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_split_invoices_from_order';
    -- [DELTA:split_invoices_jsonb_fix:read-end]
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  SELECT EXISTS (SELECT 1 FROM get_field_billing_splits_for_order(p_order_id)) INTO v_has_splits;

  IF NOT v_has_splits THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  v_group_id := gen_random_uuid();

  FOR v_split IN
    SELECT s.customer_id, sum(s.split_pct) AS total_pct
    FROM get_field_billing_splits_for_order(p_order_id) s GROUP BY s.customer_id
  LOOP
    v_total_cents := 0;

    INSERT INTO invoices (order_id, customer_id, invoice_type, status, season, salesman_id, created_by, total_amount_cents, invoice_date, invoice_group_id, header_notes)
    VALUES (p_order_id, v_split.customer_id, p_invoice_type, 'draft', COALESCE(v_order.season, current_season()),
      COALESCE(p_salesman_id, v_order.salesman_id), auth.uid(), 0, CURRENT_DATE, v_group_id,
      'Split invoice (' || round(v_split.total_pct, 1) || '%)')
    RETURNING id INTO v_invoice_id;

    FOR v_item IN SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
    LOOP
      v_split_ext := round(round(v_item.total_price * 100)::bigint * v_split.total_pct / 100);
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, unit_size)
      VALUES (v_invoice_id, v_item.id, v_item.product_id, COALESCE(v_item.product_name, ''),
        round(v_item.total_units_needed * v_split.total_pct / 100, 4),
        round(v_item.price_per_unit * 100)::bigint, v_split_ext, round(v_item.cost_per_unit * 100)::bigint,
        COALESCE(v_item.sort_order, 0), v_item.actual_rate, v_item.acres, v_item.unit_size);
      v_total_cents := v_total_cents + v_split_ext;
    END LOOP;

    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
    VALUES ('invoice_created', 'invoice', v_invoice_id, COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object('order_number', v_order.order_number, 'split_pct', v_split.total_pct, 'group_id', v_group_id),
      v_total_cents, 'Split invoice (' || round(v_split.total_pct, 1) || '%) from order ' || v_order.order_number);

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created', array_length(v_invoice_ids, 1) || ' split invoices from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  IF p_idempotency_key IS NOT NULL THEN
    -- [DELTA:split_invoices_jsonb_fix:write-begin] 42804 fix: result column is
    -- jsonb, array_to_string() returns text. to_jsonb(...) stores the joined
    -- uuid list as a jsonb string (create_quote_version precedent, 20260609195843).
    INSERT INTO idempotency_keys (idempotency_key, operation, result) VALUES (p_idempotency_key, 'create_split_invoices_from_order', to_jsonb(array_to_string(v_invoice_ids, ',')));
    -- [DELTA:split_invoices_jsonb_fix:write-end]
  END IF;

  RETURN v_invoice_ids;
END;
$function$
;
-- [IDEMSCOPE-DELTA create_split_invoices_from_order END]

-- ============================================================================
-- [IDEMSCOPE 10/20] public.delete_prepay_credit(p_credit_id uuid, p_reason text, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 77b21cf7ef8fbbbb711eedd057178706   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'delete_prepay_credit'`
-- [IDEMSCOPE-DELTA delete_prepay_credit BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_prepay_credit(p_credit_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'delete_prepay_credit';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): null-safe admin check via IS DISTINCT FROM.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  v_old_balance := v_credit.balance_cents;
  IF v_old_balance = 0 THEN RAISE EXCEPTION 'Prepay credit already has zero balance'; END IF;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits
  SET balance_cents         = 0,
      original_amount_cents = v_sum_applied,
      notes                 = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at            = now()
  WHERE id = p_credit_id;

  UPDATE customers
  SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_old_balance, 0)
  WHERE id = v_credit.customer_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_deleted', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'original_amount_cents', v_sum_applied, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'delete_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id, 'deleted_balance_cents', v_old_balance
  );
END;
$function$
;
-- [IDEMSCOPE-DELTA delete_prepay_credit END]

-- ============================================================================
-- [IDEMSCOPE 11/20] public.edit_delivery(p_delivery_id uuid, p_assigned_driver uuid, p_scheduled_date date, p_scheduled_time text, p_delivery_window_start text, p_delivery_window_end text, p_delivery_address_id uuid, p_delivery_notes text, p_priority text, p_items jsonb, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 06cce0a277cf84cd8605712d6be03d0c   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'edit_delivery'`
-- [IDEMSCOPE-DELTA edit_delivery BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.edit_delivery(p_delivery_id uuid, p_assigned_driver uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT NULL::date, p_scheduled_time text DEFAULT NULL::text, p_delivery_window_start text DEFAULT NULL::text, p_delivery_window_end text DEFAULT NULL::text, p_delivery_address_id uuid DEFAULT NULL::uuid, p_delivery_notes text DEFAULT NULL::text, p_priority text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_old_driver uuid;
  v_item jsonb;
  v_oi record;
  v_other_scheduled numeric;
  v_requested_qty numeric;
  v_max_allowed numeric;
  v_items_changed boolean := false;
  v_cached_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached_result
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'edit_delivery';
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'Cannot edit a % delivery', v_delivery.status;
  END IF;

  v_old_driver := v_delivery.assigned_driver;

  UPDATE deliveries SET
    assigned_driver = COALESCE(p_assigned_driver, assigned_driver),
    scheduled_date = COALESCE(p_scheduled_date, scheduled_date),
    scheduled_time = CASE WHEN p_scheduled_time IS NOT NULL THEN p_scheduled_time ELSE scheduled_time END,
    delivery_window_start = CASE WHEN p_delivery_window_start IS NOT NULL THEN p_delivery_window_start ELSE delivery_window_start END,
    delivery_window_end = CASE WHEN p_delivery_window_end IS NOT NULL THEN p_delivery_window_end ELSE delivery_window_end END,
    delivery_address_id = CASE WHEN p_delivery_address_id IS NOT NULL THEN p_delivery_address_id ELSE delivery_address_id END,
    delivery_notes = CASE WHEN p_delivery_notes IS NOT NULL THEN p_delivery_notes ELSE delivery_notes END,
    priority = COALESCE(p_priority, priority),
    last_edited_by = v_actor,
    last_edited_at = now(),
    updated_at = now()
  WHERE id = p_delivery_id;

  IF p_items IS NOT NULL AND v_delivery.status = 'scheduled' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      v_requested_qty := (v_item->>'quantity')::numeric;

      IF v_requested_qty <= 0 THEN
        CONTINUE;
      END IF;

      SELECT * INTO v_oi
      FROM order_items
      WHERE id = (v_item->>'order_item_id')::uuid
        AND order_id = v_delivery.order_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Order item % not found on order %',
          v_item->>'order_item_id', v_delivery.order_id;
      END IF;

      SELECT COALESCE(SUM(di.quantity), 0) INTO v_other_scheduled
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      WHERE di.order_item_id = v_oi.id
        AND d.status IN ('scheduled', 'in_progress')
        AND d.id != p_delivery_id;

      v_max_allowed := v_oi.quantity_remaining - v_other_scheduled;

      IF v_requested_qty > v_max_allowed THEN
        RAISE EXCEPTION 'Cannot schedule % units of % — only % available (% remaining on order, % on other deliveries)',
          v_requested_qty,
          v_oi.product_name,
          GREATEST(v_max_allowed, 0),
          v_oi.quantity_remaining,
          v_other_scheduled;
      END IF;
    END LOOP;

    DELETE FROM delivery_items WHERE delivery_id = p_delivery_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      IF (v_item->>'quantity')::numeric > 0 THEN
        INSERT INTO delivery_items (
          delivery_id, order_item_id, product_id, quantity, unit_size
        ) VALUES (
          p_delivery_id,
          (v_item->>'order_item_id')::uuid,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::numeric,
          v_item->>'unit_size'
        );
      END IF;
    END LOOP;

    v_items_changed := true;
  END IF;

  IF p_items IS NOT NULL AND v_delivery.status = 'in_progress' THEN
    RAISE EXCEPTION 'Cannot edit delivery items once delivery is in progress';
  END IF;

  IF p_assigned_driver IS NOT NULL AND v_old_driver IS DISTINCT FROM p_assigned_driver THEN
    IF v_old_driver IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_old_driver,
        'Delivery Reassigned',
        'Delivery ' || v_delivery.delivery_number || ' has been reassigned to another driver.',
        'delivery_update', 'delivery', p_delivery_id
      );
    END IF;

    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      p_assigned_driver,
      'New Delivery Assigned',
      'Delivery ' || v_delivery.delivery_number || ' has been assigned to you.',
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_edited',
    'Delivery ' || v_delivery.delivery_number || ' edited' ||
      CASE WHEN v_items_changed THEN ' (items updated)' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_delivery',
      jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id, 'items_changed', v_items_changed)
    );
  END IF;

  RETURN jsonb_build_object('status', 'updated', 'delivery_id', p_delivery_id, 'items_changed', v_items_changed);
END;
$function$
;
-- [IDEMSCOPE-DELTA edit_delivery END]

-- ============================================================================
-- [IDEMSCOPE 12/20] public.edit_prepay_credit(p_credit_id uuid, p_new_balance_cents bigint, p_reference_number text, p_bucket_label text, p_notes text, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 5f3a14d6abd35301db438d3dd72075a4   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'edit_prepay_credit'`
-- [IDEMSCOPE-DELTA edit_prepay_credit BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.edit_prepay_credit(p_credit_id uuid, p_new_balance_cents bigint DEFAULT NULL::bigint, p_reference_number text DEFAULT NULL::text, p_bucket_label text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_delta       bigint;
  v_actor       uuid;
  v_actor_role  text;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'edit_prepay_credit';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): IS DISTINCT FROM treats NULL (deactivated user
  -- or missing profile row) as "not admin" and raises. Prior `!= 'admin'`
  -- evaluated to NULL when subquery was empty and silently allowed mutation.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  v_old_balance := v_credit.balance_cents;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits SET
    balance_cents    = COALESCE(p_new_balance_cents, balance_cents),
    original_amount_cents = CASE
      WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
      ELSE original_amount_cents
    END,
    reference_number = COALESCE(p_reference_number, reference_number),
    bucket_label     = COALESCE(p_bucket_label, bucket_label),
    notes            = COALESCE(p_notes, notes),
    updated_at       = now()
  WHERE id = p_credit_id;

  IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents != v_old_balance THEN
    v_delta := p_new_balance_cents - v_old_balance;
    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents + v_delta, 0)
    WHERE id = v_credit.customer_id;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_edited', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', COALESCE(p_new_balance_cents, v_old_balance),
      'original_amount_cents', CASE
        WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
        ELSE v_credit.original_amount_cents
      END,
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label', COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$function$
;
-- [IDEMSCOPE-DELTA edit_prepay_credit END]

-- ============================================================================
-- [IDEMSCOPE 13/20] public.post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 767b0fbb8954f1009112c0b6880b34f3   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'post_invoice_group'`
-- [IDEMSCOPE-DELTA post_invoice_group BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_inv            record;
  v_posted_ids     uuid[] := '{}';
  v_total_cents    bigint := 0;
  v_member_count   int := 0;
  v_result         jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to post invoice groups';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'post_invoice_group';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_group_id IS NULL THEN RAISE EXCEPTION 'invoice_group_id is required'; END IF;

  PERFORM 1 FROM invoices WHERE invoice_group_id = p_invoice_group_id FOR UPDATE;

  SELECT COUNT(*) INTO v_member_count FROM invoices WHERE invoice_group_id = p_invoice_group_id;
  IF v_member_count = 0 THEN RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id; END IF;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id
  LOOP
    IF v_inv.status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot post group — invoice % has status %', v_inv.invoice_number, v_inv.status;
    END IF;
    PERFORM check_period_open(v_inv.invoice_date);
  END LOOP;

  FOR v_inv IN SELECT * FROM invoices WHERE invoice_group_id = p_invoice_group_id ORDER BY invoice_number
  LOOP
    PERFORM post_invoice(v_inv.id, NULL);
    v_posted_ids := array_append(v_posted_ids, v_inv.id);
    v_total_cents := v_total_cents + v_inv.total_amount_cents;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES ('invoice_group_posted',
          'Posted ' || v_member_count || ' invoice(s) in group — total $' ||
            (v_total_cents / 100.0)::numeric(12,2),
          p_performed_by, 'invoice', v_posted_ids[1]);

  v_result := jsonb_build_object(
    'posted_invoice_ids', to_jsonb(v_posted_ids),
    'invoice_group_id',   p_invoice_group_id,
    'total_posted_cents', v_total_cents,
    'member_count',       v_member_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'post_invoice_group', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;
-- [IDEMSCOPE-DELTA post_invoice_group END]

-- ============================================================================
-- [IDEMSCOPE 14/20] public.reverse_receiving_record(p_record_id uuid, p_reason text, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 08d1026caed844d7ba41bf43e825d378   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'reverse_receiving_record'`
-- [IDEMSCOPE-DELTA reverse_receiving_record BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reverse_receiving_record(p_record_id uuid, p_reason text DEFAULT 'Manually reversed'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec    record;
  v_actor  uuid;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'reverse_receiving_record';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'record_id', p_record_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_rec
  FROM receiving_records
  WHERE id = p_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving record not found: %', p_record_id;
  END IF;

  PERFORM set_config('app.reversal_rpc_active', 'true', true);
  PERFORM set_config('app.admin_override', 'true', true);

  UPDATE inventory
  SET quantity_available = quantity_available - v_rec.quantity_received,
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, performed_by
  ) VALUES (
    v_rec.product_id,
    'adjusted',
    -1 * v_rec.quantity_received,
    v_rec.storage_location,
    'Reversed receiving record ' || p_record_id::text || ': ' || p_reason,
    v_actor
  );

  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;

  UPDATE purchase_orders
  SET status = CASE
    WHEN (
      SELECT bool_and(quantity_received = 0)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'submitted'
    WHEN (
      SELECT bool_and(quantity_received >= quantity_ordered)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'fully_received'
    ELSE 'partially_received'
  END,
  updated_at = now()
  WHERE id = v_rec.purchase_order_id
    AND status <> 'cancelled';

  DELETE FROM receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM receiving_records WHERE id = p_record_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'reverse_receiving_record', to_jsonb(p_record_id));
  END IF;

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$function$
;
-- [IDEMSCOPE-DELTA reverse_receiving_record END]

-- ============================================================================
-- [IDEMSCOPE 15/20] public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): dda42120a85a4fb4c3d0c5751fd97c65   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'rollover_quote_to_season'`
-- [IDEMSCOPE-DELTA rollover_quote_to_season BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
  -- A5 additions
  v_has_draws boolean := false;
  v_total_remainder numeric;
  v_drawn numeric;
  v_cum_before numeric;
  v_item_tun numeric;
  v_new_tun numeric;
  v_new_acres numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'rollover_quote_to_season' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'rollover_quote_to_season', to_jsonb(p_quote_id));
  END IF;

  -- A5 change (1): FOR UPDATE serializes against draw_down_quote (which locks
  -- the same quotes row) so the draws ledger is stable for the copy below.
  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  -- A5 inserted block A: draw-awareness, GATED to OPEN bookings only
  -- (status IN ('sent','revised') — the same statuses draw_down_quote draws
  -- against). A partially-drawn OPEN booking rolls over only its undrawn
  -- remainder; an open booking with no remainder anywhere has nothing to
  -- roll. Any OTHER status (accepted/declined/expired/cancelled, incl. every
  -- backfilled legacy fully-drawn conversion) skips this block entirely:
  -- v_has_draws stays false and the copy below is the verbatim live
  -- full-quantity copy — "renew last season's completed program" unchanged.
  IF v_old_quote.status IN ('sent', 'revised') THEN
    SELECT EXISTS (
      SELECT 1 FROM quote_product_draws
      WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) INTO v_has_draws;
    IF v_has_draws THEN
      SELECT COALESCE(SUM(GREATEST(b.booked - COALESCE(d.quantity_drawn, 0), 0)), 0)
      INTO v_total_remainder
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = p_quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = p_quote_id AND d.product_id = b.product_id;
      IF v_total_remainder <= 0 THEN
        RAISE EXCEPTION 'BOOKING_FULLY_DRAWN: quote % has no undrawn balance to roll over — every booked quantity is already on orders', v_old_quote.quote_number;
      END IF;
    END IF;
  END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, v_actor, v_old_quote.tier,
    'draft', v_old_quote.is_planned, v_old_quote.commission_split,
    v_old_quote.valid_days, v_old_quote.header_notes, v_old_quote.footer_notes,
    p_new_season, v_old_quote.salesman_id
  ) RETURNING id INTO v_new_quote_id;

  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_new_quote_id, v_section.section_name, v_section.sort_order,
      v_section.section_notes, v_section.section_header_notes)
    RETURNING id INTO v_new_section_id;

    FOR v_item IN
      SELECT * FROM quote_items WHERE section_id = v_section.id ORDER BY sort_order
    LOOP
      -- A5 inserted block B: FIFO remainder math. Reachable only when block A
      -- found draws — i.e. the booking is OPEN (sent/revised) AND has draws —
      -- and only reduces items whose product is drawn; everything else,
      -- including EVERY item of a non-open quote, copies as live.
      v_drawn := 0;
      v_new_tun := NULL;
      v_new_acres := NULL;
      IF v_has_draws THEN
        SELECT quantity_drawn INTO v_drawn
        FROM quote_product_draws
        WHERE quote_id = p_quote_id AND product_id = v_item.product_id;
        v_drawn := COALESCE(v_drawn, 0);
        IF v_drawn > 0 THEN
          v_item_tun := COALESCE(v_item.total_units_needed, 0);
          -- Booked quantity on items EARLIER than this one in deterministic
          -- display order; the drawn quantity consumes items from the front.
          SELECT COALESCE(SUM(COALESCE(qi2.total_units_needed, 0)), 0) INTO v_cum_before
          FROM quote_items qi2
          JOIN quote_sections qs2 ON qs2.id = qi2.section_id
          WHERE qi2.quote_id = p_quote_id
            AND qi2.product_id = v_item.product_id
            AND (qs2.sort_order, qs2.id, qi2.sort_order, qi2.id)
              < (v_section.sort_order, v_section.id, v_item.sort_order, v_item.id);
          v_new_tun := LEAST(v_item_tun, GREATEST(v_cum_before + v_item_tun - v_drawn, 0));
          IF v_new_tun <= 0 THEN
            CONTINUE;  -- line fully consumed by draws: nothing to roll over
          END IF;
          IF v_new_tun = v_item_tun THEN
            v_new_acres := v_item.acres;  -- untouched line: copy acres exactly
          ELSIF v_item.acres IS NOT NULL AND v_item_tun > 0 THEN
            v_new_acres := ROUND(v_item.acres * v_new_tun / v_item_tun, 2);
          ELSE
            v_new_acres := v_item.acres;
          END IF;
        END IF;
      END IF;

      SELECT CASE v_old_quote.tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        WHEN 3 THEN COALESCE(p.tier3_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier1_price, 0)
      END, p.current_cost
      INTO v_tier_price, v_current_cost
      FROM products p WHERE p.id = v_item.product_id;

      IF v_has_draws AND v_drawn > 0 THEN
        -- Drawn product: carry the explicit undrawn remainder + prorated acres.
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit, total_units_needed
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_new_acres,
          v_item.calc_mode, v_item.price_unit, v_new_tun
        );
      ELSE
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_item.acres,
          v_item.calc_mode, v_item.price_unit
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'created',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number,
    'season', p_new_season,
    'remainder_rollover', v_has_draws
  );
END;
$function$
;
-- [IDEMSCOPE-DELTA rollover_quote_to_season END]

-- ============================================================================
-- [IDEMSCOPE 16/20] public.save_blend_ticket_fields(p_blend_ticket_id uuid, p_fields jsonb, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 4b642537dfdf73b3c25d4ce9d024c5bb   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'save_blend_ticket_fields'`
-- [IDEMSCOPE-DELTA save_blend_ticket_fields BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_blend_ticket_fields(p_blend_ticket_id uuid, p_fields jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_field jsonb;
  v_count integer := 0;
  v_existing text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'save_blend_ticket_fields';
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  DELETE FROM blend_ticket_fields WHERE blend_ticket_id = p_blend_ticket_id;

  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres, sort_order)
    VALUES (
      p_blend_ticket_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'customer_id')::uuid,
      (v_field->>'planned_acres')::numeric,
      v_count
    );
    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_blend_ticket_fields', jsonb_build_object('fields_saved', v_count));
  END IF;

  RETURN jsonb_build_object('fields_saved', v_count);
END;
$function$
;
-- [IDEMSCOPE-DELTA save_blend_ticket_fields END]

-- ============================================================================
-- [IDEMSCOPE 17/20] public.save_field_app_invoice(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text)
--   baseline md5(prosrc): 76b1e62b6bec2ee5aecb9ca482d00abb   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'save_field_app_invoice'`
-- [IDEMSCOPE-DELTA save_field_app_invoice BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_field_app_invoice(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_existing_group_id   uuid;
  v_existing_status     text;
  v_locked_count        int;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_total_applied_acres numeric := 0;
  v_loc                 jsonb;
  v_chem                jsonb;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_loc_id              uuid;
  v_share_row           jsonb;
  v_share_pct           numeric;
  v_share_acres         numeric;
  v_field_id            uuid;
  v_field_applied_acres numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_orphan              record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save field application invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'save_field_app_invoice';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT status, invoice_group_id INTO v_existing_status, v_existing_group_id
      FROM invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
    SELECT COUNT(*) INTO v_locked_count
      FROM invoices
     WHERE (id = p_invoice_id OR invoice_group_id = v_existing_group_id)
       AND v_existing_group_id IS NOT NULL
       AND status NOT IN ('draft', 'unposted');
    IF v_locked_count > 0 OR v_existing_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice — % invoice(s) in this group are posted/voided. Use void/reissue.', GREATEST(v_locked_count, 1);
    END IF;

    IF v_existing_group_id IS NOT NULL THEN
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_group_id = v_existing_group_id
      );
      DELETE FROM field_app_locations WHERE invoice_group_id = v_existing_group_id;
      DELETE FROM invoice_items   WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id);
      DELETE FROM invoice_shares  WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id);
    ELSE
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_id = p_invoice_id
      );
      DELETE FROM field_app_locations WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
    END IF;
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_total_applied_acres := v_total_applied_acres + COALESCE((v_loc->>'applied_acres')::numeric, (v_loc->>'total_acres')::numeric, 0);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      COALESCE((v_loc->>'applied_acres')::numeric, (v_loc->>'total_acres')::numeric, 0)
    );
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one field is required';
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from selected fields';
  END IF;

  IF v_existing_group_id IS NOT NULL THEN
    FOR v_orphan IN
      SELECT id, invoice_number, customer_id
        FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND customer_id NOT IN (
           SELECT (c->>'customer_id')::uuid FROM jsonb_array_elements(v_customers) c
         )
    LOOP
      UPDATE invoices SET
        status              = 'cancelled',
        invoice_group_id    = NULL,
        total_amount_cents  = 0,
        total_cost_cents    = 0,
        updated_at          = now()
      WHERE id = v_orphan.id;

      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'invoice_orphan_cancelled',
        'Field app invoice ' || v_orphan.invoice_number ||
          ' cancelled — customer removed from group during edit',
        p_performed_by, 'invoice', v_orphan.id, v_orphan.customer_id
      );
    END LOOP;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := COALESCE(v_existing_group_id, gen_random_uuid());
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;

    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE invoice_group_id = v_existing_group_id AND customer_id = v_customer_id LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number();
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id,
        season
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        (p_invoice->>'salesman_id')::uuid,
        p_invoice->>'header_notes',
        p_performed_by,
        0, 0,
        v_invoice_group_id,
        p_application_service_id,
        current_season()
      ) RETURNING id INTO v_invoice_id;
    ELSE
      UPDATE invoices SET
        invoice_date            = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id             = COALESCE((p_invoice->>'salesman_id')::uuid, salesman_id),
        header_notes            = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id  = p_application_service_id,
        invoice_group_id        = v_invoice_group_id,
        total_amount_cents      = 0,
        total_cost_cents        = 0,
        updated_at              = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_field_id            := (v_share_row->>'field_id')::uuid;
      v_field_applied_acres := (v_share_row->>'field_applied_acres')::numeric;
      v_share_pct           := (v_share_row->>'split_pct')::numeric;
      v_share_acres         := (v_share_row->>'share_acres')::numeric;
      v_field_override      := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note  := v_share_row->>'pricing_note';

      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );

      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      DECLARE
        v_chem_qty_a   numeric := 0;
        v_chem_qty_b   numeric := 0;
        v_rate         numeric;
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        FOR v_share_row IN
          SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
          WHERE (value ->> 'customer_id')::uuid = v_customer_id
        LOOP
          v_share_acres := (v_share_row->>'share_acres')::numeric;
          IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
            v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
          ELSE
            v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
          END IF;
        END LOOP;

        IF v_chem_qty_a > 0 THEN
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            (v_chem->>'description') || ' — included in grower share',
            ROUND(v_chem_qty_a, 4),
            v_chem->>'unit_size',
            0, 0, 0,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            false,
            'manual'
          );
        END IF;

        IF v_chem_qty_b > 0 THEN
          v_unit_price   := NULL;
          v_quoted_price := NULL;
          v_price_source := NULL;

          IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
             AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
            v_unit_price   := (v_chem->>'unit_price_cents')::bigint;
            v_price_source := 'manual';
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT qi.price_per_unit INTO v_qi_price
              FROM quote_items qi
              JOIN quote_sections qs ON qs.id = qi.section_id
             WHERE qi.product_id = (v_chem->>'product_id')::uuid
               AND qs.field_id   = ANY(v_field_ids)
             ORDER BY qi.id LIMIT 1;
            IF v_qi_price IS NOT NULL THEN
              v_unit_price   := ROUND(v_qi_price * 100)::bigint;
              v_quoted_price := v_unit_price;
              v_price_source := 'quoted';
            END IF;
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
            END INTO v_unit_price
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
            v_price_source := 'tier';
          END IF;

          v_unit_price := COALESCE(v_unit_price, 0);
          v_unit_cost  := COALESCE((v_chem->>'cost_cents')::bigint, 0);
          v_extended   := safe_cents_qty(v_unit_price, v_chem_qty_b);

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_chem_qty_b, 4),
            v_chem->>'unit_size',
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source
          );

          v_invoice_total := v_invoice_total + v_extended;
          v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b);
        END IF;
      END;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season                 = current_season()
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
        INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'price_override_cents')::bigint
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'pricing_note')
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END
    );
  END LOOP;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, invoice_group_id,
      field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_invoice_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_invoice_group_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::int,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::int, 0)
    ) RETURNING id INTO v_loc_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
    LOOP
      INSERT INTO field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_loc_id,
        (v_share_row->>'customer_id')::uuid,
        (v_share_row->>'split_pct')::numeric,
        (v_share_row->>'share_acres')::numeric,
        0
      );
    END LOOP;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Field app invoice ' ||
      CASE WHEN v_invoice_group_id IS NOT NULL
           THEN '(group of ' || v_customer_count || ') '
           ELSE '' END ||
      'saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;
-- [IDEMSCOPE-DELTA save_field_app_invoice END]

-- ============================================================================
-- [IDEMSCOPE 18/20] public.save_quote_template(p_quote_id uuid, p_template_name text, p_description text, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): afc3a240238f9049c3d94239b81522cc   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'save_quote_template'`
-- [IDEMSCOPE-DELTA save_quote_template BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_quote_template(p_quote_id uuid, p_template_name text, p_description text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_sections jsonb;
  v_template_id uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'save_quote_template' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_quote_template', to_jsonb(p_quote_id));
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'section_name', qs.section_name,
      'sort_order', qs.sort_order,
      'section_notes', qs.section_notes,
      'section_header_notes', qs.section_header_notes,
      'items', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'product_id', qi.product_id,
            'product_name', p.product_name,
            'sku', p.sku,
            'sort_order', qi.sort_order,
            'notes', qi.notes,
            'suggested_rate', qi.suggested_rate,
            'actual_rate', qi.actual_rate,
            'rate_unit', qi.rate_unit,
            'calc_mode', qi.calc_mode
          ) ORDER BY qi.sort_order
        ), '[]'::jsonb)
        FROM quote_items qi
        JOIN products p ON p.id = qi.product_id
        WHERE qi.section_id = qs.id
      )
    ) ORDER BY qs.sort_order
  ), '[]'::jsonb) INTO v_sections
  FROM quote_sections qs WHERE qs.quote_id = p_quote_id;

  INSERT INTO quote_templates (template_name, description, sections, created_by)
  VALUES (p_template_name, p_description, v_sections, v_actor)
  RETURNING id INTO v_template_id;

  RETURN jsonb_build_object('status', 'created', 'template_id', v_template_id);
END;
$function$
;
-- [IDEMSCOPE-DELTA save_quote_template END]

-- ============================================================================
-- [IDEMSCOPE 19/20] public.start_job(p_job_id uuid, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 72a2fb6ff788378b216e9dd84f4a423c   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'start_job'`
-- [IDEMSCOPE-DELTA start_job BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.start_job(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor     uuid := auth.uid();
  v_existing  jsonb;
  v_job       record;
  v_now       timestamptz := now();
  v_result    jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'start_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF NOT (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND v_job.applicator_id = v_actor)
  ) THEN
    RAISE EXCEPTION 'Not authorized to start this job';
  END IF;

  IF v_job.status = 'in_progress' THEN
    v_result := jsonb_build_object(
      'job_id', p_job_id,
      'status', 'in_progress',
      'started_at', (SELECT actual_start_time FROM job_applied_info WHERE job_id = p_job_id),
      'already_started', true
    );
    IF p_idempotency_key IS NOT NULL THEN
      INSERT INTO idempotency_keys (idempotency_key, operation, result)
      VALUES (p_idempotency_key, 'start_job', v_result)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN v_result;
  END IF;

  IF v_job.status != 'scheduled' THEN
    RAISE EXCEPTION 'Cannot start job — current status is %, expected scheduled', v_job.status;
  END IF;

  UPDATE jobs SET status = 'in_progress' WHERE id = p_job_id;

  INSERT INTO job_applied_info (job_id, actual_start_time)
  VALUES (p_job_id, v_now)
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time = COALESCE(job_applied_info.actual_start_time, EXCLUDED.actual_start_time);

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_started',
    'Job ' || v_job.job_number || ' started',
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'job_id', p_job_id,
    'status', 'in_progress',
    'started_at', v_now,
    'already_started', false
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'start_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$
;
-- [IDEMSCOPE-DELTA start_job END]

-- ============================================================================
-- [IDEMSCOPE 20/20] public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid, p_idempotency_key text)
--   baseline md5(prosrc): 8e18a5090bc1093b1836651beba3a780   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains ` AND operation = 'void_payment'`
-- [IDEMSCOPE-DELTA void_payment BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  -- D53A<<< new loop variable for the multi-credit reversal (task_d53a1704)
  v_credit           record;
  -- >>>D53A
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'void_payment';
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) = 0
               AND status IN ('paid', 'posted') THEN 'posted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  -- D53A<<< overpayment-credit reversal REWRITTEN (task_d53a1704; the
  -- replaced live block is quoted verbatim in the file header).
  -- allocate_payment writes source_reference = 'From payment ' ||
  -- COALESCE(reference_number, check_number, set_id::text); the live match
  -- on the bare set uuid could never hit it, stranding the overpayment in
  -- customers.prepay_balance_cents on every void. prepay_credits has no
  -- allocation-set FK column, so match BOTH historical source_reference
  -- formats; branch (a) is narrowed by customer + season (same-transaction
  -- invariants of allocate_payment), branch (b) is a globally-unique uuid
  -- string. Loop + per-row lock so MULTIPLE matching credits are summed and
  -- reversed consistently (the old code zeroed every match but credited the
  -- customer back only the first row's balance).
  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND balance_cents > 0
      AND (
        (source_reference = 'From payment ' || COALESCE(v_set.reference_number, v_set.check_number, v_set.id::text)
         AND (v_set.season IS NULL OR season = v_set.season))
        OR source_reference = p_allocation_set_id::text
      )
    FOR UPDATE
  LOOP
    UPDATE prepay_credits
    SET balance_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;
  -- >>>D53A

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed);
END;
$function$
;
-- [IDEMSCOPE-DELTA void_payment END]

-- ============================================================================
-- SELF-VERIFICATION (runs in the same transaction as the CREATEs above;
-- ANY failure aborts the whole apply — nothing lands partially)
-- ============================================================================
DO $verify$
DECLARE
  r record;
  v_oid oid;
  v_cnt int;
  v_src text;
  v_clause text;
  v_occurrences int;
  v_stripped_md5 text;
  v_secdef boolean;
  v_config text[];
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('batch_approve_blend_tickets', 'ecef62c9154d1246e0df5715d1d7ae82'),
      ('batch_post_invoices', '8414b078aa51d5774960c22387d9c3cc'),
      ('batch_reject_blend_tickets', '5619eafd51a48b0d44e17fb2b77cc9ff'),
      ('complete_job', '8620e40a6f5f8ae2634815f818005c4e'),
      ('create_invoice_from_blend_ticket', '036091796baa73eb0754e5c2dd4de95b'),
      ('create_job_from_quote_section', '79f38c109f6549c5808ba7fec5f373cb'),
      ('create_quote_from_template', 'd8d57dca6f3f5f091e7a2a754bef2a5f'),
      ('create_quote_version', '06ac27b08a9714130d02a1a326bcd188'),
      ('create_split_invoices_from_order', 'd515f71b72dfbcf290ec258776b46502'),
      ('delete_prepay_credit', '77b21cf7ef8fbbbb711eedd057178706'),
      ('edit_delivery', '06cce0a277cf84cd8605712d6be03d0c'),
      ('edit_prepay_credit', '5f3a14d6abd35301db438d3dd72075a4'),
      ('post_invoice_group', '767b0fbb8954f1009112c0b6880b34f3'),
      ('reverse_receiving_record', '08d1026caed844d7ba41bf43e825d378'),
      ('rollover_quote_to_season', 'dda42120a85a4fb4c3d0c5751fd97c65'),
      ('save_blend_ticket_fields', '4b642537dfdf73b3c25d4ce9d024c5bb'),
      ('save_field_app_invoice', '76b1e62b6bec2ee5aecb9ca482d00abb'),
      ('save_quote_template', 'afc3a240238f9049c3d94239b81522cc'),
      ('start_job', '72a2fb6ff788378b216e9dd84f4a423c'),
      ('void_payment', '8e18a5090bc1093b1836651beba3a780')
    ) AS t(fn, baseline_md5)
  LOOP
    -- (a) exactly one overload
    SELECT count(*) INTO v_cnt FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = r.fn;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'IDEMSCOPE %: overload count % (expected 1)', r.fn, v_cnt;
    END IF;

    SELECT oid, prosrc, prosecdef, proconfig
      INTO v_oid, v_src, v_secdef, v_config
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = r.fn;

    -- (b) the scoped-lookup clause is present EXACTLY once
    v_clause := ' AND operation = ''' || r.fn || '''';
    v_occurrences := (length(v_src) - length(replace(v_src, v_clause, ''))) / length(v_clause);
    IF v_occurrences <> 1 THEN
      RAISE EXCEPTION 'IDEMSCOPE %: delta clause occurs % times (expected exactly 1)', r.fn, v_occurrences;
    END IF;

    -- (c) byte-fidelity: body minus the one clause == live baseline
    v_stripped_md5 := md5(replace(v_src, v_clause, ''));
    IF v_stripped_md5 <> r.baseline_md5 THEN
      RAISE EXCEPTION 'IDEMSCOPE %: body-minus-delta md5 % != baseline % — NOT verbatim-from-live, ABORT',
        r.fn, v_stripped_md5, r.baseline_md5;
    END IF;

    -- (d) SECDEF + search_path preserved
    IF NOT v_secdef THEN
      RAISE EXCEPTION 'IDEMSCOPE %: lost SECURITY DEFINER', r.fn;
    END IF;
    IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
      RAISE EXCEPTION 'IDEMSCOPE %: search_path=public, pg_temp missing from proconfig (%)', r.fn, v_config;
    END IF;

    -- (e) grants posture unchanged (live posture verified this session:
    --     authenticated + service_role EXECUTE; anon none)
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'IDEMSCOPE %: authenticated lost EXECUTE', r.fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'IDEMSCOPE %: service_role lost EXECUTE', r.fn;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'IDEMSCOPE %: anon gained EXECUTE — posture change refused', r.fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'IDEMSCOPE sweep verified: 20/20 functions scoped, verbatim (md5), single overload, SECDEF+search_path, grants intact';
END;
$verify$;

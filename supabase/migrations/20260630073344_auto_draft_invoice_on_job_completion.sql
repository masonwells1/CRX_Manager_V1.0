-- 20260630073344_auto_draft_invoice_on_job_completion.sql
-- Beyond-parity §4 (MONEY) — Auto-Invoice on job completion -> review/post queue.
--
-- ⚠️ MONEY-SAFETY (read before touching):
--   * AUTO-DRAFT ONLY — this NEVER posts. The automatic path calls the already-
--     reviewed transfer_job_to_invoice(), which inserts a DRAFT field-app invoice
--     and flips it to 'unposted' (DELTA-4) and STOPS. Posting stays a human click.
--   * OFF BY DEFAULT — a new app_settings row 'auto_draft_invoice_on_job_completion'
--     seeded 'false'. While OFF, complete_job behaves byte-for-byte as before this
--     migration (zero auto-draft). Only an admin can flip it (app_settings RLS).
--   * IDEMPOTENT — the auto path first checks for a NON-VOIDED invoice already tied
--     to this job; if one exists it does NOTHING (no duplicate draft). It also passes
--     a job-scoped p_idempotency_key so a retried completion can't double-draft.
--   * FAIL-SOFT — the auto-draft runs inside a nested BEGIN/EXCEPTION WHEN OTHERS so
--     ANY draft failure (unresolved pricing/shares, a role gate, anything) is swallowed
--     and NEVER rolls back or blocks the job completion. A 'needs attention' activity
--     row is written so the office can finish billing by hand.
--   * REUSE, DON'T REINVENT — no pricing/split logic is duplicated here. transfer_job_to_invoice
--     owns the price book + shares; this migration only TRIGGERS it automatically.
--
-- complete_job keeps its EXACT signature (uuid, jsonb, uuid, text) so CREATE OR REPLACE
-- is the right tool (no new overload). The body below is a VERBATIM copy of the live
-- definition with ONE added block, marked  -- §4: ... -- §4 END, inserted at the end of
-- the success path right before the idempotency-key write. Every prior behavior — the
-- actor/period/role gates, the in_progress guard, application_records, inventory
-- decrement, hold drain, activity_feed row, idempotency caching — is unchanged.
-- Em-dashes below are real U+2014.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Seed the OFF-by-default setting. ON CONFLICT DO NOTHING so a re-run or an
--    owner-edited value is never clobbered. 'false' = the auto path is skipped
--    entirely (the manual transfer button is the only way to bill, as today).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES (
  'auto_draft_invoice_on_job_completion',
  'false',
  'Beyond-parity §4. When ''true'', completing a field job automatically creates a '
  || 'DRAFT (unposted) field-application invoice via transfer_job_to_invoice — it is '
  || 'NEVER auto-posted (posting is always a human click). OFF (''false'') by default: '
  || 'job completion behaves exactly as before and billing stays a manual step. '
  || 'Admin-only (app_settings RLS). Idempotent + fail-soft: never duplicates a draft '
  || 'and never blocks job completion.'
)
ON CONFLICT (setting_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. complete_job — verbatim live body + the §4 auto-draft block at the end.
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- §4: auto-draft locals (no pricing here — only the trigger decision)
  v_auto_draft_on    boolean := false;
  v_existing_invoice uuid;
  v_auto_draft_key   text;
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

  -- ───────────────────────────────────────────────────────────────────────────
  -- §4: AUTO-DRAFT INVOICE (never auto-post; OFF by default; idempotent; fail-soft).
  -- Runs only after every core completion side effect above has succeeded. The whole
  -- block is wrapped so a draft problem can NEVER roll back / block the completion that
  -- already happened — the job is completed regardless of what happens here.
  -- ───────────────────────────────────────────────────────────────────────────
  BEGIN
    -- Read the toggle cheaply. Absent/malformed => OFF (default, no auto-draft).
    SELECT (setting_value = 'true')
      INTO v_auto_draft_on
      FROM app_settings
     WHERE setting_key = 'auto_draft_invoice_on_job_completion';
    v_auto_draft_on := COALESCE(v_auto_draft_on, false);

    -- OFFICE-COMPLETIONS ONLY (Mason, 2026-06-30): only an admin/sales_rep completion auto-drafts.
    -- An applicator (field driver) completing their OWN job does NOT auto-draft — transfer_job_to_invoice
    -- is admin/sales_rep-gated and we deliberately do NOT loosen it; the office bills those by hand
    -- (they surface in the Cockpit "completed-but-unbilled" tile). Checking the role HERE (vs letting
    -- the call fail-soft) keeps applicator completions clean — no spurious 'auto_draft_failed' note.
    IF v_auto_draft_on AND (is_admin() OR is_sales_rep()) THEN
      -- IDEMPOTENCY: never create a second draft. If ANY non-voided/cancelled invoice
      -- already points at this job (the manual transfer, a prior auto-draft, or a retry),
      -- do nothing. transfer_job_to_invoice also sets jobs.status='invoiced', but we
      -- check invoices directly so a half-state can't slip a duplicate through.
      SELECT i.id INTO v_existing_invoice
        FROM invoices i
       WHERE i.job_id = p_job_id
         AND i.deleted_at IS NULL
         AND i.status NOT IN ('voided', 'cancelled')
       LIMIT 1;

      IF v_existing_invoice IS NULL THEN
        -- Job-scoped key so a retried completion reuses the SAME transfer key (no dup),
        -- yet two different jobs never collide. transfer_job_to_invoice reuses the price
        -- book + per-acre shares; it inserts DRAFT then flips to 'unposted' and STOPS —
        -- it NEVER posts. We do NOT call any post RPC here.
        v_auto_draft_key := 'auto_draft_job:' || p_job_id::text;
        PERFORM transfer_job_to_invoice(p_job_id, p_performed_by, v_auto_draft_key);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- FAIL-SOFT: the job is already completed and committed-in-spirit; the auto-draft is
    -- best-effort. Swallow the error, record a 'needs attention' signal so the office can
    -- bill by hand, and let completion succeed. We do NOT re-raise.
    BEGIN
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'auto_draft_failed',
        'Job ' || v_job.job_number || ' completed, but the automatic draft invoice could '
          || 'not be created (needs attention — bill it manually). Reason: ' || SQLERRM,
        p_performed_by, 'job', p_job_id, v_job.customer_id
      );
    EXCEPTION WHEN OTHERS THEN
      -- Even the note is best-effort; never let logging block completion.
      NULL;
    END;
  END;
  -- §4 END

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Verify exactly ONE overload remains (no accidental dual-overload).
-- (Operational check; harmless if the count is right.)
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'complete_job' AND pronamespace = 'public'::regnamespace;
  IF n <> 1 THEN
    RAISE EXCEPTION 'complete_job overload count = % (expected exactly 1)', n;
  END IF;
END $$;

COMMENT ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) IS
  'Marks a field job completed (application record, inventory decrement, hold drain). '
  'Beyond-parity §4: when app_settings.auto_draft_invoice_on_job_completion = ''true'', '
  'also auto-creates a DRAFT (never posted) field-app invoice via transfer_job_to_invoice — '
  'idempotent (skips if a non-voided invoice already exists for the job) and fail-soft '
  '(a draft failure never blocks completion; logs auto_draft_failed instead).';

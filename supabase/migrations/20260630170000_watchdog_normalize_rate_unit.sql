-- 20260630170000_watchdog_normalize_rate_unit.sql
-- Beyond-parity go-live (Codex P1 fix): the watchdog unit-normalization fix lives in
-- its OWN append-only migration instead of an in-place edit of 20260629240000 (CRX
-- hard rule: migrations are append-only; an edited migration is silently skipped by
-- 'migration up' on any DB that already ran it). Self-contained: creates the pure
-- normalize_rate_unit() helper and CREATE-OR-REPLACEs refresh_watchdog_flags so its
-- rate-vs-label comparison matches equivalent unit spellings (oz/acre==oz, pint==pt),
-- SUPERSEDING the refresh_watchdog_flags body from 20260629240000 (whose original is
-- restored verbatim). Proven on the local copy: applies clean; normalize matches
-- oz/acre==OZ, pint==pt, oz<>pt; refresh_watchdog_flags() runs end-to-end.

-- §2 Watchdog Flags — GAP 3: base REI on ACTUAL applied records, not scheduled job time
--
-- The prior version judged the re-entry-interval (REI) window using the SCHEDULED
-- job_date + scheduled_time. The acceptance criterion is about a REAL re-entry
-- conflict, so the window must be measured against when the prior application was
-- ACTUALLY made. job_applied_records carries the actual application_date (+ optional
-- start_weather_time) and links to the specific field(s) via job_applied_record_fields.
--
-- This migration replaces ONLY the Flag-4 (rei_not_cleared) logic in
-- refresh_watchdog_flags to resolve each application's actual timestamp with this
-- precedence, degrading gracefully when records are absent:
--   1. field-specific applied record (job_applied_records ⋈ job_applied_record_fields)
--   2. job-level applied record (latest applied record for that job, any field)
--   3. fallback: job_date + scheduled_time (the old behavior — when no applied record)
--
-- Flags 1, 2, 3, 3b are unchanged from 20260629230000 (carried verbatim so the single
-- CREATE OR REPLACE stays the one authoritative definition — no overload drift).

-- idempotency-body-check: exempt
-- Rationale: DELETE-then-upsert design — repeated calls produce the same flag set.

DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid, numeric);
DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid);

-- ── Unit normalizer (Codex go-live P2) ───────────────────────────────────────
-- Mirror of src/lib/labelGuardrails.ts normalizeRateUnit so the watchdog's
-- rate-vs-label-max comparison matches the SAME equivalent spellings the frontend
-- guardrail already collapses ('oz/acre' == 'OZ', 'pint' == 'pt'), instead of the
-- prior raw lowercase-trim string equality — which treated 'oz/acre' and 'oz' as
-- DIFFERENT and could let an over-label rate slip past the watchdog un-flagged.
-- Pure/IMMUTABLE: trim, lowercase, strip a per-acre denominator ('/ac','/acre','/a',
-- ' per acre'), then collapse common measure synonyms. A NON-acre denominator
-- (e.g. 'oz/100 gal') is kept WHOLE so it can never collapse onto a bare unit and
-- produce a false match. Empty/blank → NULL (so the IS NOT NULL guards still gate).
CREATE OR REPLACE FUNCTION normalize_rate_unit(p_unit text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  raw  text := lower(btrim(COALESCE(p_unit, '')));
  base text;
BEGIN
  IF raw = '' THEN RETURN NULL; END IF;
  IF raw ~ '\s*/\s*(ac|acre|acres|a)\s*$' THEN
    base := btrim(regexp_replace(raw, '\s*/\s*(ac|acre|acres|a)\s*$', ''));
  ELSIF raw ~ '\s+per\s+acre$' THEN
    base := btrim(regexp_replace(raw, '\s+per\s+acre$', ''));
  ELSIF position('/' IN raw) > 0 THEN
    -- A non-acre denominator present → keep the whole string so it can't match a bare unit.
    RETURN raw;
  ELSE
    base := raw;
  END IF;
  IF base = '' THEN RETURN NULL; END IF;
  RETURN CASE base
    WHEN 'oz'    THEN 'oz'  WHEN 'ounce'    THEN 'oz'  WHEN 'ounces'    THEN 'oz'
    WHEN 'fl oz' THEN 'oz'  WHEN 'floz'     THEN 'oz'  WHEN 'fluid ounce' THEN 'oz'
    WHEN 'pt'    THEN 'pt'  WHEN 'pint'     THEN 'pt'  WHEN 'pints'     THEN 'pt'
    WHEN 'qt'    THEN 'qt'  WHEN 'quart'    THEN 'qt'  WHEN 'quarts'    THEN 'qt'
    WHEN 'gal'   THEN 'gal' WHEN 'gallon'   THEN 'gal' WHEN 'gallons'   THEN 'gal' WHEN 'gl' THEN 'gal'
    WHEN 'lb'    THEN 'lb'  WHEN 'lbs'      THEN 'lb'  WHEN 'pound'     THEN 'lb'  WHEN 'pounds' THEN 'lb'
    WHEN 'ton'   THEN 'ton' WHEN 'tons'     THEN 'ton'
    WHEN 'g'     THEN 'g'   WHEN 'gram'     THEN 'g'   WHEN 'grams'     THEN 'g'
    WHEN 'kg'    THEN 'kg'  WHEN 'kilogram' THEN 'kg'  WHEN 'kilograms' THEN 'kg'
    WHEN 'l'     THEN 'l'   WHEN 'liter'    THEN 'l'   WHEN 'liters'    THEN 'l' WHEN 'litre' THEN 'l' WHEN 'litres' THEN 'l'
    WHEN 'ml'    THEN 'ml'
    ELSE base
  END;
END;
$$;

REVOKE EXECUTE ON FUNCTION normalize_rate_unit(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION normalize_rate_unit(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION refresh_watchdog_flags(
  p_job_id                    uuid    DEFAULT NULL,
  p_acre_divergence_threshold numeric DEFAULT 10,
  p_rate_fallback_multiple    numeric DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_inserted int := 0;
  v_deleted  int := 0;
BEGIN
  v_actor := auth.uid();

  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'WATCHDOG_ACCESS_DENIED: admin or sales_rep role required';
  END IF;

  IF p_acre_divergence_threshold IS NULL OR p_acre_divergence_threshold <= 0 THEN
    RAISE EXCEPTION 'INVALID_THRESHOLD: acre_divergence_threshold must be > 0';
  END IF;
  IF p_rate_fallback_multiple IS NULL OR p_rate_fallback_multiple <= 0 THEN
    RAISE EXCEPTION 'INVALID_THRESHOLD: rate_fallback_multiple must be > 0';
  END IF;

  -- ── Remove stale flags (non-dismissed) in scope ──────────────────────────
  IF p_job_id IS NOT NULL THEN
    DELETE FROM watchdog_flags wf
    WHERE wf.job_id = p_job_id
      AND NOT EXISTS (
        SELECT 1 FROM watchdog_flag_dismissals d WHERE d.flag_id = wf.id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  ELSE
    DELETE FROM watchdog_flags wf
    WHERE NOT EXISTS (
      SELECT 1 FROM watchdog_flag_dismissals d WHERE d.flag_id = wf.id
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  -- ── FLAG 1: Acre Divergence (unchanged) ───────────────────────────────────
  INSERT INTO watchdog_flags (
    natural_key, flag_type, severity, entity_type, entity_id,
    job_id, customer_id, message, detail
  )
  SELECT
    'acre_divergence:job:' || j.id::text,
    'acre_divergence'::text,
    'warning'::text,
    'job'::text,
    j.id,
    j.id,
    j.customer_id,
    format(
      'Job %s applied acres (%s) diverge %s%% from total field boundary acres (%s)',
      j.job_number,
      j.applied_acres,
      ROUND(
        ABS(j.applied_acres - field_totals.boundary_acres)
          / NULLIF(field_totals.boundary_acres, 0) * 100,
        1
      ),
      ROUND(field_totals.boundary_acres, 2)
    ),
    jsonb_build_object(
      'applied_acres',    j.applied_acres,
      'boundary_acres',   ROUND(field_totals.boundary_acres, 2),
      'divergence_pct',
        ROUND(
          ABS(j.applied_acres - field_totals.boundary_acres)
          / NULLIF(field_totals.boundary_acres, 0) * 100,
          1
        ),
      'threshold_pct',    p_acre_divergence_threshold,
      'field_count',      field_totals.field_count
    )
  FROM jobs j
  JOIN LATERAL (
    SELECT
      SUM(COALESCE(f.override_acres, f.measured_acres, f.total_acres)) AS boundary_acres,
      COUNT(*)                                                          AS field_count,
      COUNT(*) FILTER (
        WHERE COALESCE(f.override_acres, f.measured_acres, f.total_acres) > 0
      )                                                                 AS fields_with_acres
    FROM job_fields jf
    JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = j.id
  ) field_totals ON field_totals.boundary_acres IS NOT NULL
                 AND field_totals.boundary_acres > 0
                 AND field_totals.field_count = field_totals.fields_with_acres
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND j.applied_acres IS NOT NULL
    AND j.applied_acres > 0
    AND ABS(j.applied_acres - field_totals.boundary_acres)
        / field_totals.boundary_acres * 100
        >= p_acre_divergence_threshold
    AND (p_job_id IS NULL OR j.id = p_job_id)
  ON CONFLICT (natural_key) WHERE natural_key IS NOT NULL DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 2: Rate Over Label Max (unchanged) ───────────────────────────────
  INSERT INTO watchdog_flags (
    natural_key, flag_type, severity, entity_type, entity_id,
    job_id, product_id, customer_id, message, detail
  )
  SELECT
    'rate_over_label:jc:' || jc.id::text,
    'rate_over_label'::text,
    'warning'::text,
    'job_chemical'::text,
    jc.id,
    jc.job_id,
    jc.product_id,
    j.customer_id,
    CASE
      WHEN p.max_label_rate IS NOT NULL
           AND NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), '') IS NOT NULL
           AND jc.rate_per_acre > p.max_label_rate
           AND normalize_rate_unit(jc.rate_unit)
               = normalize_rate_unit(p.max_label_rate_unit)
      THEN format(
        'Job %s: %s applied at %s %s/acre exceeds label max of %s %s/acre',
        j.job_number, p.product_name,
        jc.rate_per_acre, jc.rate_unit,
        p.max_label_rate, p.max_label_rate_unit
      )
      ELSE format(
        'Job %s: %s applied at %s %s/acre exceeds %s× suggested rate (%s %s/acre)',
        j.job_number, p.product_name,
        jc.rate_per_acre, COALESCE(jc.rate_unit,''),
        p_rate_fallback_multiple,
        p.rate_per_acre, COALESCE(p.rate_unit,'')
      )
    END,
    jsonb_build_object(
      'rate_per_acre',          jc.rate_per_acre,
      'rate_unit',              NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''),
      'max_label_rate',         p.max_label_rate,
      'max_label_rate_unit',    NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), ''),
      'suggested_rate',         p.rate_per_acre,
      'suggested_rate_unit',    NULLIF(btrim(COALESCE(p.rate_unit,'')), ''),
      'fallback_multiple',      p_rate_fallback_multiple,
      'product_name',           p.product_name,
      'flag_reason',
        CASE
          WHEN p.max_label_rate IS NOT NULL
               AND NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), '') IS NOT NULL
               AND normalize_rate_unit(jc.rate_unit)
                   = normalize_rate_unit(p.max_label_rate_unit)
          THEN 'label_max'
          ELSE 'fallback_multiple'
        END
    )
  FROM jobs j
  JOIN job_chemicals jc ON jc.job_id = j.id
  JOIN products p ON p.id = jc.product_id
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND jc.rate_per_acre IS NOT NULL
    AND jc.rate_per_acre > 0
    AND (p_job_id IS NULL OR j.id = p_job_id)
    AND (
      (
        p.max_label_rate IS NOT NULL
        AND NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), '') IS NOT NULL
        AND jc.rate_per_acre > p.max_label_rate
        AND normalize_rate_unit(jc.rate_unit)
            = normalize_rate_unit(p.max_label_rate_unit)
      )
      OR
      (
        (
          p.max_label_rate IS NULL
          OR NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), '') IS NULL
          OR normalize_rate_unit(jc.rate_unit)
             <> normalize_rate_unit(p.max_label_rate_unit)
        )
        AND p.rate_per_acre IS NOT NULL
        AND p.rate_per_acre > 0
        AND jc.rate_per_acre > (p_rate_fallback_multiple * p.rate_per_acre)
        AND NULLIF(btrim(COALESCE(jc.rate_unit,'')), '') IS NOT NULL
        AND NULLIF(btrim(COALESCE(p.rate_unit,'')), '') IS NOT NULL
        AND normalize_rate_unit(jc.rate_unit)
            = normalize_rate_unit(p.rate_unit)
      )
    )
  ON CONFLICT (natural_key) WHERE natural_key IS NOT NULL DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 3: Double-Bill (job-level, unchanged) ────────────────────────────
  INSERT INTO watchdog_flags (
    natural_key, flag_type, severity, entity_type, entity_id,
    job_id, invoice_id, customer_id, message, detail
  )
  SELECT DISTINCT ON (i.id)
    'double_bill:job_invoice:' || i.id::text,
    'double_bill'::text,
    'warning'::text,
    'invoice'::text,
    i.id,
    i.job_id,
    i.id,
    i.customer_id,
    format(
      'Invoice %s may duplicate job %s — %s active invoices exist for this job',
      i.invoice_number,
      j.job_number,
      dup.cnt
    ),
    jsonb_build_object(
      'invoice_id',      i.id,
      'invoice_number',  i.invoice_number,
      'job_id',          i.job_id,
      'job_number',      j.job_number,
      'active_count',    dup.cnt
    )
  FROM invoices i
  JOIN jobs j ON j.id = i.job_id
  JOIN (
    SELECT job_id, COUNT(*) AS cnt
    FROM invoices
    WHERE job_id IS NOT NULL
      AND status NOT IN ('voided','cancelled')
      AND deleted_at IS NULL
    GROUP BY job_id
    HAVING COUNT(*) > 1
  ) dup ON dup.job_id = i.job_id
  WHERE i.status NOT IN ('voided','cancelled')
    AND i.deleted_at IS NULL
    AND j.deleted_at IS NULL
    AND (p_job_id IS NULL OR i.job_id = p_job_id)
  ON CONFLICT (natural_key) WHERE natural_key IS NOT NULL DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 3b: Double-Bill (blend-ticket level, unchanged) ──────────────────
  INSERT INTO watchdog_flags (
    natural_key, flag_type, severity, entity_type, entity_id,
    invoice_id, customer_id, message, detail
  )
  SELECT DISTINCT ON (i.id)
    'double_bill:bt_invoice:' || i.id::text,
    'double_bill'::text,
    'warning'::text,
    'invoice'::text,
    i.id,
    i.id,
    i.customer_id,
    format(
      'Invoice %s may duplicate blend ticket — %s distinct invoice groups exist for this blend ticket',
      i.invoice_number,
      dup.group_count
    ),
    jsonb_build_object(
      'invoice_id',        i.id,
      'invoice_number',    i.invoice_number,
      'blend_ticket_id',   i.blend_ticket_id,
      'group_count',       dup.group_count
    )
  FROM invoices i
  JOIN (
    SELECT
      blend_ticket_id,
      COUNT(DISTINCT COALESCE(invoice_group_id::text, id::text)) AS group_count
    FROM invoices
    WHERE blend_ticket_id IS NOT NULL
      AND status NOT IN ('voided','cancelled')
      AND deleted_at IS NULL
    GROUP BY blend_ticket_id
    HAVING COUNT(DISTINCT COALESCE(invoice_group_id::text, id::text)) > 1
  ) dup ON dup.blend_ticket_id = i.blend_ticket_id
  WHERE i.status NOT IN ('voided','cancelled')
    AND i.deleted_at IS NULL
    AND i.job_id IS NULL
    AND p_job_id IS NULL
  ON CONFLICT (natural_key) WHERE natural_key IS NOT NULL DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 4: REI Not Cleared — based on ACTUAL applied records (GAP 3) ──────
  -- The window is now measured between ACTUAL application timestamps, resolved per
  -- (job, field) with this precedence, degrading gracefully:
  --   1. field-specific applied record:
  --        job_applied_records.application_date (+ start_weather_time)
  --        for a record linked to THIS field via job_applied_record_fields
  --   2. job-level applied record: the latest applied record for that job (any field)
  --   3. fallback: job_date + scheduled_time (when no applied record exists)
  -- "Actual entry" of the CURRENT job is resolved the same way; the prior product's
  -- rei_hours decides whether the window had cleared.
  INSERT INTO watchdog_flags (
    natural_key, flag_type, severity, entity_type, entity_id,
    job_id, product_id, field_id, customer_id, message, detail
  )
  SELECT DISTINCT ON (j.id, jf.field_id)
    'rei_not_cleared:job:' || j.id::text || ':field:' || jf.field_id::text,
    'rei_not_cleared'::text,
    'warning'::text,
    'job'::text,
    j.id,
    j.id,
    prior_j.prior_product_id,
    jf.field_id,
    j.customer_id,
    format(
      'Job %s entered field "%s" but the REI from job %s (%s, %s hours) may not have cleared',
      j.job_number,
      f.field_name,
      prior_j.job_number,
      prior_j.prior_product_name,
      prior_j.prior_rei_hours
    ),
    jsonb_build_object(
      'field_name',        f.field_name,
      'prior_product',     prior_j.prior_product_name,
      'prior_rei_hours',   prior_j.prior_rei_hours,
      'prior_job_number',  prior_j.job_number,
      'prior_applied_ts',  prior_j.prior_ts,
      'prior_ts_source',   prior_j.prior_ts_source,
      'this_applied_ts',   cur.this_ts,
      'this_ts_source',    cur.this_ts_source,
      'hours_since_prior',
        ROUND((EXTRACT(EPOCH FROM (cur.this_ts - prior_j.prior_ts)) / 3600)::numeric, 1)
    )
  FROM jobs j
  JOIN job_fields jf ON jf.job_id = j.id
  JOIN fields f ON f.id = jf.field_id
  -- Actual entry time of the CURRENT job onto THIS field (precedence 1→2→3).
  -- Use the EARLIEST (MIN) pass: re-entry risk is the FIRST time someone re-entered
  -- the field, so a later pass that happened after the REI cleared must NOT mask an
  -- earlier pass that occurred while the prior product's REI was still open.
  JOIN LATERAL (
    SELECT
      COALESCE(jarf_ts.ts, jrec_ts.ts,
               (j.job_date + COALESCE(j.scheduled_time, '00:00:00'::time))::timestamptz) AS this_ts,
      CASE WHEN jarf_ts.ts IS NOT NULL THEN 'applied_record_field'
           WHEN jrec_ts.ts IS NOT NULL THEN 'applied_record_job'
           ELSE 'scheduled' END AS this_ts_source
    FROM (
      -- field-specific record for the current job + this field (earliest real pass);
      -- only count a row that actually treated this field (applied_acres > 0).
      -- Time-of-day precedence: the record's start_weather_time, else the job's
      -- scheduled_time, else midnight — so a date-only record keeps a real time and
      -- doesn't collapse to 00:00 (which would hide same-day re-entry).
      SELECT MIN((r.application_date + COALESCE(r.start_weather_time, j.scheduled_time, '00:00:00'::time))::timestamptz) AS ts
      FROM job_applied_records r
      JOIN job_applied_record_fields rf ON rf.application_record_id = r.id AND rf.field_id = jf.field_id
      WHERE r.job_id = j.id AND rf.applied_acres > 0
    ) jarf_ts
    CROSS JOIN (
      -- job-level record for the current job (any field, earliest real pass).
      -- ONLY a legacy fallback: when the job records per-field child rows, an absent
      -- child for THIS field means the field wasn't covered — so don't borrow another
      -- field's time. Gate the fallback to jobs that have NO per-field child data at all.
      SELECT MIN((r.application_date + COALESCE(r.start_weather_time, j.scheduled_time, '00:00:00'::time))::timestamptz) AS ts
      FROM job_applied_records r
      WHERE r.job_id = j.id AND COALESCE(r.applied_acres, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM job_applied_records r2
          JOIN job_applied_record_fields rf2 ON rf2.application_record_id = r2.id
          WHERE r2.job_id = j.id
        )
    ) jrec_ts
  ) cur ON true
  -- Most-recent PRIOR application on this same field (ANY product) whose REI hasn't
  -- cleared, judged by the PRIOR product's rei_hours and the PRIOR actual applied time.
  JOIN LATERAL (
    SELECT pj.id, pj.job_number, pj.job_date,
           prior_ts.ts          AS prior_ts,
           prior_ts.ts_source   AS prior_ts_source,
           pp.id AS prior_product_id, pp.product_name AS prior_product_name, pp.rei_hours AS prior_rei_hours
    FROM jobs pj
    JOIN job_fields pjf ON pjf.job_id = pj.id AND pjf.field_id = jf.field_id
    JOIN job_chemicals pjc ON pjc.job_id = pj.id
    JOIN products pp ON pp.id = pjc.product_id
    -- prior job's ACTUAL applied time onto this field (precedence 1→2→3)
    JOIN LATERAL (
      SELECT
        COALESCE(
          pjarf_ts.ts,
          pjrec_ts.ts,
          -- Scheduled fallback ONLY when the prior job has NO applied records at all.
          -- If it HAS records but none usable here (e.g. all AFTER the current entry —
          -- the prior job was actually sprayed later — or all 0-acre), we must NOT fall
          -- back to its scheduled time, or a job sprayed after this entry would be
          -- mistaken for a prior application. NULL ts → the outer predicate drops it.
          CASE WHEN NOT EXISTS (
                 SELECT 1 FROM job_applied_records r WHERE r.job_id = pj.id
               )
               THEN (pj.job_date + COALESCE(pj.scheduled_time, '00:00:00'::time))::timestamptz
          END
        ) AS ts,
        CASE WHEN pjarf_ts.ts IS NOT NULL THEN 'applied_record_field'
             WHEN pjrec_ts.ts IS NOT NULL THEN 'applied_record_job'
             ELSE 'scheduled' END AS ts_source
      FROM (
        -- field-specific PRIOR record; only count a row that actually treated this
        -- field (applied_acres > 0) — a 0-acre location row is not a real application.
        -- Bound to passes BEFORE the current entry: a prior job with a later pass that
        -- post-dates this entry must not have that after-current pass picked by MAX
        -- (which the outer prior_ts < cur.this_ts predicate would then reject wholesale,
        -- masking an earlier pass that IS within the REI window).
        -- Time-of-day precedence: record start time, else the prior job's scheduled
        -- time, else midnight (same rationale as the current-job block above).
        SELECT MAX((r.application_date + COALESCE(r.start_weather_time, pj.scheduled_time, '00:00:00'::time))::timestamptz) AS ts
        FROM job_applied_records r
        JOIN job_applied_record_fields rf ON rf.application_record_id = r.id AND rf.field_id = jf.field_id
        WHERE r.job_id = pj.id AND rf.applied_acres > 0
          AND (r.application_date + COALESCE(r.start_weather_time, pj.scheduled_time, '00:00:00'::time))::timestamptz < cur.this_ts
      ) pjarf_ts
      CROSS JOIN (
        -- job-level PRIOR record; only count a record with positive applied acres,
        -- and only the latest one BEFORE the current entry (same reason as above).
        -- Legacy fallback only: gate to prior jobs with NO per-field child data at all,
        -- so a prior job that DID record per-field rows but not for this field (i.e. it
        -- didn't treat this field) doesn't manufacture a window from another field's time.
        SELECT MAX((r.application_date + COALESCE(r.start_weather_time, pj.scheduled_time, '00:00:00'::time))::timestamptz) AS ts
        FROM job_applied_records r
        WHERE r.job_id = pj.id AND COALESCE(r.applied_acres, 0) > 0
          AND (r.application_date + COALESCE(r.start_weather_time, pj.scheduled_time, '00:00:00'::time))::timestamptz < cur.this_ts
          AND NOT EXISTS (
            SELECT 1 FROM job_applied_records r2
            JOIN job_applied_record_fields rf2 ON rf2.application_record_id = r2.id
            WHERE r2.job_id = pj.id
          )
      ) pjrec_ts
    ) prior_ts ON true
    WHERE pj.id <> j.id
      AND pj.deleted_at IS NULL
      AND pj.status IN ('completed','invoiced')
      AND pp.rei_hours IS NOT NULL
      AND pp.rei_hours > 0
      -- Exclude a prior job that AFFIRMATIVELY recorded NO real application on this
      -- field. Once a job records per-field child rows (job_applied_record_fields),
      -- those rows ARE the authoritative coverage list — a field absent from them, or
      -- present only at 0 acres, was NOT treated. In that case the scheduled fallback
      -- must NOT manufacture an REI window for this field. (A prior job with NO child
      -- rows at all is a legacy record → scheduled fallback still applies; absence of
      -- ALL child data ≠ a recorded "not this field".)
      AND NOT (
        EXISTS (
          SELECT 1 FROM job_applied_records r
          JOIN job_applied_record_fields rf ON rf.application_record_id = r.id
          WHERE r.job_id = pj.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_applied_records r
          JOIN job_applied_record_fields rf
            ON rf.application_record_id = r.id AND rf.field_id = jf.field_id
          WHERE r.job_id = pj.id AND rf.applied_acres > 0
        )
      )
      -- prior application must be strictly before the current entry, by ACTUAL time
      AND prior_ts.ts < cur.this_ts
      -- and the REI window must not yet have cleared at the current entry time
      AND EXTRACT(EPOCH FROM (cur.this_ts - prior_ts.ts)) / 3600 < pp.rei_hours
    ORDER BY prior_ts.ts DESC, pp.rei_hours DESC
    LIMIT 1
  ) prior_j ON true
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND (p_job_id IS NULL OR j.id = p_job_id)
    -- Symmetric to the prior-job guard: once the CURRENT job records per-field child
    -- rows, those rows are the authoritative coverage list. If THIS field is absent
    -- from them (or present only at 0 acres), the job never entered this field — so
    -- don't flag REI for it. (cur.this_ts may have borrowed another field's pass via
    -- the job-level path; this stops that borrowed time manufacturing a warning. A job
    -- with NO child rows at all stays on the legacy scheduled path.)
    AND NOT (
      EXISTS (
        SELECT 1 FROM job_applied_records r
        JOIN job_applied_record_fields rf ON rf.application_record_id = r.id
        WHERE r.job_id = j.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_applied_records r
        JOIN job_applied_record_fields rf
          ON rf.application_record_id = r.id AND rf.field_id = jf.field_id
        WHERE r.job_id = j.id AND rf.applied_acres > 0
      )
    )
  ON CONFLICT (natural_key) WHERE natural_key IS NOT NULL DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── Return summary (count only active non-dismissed flags in scope) ────────
  SELECT COUNT(*) INTO v_inserted
  FROM watchdog_flags wf
  WHERE NOT EXISTS (
    SELECT 1 FROM watchdog_flag_dismissals d WHERE d.flag_id = wf.id
  )
  AND (p_job_id IS NULL OR wf.job_id = p_job_id);

  RETURN jsonb_build_object(
    'flags_total',   v_inserted,
    'flags_deleted', v_deleted,
    'scope',         CASE WHEN p_job_id IS NOT NULL THEN 'job:' || p_job_id::text ELSE 'all' END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION refresh_watchdog_flags(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION refresh_watchdog_flags(uuid, numeric, numeric) TO authenticated;

COMMENT ON FUNCTION refresh_watchdog_flags IS
  'Recomputes all 4 watchdog flag types. Flag 4 (REI) measures the re-entry window '
  'between ACTUAL applied-record timestamps (job_applied_records ± field link), falling '
  'back to job_date+scheduled_time only when no applied record exists. Uses natural_key '
  'upsert — dismissed flags survive re-sweeps if the underlying condition persists.';

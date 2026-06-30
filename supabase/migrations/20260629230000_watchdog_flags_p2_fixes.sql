-- §2 Watchdog Flags — Codex P2 correctness fixes
-- Fixes applied to refresh_watchdog_flags (all branch-local, not yet in live schema_migrations):
--   P2-1: Add natural_key column + unique index → sweeps upsert, dismissed flags survive re-sweeps
--   P2-2: Acre divergence: compare job.applied_acres vs SUM of all field boundary acres (not each field alone)
--   P2-3: Blend-ticket double-bill: only flag when multiple DISTINCT invoice_group_ids exist per blend ticket
--   P3-4: flags_total: count only active (non-dismissed) flags in scope, not all rows

-- ─── P2-1: natural_key column ────────────────────────────────────────────────
ALTER TABLE watchdog_flags ADD COLUMN IF NOT EXISTS natural_key text;

DROP INDEX IF EXISTS idx_watchdog_flags_natural_key;
CREATE UNIQUE INDEX idx_watchdog_flags_natural_key
  ON watchdog_flags (natural_key) WHERE natural_key IS NOT NULL;

-- ─── Corrected refresh_watchdog_flags ────────────────────────────────────────
-- idempotency-body-check: exempt
-- Rationale: DELETE-then-upsert design — repeated calls produce same flag set.

DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid, numeric);
DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid);

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
  -- Dismissed flags are kept as history — their natural_key will be reused
  -- by the upsert below if the condition still exists.
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

  -- ── FLAG 1: Acre Divergence ───────────────────────────────────────────────
  -- P2-2 FIX: compare jobs.applied_acres (total) against the SUM of all
  -- fields' boundary acres for the job — not against each individual field.
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
    -- Sum authoritative acres across all fields linked to this job
    SELECT
      SUM(COALESCE(f.override_acres, f.measured_acres, f.total_acres)) AS boundary_acres,
      COUNT(*)                                                          AS field_count
    FROM job_fields jf
    JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = j.id
      AND COALESCE(f.override_acres, f.measured_acres, f.total_acres) IS NOT NULL
      AND COALESCE(f.override_acres, f.measured_acres, f.total_acres) > 0
  ) field_totals ON field_totals.boundary_acres IS NOT NULL
                 AND field_totals.boundary_acres > 0
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND j.applied_acres IS NOT NULL
    AND j.applied_acres > 0
    AND ABS(j.applied_acres - field_totals.boundary_acres)
        / field_totals.boundary_acres * 100
        >= p_acre_divergence_threshold
    AND (p_job_id IS NULL OR j.id = p_job_id)
  ON CONFLICT (natural_key) DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 2: Rate Over Label Max ───────────────────────────────────────────
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
           AND LOWER(NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''))
               = LOWER(NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), ''))
      THEN format(
        'Job %s: %s applied at %s %s/acre exceeds label max of %s %s/acre',
        j.job_number, p.product_name,
        jc.rate_per_acre, jc.rate_unit,
        p.max_label_rate, p.max_label_rate_unit
      )
      ELSE format(
        'Job %s: %s applied at %s %s/acre exceeds %.0f× suggested rate (%s %s/acre)',
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
               AND LOWER(NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''))
                   = LOWER(NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), ''))
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
        AND LOWER(NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''))
            = LOWER(NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), ''))
      )
      OR
      (
        (
          p.max_label_rate IS NULL
          OR NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), '') IS NULL
          OR LOWER(NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''))
             <> LOWER(NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), ''))
        )
        AND p.rate_per_acre IS NOT NULL
        AND p.rate_per_acre > 0
        AND jc.rate_per_acre > (p_rate_fallback_multiple * p.rate_per_acre)
        AND NULLIF(btrim(COALESCE(jc.rate_unit,'')), '') IS NOT NULL
        AND NULLIF(btrim(COALESCE(p.rate_unit,'')), '') IS NOT NULL
        AND LOWER(NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''))
            = LOWER(NULLIF(btrim(COALESCE(p.rate_unit,'')), ''))
      )
    )
  ON CONFLICT (natural_key) DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 3: Double-Bill (job-level) ──────────────────────────────────────
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
  ON CONFLICT (natural_key) DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 3b: Double-Bill (blend-ticket level) ─────────────────────────────
  -- P2-3 FIX: Only flag when the same blend_ticket_id appears in MULTIPLE
  -- DISTINCT invoice groups (i.e. truly billed twice), not within one split group.
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
    -- Count distinct invoice groups per blend_ticket_id.
    -- Multiple invoices within one group = legitimate split; flag only when 2+ groups.
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
    AND i.job_id IS NULL   -- job-level handled above
    AND p_job_id IS NULL   -- blend-ticket scope only in full-refresh mode
  ON CONFLICT (natural_key) DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── FLAG 4: REI Not Cleared ───────────────────────────────────────────────
  INSERT INTO watchdog_flags (
    natural_key, flag_type, severity, entity_type, entity_id,
    job_id, product_id, field_id, customer_id, message, detail
  )
  SELECT DISTINCT ON (j.id, jc.product_id, jf.field_id)
    'rei_not_cleared:job:' || j.id::text || ':prod:' || jc.product_id::text || ':field:' || jf.field_id::text,
    'rei_not_cleared'::text,
    'warning'::text,
    'job'::text,
    j.id,
    j.id,
    jc.product_id,
    jf.field_id,
    j.customer_id,
    format(
      'Job %s: %s applied to field "%s" but REI window from job %s (%s hours) may not have cleared',
      j.job_number,
      p.product_name,
      f.field_name,
      prior_j.job_number,
      p.rei_hours
    ),
    jsonb_build_object(
      'product_name',      p.product_name,
      'field_name',        f.field_name,
      'rei_hours',         p.rei_hours,
      'prior_job_number',  prior_j.job_number,
      'prior_job_date',    prior_j.job_date,
      'this_job_date',     j.job_date,
      'hours_since_prior',
        EXTRACT(EPOCH FROM (j.job_date::timestamptz - prior_j.job_date::timestamptz)) / 3600
    )
  FROM jobs j
  JOIN job_chemicals jc ON jc.job_id = j.id
  JOIN products p ON p.id = jc.product_id
  JOIN job_fields jf ON jf.job_id = j.id
  JOIN fields f ON f.id = jf.field_id
  JOIN LATERAL (
    SELECT pj.id, pj.job_number, pj.job_date
    FROM jobs pj
    JOIN job_chemicals pjc ON pjc.job_id = pj.id AND pjc.product_id = jc.product_id
    JOIN job_fields pjf ON pjf.job_id = pj.id AND pjf.field_id = jf.field_id
    WHERE pj.id <> j.id
      AND pj.deleted_at IS NULL
      AND pj.status IN ('completed','invoiced')
      AND pj.job_date < j.job_date
      AND EXTRACT(EPOCH FROM (j.job_date::timestamptz - pj.job_date::timestamptz)) / 3600
          < p.rei_hours
    ORDER BY pj.job_date DESC
    LIMIT 1
  ) prior_j ON true
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND p.rei_hours IS NOT NULL
    AND p.rei_hours > 0
    AND (p_job_id IS NULL OR j.id = p_job_id)
  ON CONFLICT (natural_key) DO UPDATE
    SET message    = EXCLUDED.message,
        detail     = EXCLUDED.detail,
        created_at = now()
    WHERE watchdog_flags.natural_key IS NOT NULL;

  -- ── Return summary (P3-4 FIX: count only active non-dismissed flags in scope)
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
  'Recomputes all 4 watchdog flag types. Uses natural_key upsert — dismissed flags survive '
  're-sweeps if the underlying condition persists. P2 fixes: acre divergence compares job total '
  'vs summed field acres; blend-ticket double-bill only fires across distinct invoice groups.';

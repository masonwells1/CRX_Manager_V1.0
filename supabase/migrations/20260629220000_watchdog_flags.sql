-- §2 Wrong-Field / Wrong-Rate / Double-Bill / REI Watchdog
-- Creates: watchdog_flags, watchdog_flag_dismissals, get_watchdog_flags RPC, dismiss_watchdog_flag RPC
-- All advisory (never blocks). Flags surface inline and as a standing exceptions list.

-- ─── TABLES ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watchdog_flags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_type         text NOT NULL,         -- 'acre_divergence' | 'rate_over_label' | 'double_bill' | 'rei_not_cleared'
  severity          text NOT NULL DEFAULT 'warning',  -- 'warning' | 'info'
  entity_type       text NOT NULL,         -- 'job' | 'invoice' | 'job_chemical'
  entity_id         uuid NOT NULL,
  job_id            uuid,
  invoice_id        uuid,
  product_id        uuid,
  field_id          uuid,
  customer_id       uuid,
  message           text NOT NULL,         -- plain-English description
  detail            jsonb,                 -- structured context (pct, threshold, etc.)
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchdog_flags_flag_type_check
    CHECK (flag_type IN ('acre_divergence','rate_over_label','double_bill','rei_not_cleared')),
  CONSTRAINT watchdog_flags_severity_check
    CHECK (severity IN ('warning','info')),
  CONSTRAINT watchdog_flags_entity_type_check
    CHECK (entity_type IN ('job','invoice','job_chemical'))
);

CREATE INDEX IF NOT EXISTS idx_watchdog_flags_entity   ON watchdog_flags (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_watchdog_flags_job      ON watchdog_flags (job_id)      WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchdog_flags_invoice  ON watchdog_flags (invoice_id)  WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchdog_flags_customer ON watchdog_flags (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_watchdog_flags_type     ON watchdog_flags (flag_type);

-- RLS
ALTER TABLE watchdog_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watchdog_flags_select" ON watchdog_flags
  FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "watchdog_flags_insert" ON watchdog_flags
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

CREATE POLICY "watchdog_flags_delete" ON watchdog_flags
  FOR DELETE TO authenticated
  USING (is_admin());

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watchdog_flag_dismissals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id    uuid NOT NULL REFERENCES watchdog_flags(id) ON DELETE CASCADE,
  dismissed_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  resolution   text NOT NULL CHECK (resolution IN ('looks_fine','needs_fix')),
  note         text,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchdog_dismissals_flag   ON watchdog_flag_dismissals (flag_id);
CREATE INDEX IF NOT EXISTS idx_watchdog_dismissals_actor  ON watchdog_flag_dismissals (dismissed_by);

ALTER TABLE watchdog_flag_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watchdog_dismissals_select" ON watchdog_flag_dismissals
  FOR SELECT TO authenticated
  USING (is_admin() OR is_sales_rep());

CREATE POLICY "watchdog_dismissals_insert" ON watchdog_flag_dismissals
  FOR INSERT TO authenticated
  WITH CHECK ((is_admin() OR is_sales_rep()) AND dismissed_by = auth.uid());

-- ─── WATCHDOG CONFIG (lightweight — stored in a single-row config) ───────────
-- We don't need a full config table; use constants in the RPC defaults.
-- The caller can pass overrides as RPC parameters.

-- ─── get_watchdog_flags ──────────────────────────────────────────────────────
-- Returns active (non-dismissed) watchdog flags with optional filters.
-- Safe for repeated calls; read-only.

DROP FUNCTION IF EXISTS get_watchdog_flags(uuid, uuid, text, boolean);
DROP FUNCTION IF EXISTS get_watchdog_flags(uuid, uuid, text);

CREATE OR REPLACE FUNCTION get_watchdog_flags(
  p_job_id        uuid    DEFAULT NULL,
  p_invoice_id    uuid    DEFAULT NULL,
  p_flag_type     text    DEFAULT NULL,   -- filter to one type; NULL = all
  p_include_dismissed boolean DEFAULT false
)
RETURNS TABLE (
  id            uuid,
  flag_type     text,
  severity      text,
  entity_type   text,
  entity_id     uuid,
  job_id        uuid,
  invoice_id    uuid,
  product_id    uuid,
  field_id      uuid,
  customer_id   uuid,
  message       text,
  detail        jsonb,
  created_at    timestamptz,
  is_dismissed  boolean,
  dismissed_at  timestamptz,
  dismissed_by  uuid,
  resolution    text,
  dismiss_note  text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Gate: authenticated admin or sales_rep only
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'WATCHDOG_ACCESS_DENIED: admin or sales_rep role required';
  END IF;

  RETURN QUERY
  SELECT
    wf.id,
    wf.flag_type,
    wf.severity,
    wf.entity_type,
    wf.entity_id,
    wf.job_id,
    wf.invoice_id,
    wf.product_id,
    wf.field_id,
    wf.customer_id,
    wf.message,
    wf.detail,
    wf.created_at,
    (wd.id IS NOT NULL)  AS is_dismissed,
    wd.dismissed_at,
    wd.dismissed_by,
    wd.resolution,
    wd.note              AS dismiss_note
  FROM watchdog_flags wf
  LEFT JOIN LATERAL (
    SELECT d.id, d.dismissed_at, d.dismissed_by, d.resolution, d.note
    FROM watchdog_flag_dismissals d
    WHERE d.flag_id = wf.id
    ORDER BY d.dismissed_at DESC
    LIMIT 1
  ) wd ON true
  WHERE
    (p_job_id     IS NULL OR wf.job_id     = p_job_id)
    AND (p_invoice_id IS NULL OR wf.invoice_id = p_invoice_id)
    AND (p_flag_type  IS NULL OR wf.flag_type  = p_flag_type)
    AND (p_include_dismissed OR wd.id IS NULL)
  ORDER BY wf.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_watchdog_flags(uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION get_watchdog_flags(uuid, uuid, text, boolean) TO authenticated;

-- ─── dismiss_watchdog_flag ───────────────────────────────────────────────────
-- Records a dismissal (looks_fine | needs_fix). Idempotency-keyed.
-- Idempotent: a second call with the same key returns the cached result.

DROP FUNCTION IF EXISTS dismiss_watchdog_flag(uuid, text, text, uuid, text);
DROP FUNCTION IF EXISTS dismiss_watchdog_flag(uuid, text, text, text);

CREATE OR REPLACE FUNCTION dismiss_watchdog_flag(
  p_flag_id           uuid,
  p_resolution        text,              -- 'looks_fine' | 'needs_fix'
  p_note              text    DEFAULT NULL,
  p_performed_by      uuid    DEFAULT NULL,
  p_idempotency_key   text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_cached   jsonb;
  v_flag     watchdog_flags%ROWTYPE;
  v_dismiss  watchdog_flag_dismissals%ROWTYPE;
  v_result   jsonb;
BEGIN
  -- Resolve actor (canonical pattern: bind auth.uid first, then validate)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: must be authenticated to dismiss watchdog flags';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;

  -- Gate: actor must be admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND (role IN ('admin','sales_rep')) AND is_active = true
  ) THEN
    RAISE EXCEPTION 'WATCHDOG_ACCESS_DENIED: admin or sales_rep role required';
  END IF;

  -- Validate resolution
  IF p_resolution NOT IN ('looks_fine','needs_fix') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION: must be looks_fine or needs_fix';
  END IF;

  -- Idempotency check
  IF NULLIF(btrim(COALESCE(p_idempotency_key,'')), '') IS NOT NULL THEN
    SELECT result INTO v_cached
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key
      AND operation = 'dismiss_watchdog_flag';
    IF FOUND THEN RETURN v_cached; END IF;
  END IF;

  -- Verify flag exists
  SELECT * INTO v_flag FROM watchdog_flags WHERE id = p_flag_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WATCHDOG_FLAG_NOT_FOUND: flag % does not exist', p_flag_id;
  END IF;

  -- Insert dismissal
  INSERT INTO watchdog_flag_dismissals (flag_id, dismissed_by, resolution, note)
  VALUES (p_flag_id, v_actor, p_resolution, NULLIF(btrim(COALESCE(p_note,'')), ''))
  RETURNING * INTO v_dismiss;

  v_result := jsonb_build_object(
    'dismissal_id', v_dismiss.id,
    'flag_id',      p_flag_id,
    'resolution',   p_resolution,
    'dismissed_at', v_dismiss.dismissed_at
  );

  -- Store idempotency result
  IF NULLIF(btrim(COALESCE(p_idempotency_key,'')), '') IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'dismiss_watchdog_flag', v_result)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION dismiss_watchdog_flag(uuid, text, text, uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION dismiss_watchdog_flag(uuid, text, text, uuid, text) TO authenticated;

-- ─── refresh_watchdog_flags ───────────────────────────────────────────────────
-- Computes all 4 flag types for a given job (or ALL active completed/invoiced jobs
-- when p_job_id is NULL) and upserts into watchdog_flags.
-- Called after job completion or invoice creation.
--
-- Flag 1: Acre divergence — job.applied_acres vs field authoritative boundary acres (>= 10%)
-- Flag 2: Chemical rate over label max (products.max_label_rate) or fallback multiple
-- Flag 3: Double-bill — two active invoices for the same job_id / blend_ticket_id
-- Flag 4: REI not cleared — a product applied while a prior job's REI window is still open
--
-- DEGRADES GRACEFULLY: missing max_label_rate → no Flag 2; no boundary acres → no Flag 1;
-- no rei_hours on products → no Flag 4.

DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid, numeric);
DROP FUNCTION IF EXISTS refresh_watchdog_flags(uuid);

-- idempotency-body-check: exempt
-- Rationale: this function is DELETE-then-INSERT by design. It first removes all
-- non-dismissed flags for the scope (per job_id or globally), then recomputes and
-- inserts fresh flags. A double-submit therefore results in the same flag set as a
-- single submit — the DELETE makes repeated calls safe by effect. Adding a key would
-- also prevent a legitimate re-sweep after data corrections.
CREATE OR REPLACE FUNCTION refresh_watchdog_flags(
  p_job_id                    uuid    DEFAULT NULL,
  p_acre_divergence_threshold numeric DEFAULT 10,   -- percent (e.g. 10 = 10%)
  p_rate_fallback_multiple    numeric DEFAULT 3      -- flag if rate > N × product.rate_per_acre fallback
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

  -- Validate inputs are sane
BEGIN
  v_actor := auth.uid();

  -- Gate: admin or sales_rep only
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'WATCHDOG_ACCESS_DENIED: admin or sales_rep role required';
  END IF;

  -- Guard: threshold must be positive
  IF p_acre_divergence_threshold IS NULL OR p_acre_divergence_threshold <= 0 THEN
    RAISE EXCEPTION 'INVALID_THRESHOLD: acre_divergence_threshold must be > 0';
  END IF;
  IF p_rate_fallback_multiple IS NULL OR p_rate_fallback_multiple <= 0 THEN
    RAISE EXCEPTION 'INVALID_THRESHOLD: rate_fallback_multiple must be > 0';
  END IF;

  -- ── Remove stale flags for the scope we are refreshing ──────────────────
  -- Only delete flags that were NOT dismissed (dismissed flags stay as history).
  IF p_job_id IS NOT NULL THEN
    DELETE FROM watchdog_flags wf
    WHERE wf.job_id = p_job_id
      AND NOT EXISTS (
        SELECT 1 FROM watchdog_flag_dismissals d WHERE d.flag_id = wf.id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  ELSE
    -- Full refresh: remove all non-dismissed flags
    DELETE FROM watchdog_flags wf
    WHERE NOT EXISTS (
      SELECT 1 FROM watchdog_flag_dismissals d WHERE d.flag_id = wf.id
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  -- ── FLAG 1: Acre Divergence ───────────────────────────────────────────────
  -- For completed/invoiced jobs, compare job.applied_acres vs the field's
  -- authoritative billable acres (override_acres ?? measured_acres ?? total_acres).
  -- Skip when: applied_acres IS NULL, or field authoritative acres IS NULL or = 0.
  INSERT INTO watchdog_flags (flag_type, severity, entity_type, entity_id,
                               job_id, field_id, customer_id, message, detail)
  SELECT
    'acre_divergence'::text,
    'warning'::text,
    'job'::text,
    j.id,
    j.id,
    jf.field_id,
    j.customer_id,
    format(
      'Job %s applied acres (%s) diverge %s%% from field "%s" boundary acres (%s)',
      j.job_number,
      j.applied_acres,
      ROUND(
        ABS(j.applied_acres - COALESCE(f.override_acres, f.measured_acres, f.total_acres))
          / NULLIF(COALESCE(f.override_acres, f.measured_acres, f.total_acres), 0) * 100,
        1
      ),
      f.field_name,
      COALESCE(f.override_acres, f.measured_acres, f.total_acres)
    ),
    jsonb_build_object(
      'applied_acres',    j.applied_acres,
      'boundary_acres',   COALESCE(f.override_acres, f.measured_acres, f.total_acres),
      'divergence_pct',
        ROUND(
          ABS(j.applied_acres - COALESCE(f.override_acres, f.measured_acres, f.total_acres))
          / NULLIF(COALESCE(f.override_acres, f.measured_acres, f.total_acres), 0) * 100,
          1
        ),
      'threshold_pct',    p_acre_divergence_threshold,
      'acres_source',     f.acres_source
    )
  FROM jobs j
  JOIN job_fields jf ON jf.job_id = j.id
  JOIN fields f ON f.id = jf.field_id
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND j.applied_acres IS NOT NULL
    AND j.applied_acres > 0
    -- field must have authoritative acres
    AND COALESCE(f.override_acres, f.measured_acres, f.total_acres) IS NOT NULL
    AND COALESCE(f.override_acres, f.measured_acres, f.total_acres) > 0
    -- divergence exceeds threshold
    AND ABS(j.applied_acres - COALESCE(f.override_acres, f.measured_acres, f.total_acres))
        / COALESCE(f.override_acres, f.measured_acres, f.total_acres) * 100
        >= p_acre_divergence_threshold
    -- scope filter
    AND (p_job_id IS NULL OR j.id = p_job_id);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- ── FLAG 2: Rate Over Label Max ───────────────────────────────────────────
  -- For each job_chemical where rate_per_acre > 0, compare to:
  --   (a) products.max_label_rate if available (degrade gracefully if not)
  --   (b) fallback: N × products.rate_per_acre if available
  -- No flag when neither limit is on file. Units mismatch? We compare only
  -- when job_chemical.rate_unit matches products.max_label_rate_unit
  -- (or when we use the fallback, job_chemical.rate_unit matches products.rate_unit).
  INSERT INTO watchdog_flags (flag_type, severity, entity_type, entity_id,
                               job_id, product_id, customer_id, message, detail)
  SELECT
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
      -- Path A: label max available, unit matches, rate over max
      (
        p.max_label_rate IS NOT NULL
        AND NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), '') IS NOT NULL
        AND jc.rate_per_acre > p.max_label_rate
        AND LOWER(NULLIF(btrim(COALESCE(jc.rate_unit,'')), ''))
            = LOWER(NULLIF(btrim(COALESCE(p.max_label_rate_unit,'')), ''))
      )
      OR
      -- Path B: no label max (or unit mismatch) — use fallback multiple on suggested rate
      -- Only fires when max_label_rate is NULL or unit can't be compared
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
    );

  v_inserted := v_inserted + (SELECT COUNT(*) FROM (SELECT 1) t);  -- approximate; reset below

  -- ── FLAG 3: Double-Bill ───────────────────────────────────────────────────
  -- Two or more non-voided/cancelled invoices share the same job_id
  -- (or same blend_ticket_id), flagging the most recent one as the duplicate.
  INSERT INTO watchdog_flags (flag_type, severity, entity_type, entity_id,
                               job_id, invoice_id, customer_id, message, detail)
  SELECT DISTINCT ON (i.id)
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
    AND (p_job_id IS NULL OR i.job_id = p_job_id);

  -- Also flag blend_ticket double-bills (no job_id scope filter for those)
  INSERT INTO watchdog_flags (flag_type, severity, entity_type, entity_id,
                               invoice_id, customer_id, message, detail)
  SELECT DISTINCT ON (i.id)
    'double_bill'::text,
    'warning'::text,
    'invoice'::text,
    i.id,
    i.id,
    i.customer_id,
    format(
      'Invoice %s may duplicate blend ticket — %s active invoices exist for blend ticket',
      i.invoice_number,
      dup.cnt
    ),
    jsonb_build_object(
      'invoice_id',        i.id,
      'invoice_number',    i.invoice_number,
      'blend_ticket_id',   i.blend_ticket_id,
      'active_count',      dup.cnt
    )
  FROM invoices i
  JOIN (
    SELECT blend_ticket_id, COUNT(*) AS cnt
    FROM invoices
    WHERE blend_ticket_id IS NOT NULL
      AND status NOT IN ('voided','cancelled')
      AND deleted_at IS NULL
    GROUP BY blend_ticket_id
    HAVING COUNT(*) > 1
  ) dup ON dup.blend_ticket_id = i.blend_ticket_id
  WHERE i.status NOT IN ('voided','cancelled')
    AND i.deleted_at IS NULL
    AND i.job_id IS NULL   -- already handled above if it has a job_id
    AND p_job_id IS NULL;  -- blend-ticket scope only in full-refresh mode

  -- ── FLAG 4: REI Not Cleared ───────────────────────────────────────────────
  -- For each chemical in a job, check if a PRIOR completed job applied the same
  -- product to the SAME field within the last max(products.rei_hours) hours.
  -- Degrade gracefully when rei_hours is NULL on the product.
  INSERT INTO watchdog_flags (flag_type, severity, entity_type, entity_id,
                               job_id, product_id, field_id, customer_id, message, detail)
  SELECT DISTINCT ON (j.id, jc.product_id, jf.field_id)
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
  -- Prior job: same product, same field, completed, within REI window
  JOIN LATERAL (
    SELECT pj.id, pj.job_number, pj.job_date
    FROM jobs pj
    JOIN job_chemicals pjc ON pjc.job_id = pj.id AND pjc.product_id = jc.product_id
    JOIN job_fields pjf ON pjf.job_id = pj.id AND pjf.field_id = jf.field_id
    WHERE pj.id <> j.id
      AND pj.deleted_at IS NULL
      AND pj.status IN ('completed','invoiced')
      AND pj.job_date < j.job_date
      -- REI window not yet elapsed (using job_date as proxy; hours comparison)
      AND EXTRACT(EPOCH FROM (j.job_date::timestamptz - pj.job_date::timestamptz)) / 3600
          < p.rei_hours
    ORDER BY pj.job_date DESC
    LIMIT 1
  ) prior_j ON true
  WHERE j.deleted_at IS NULL
    AND j.status IN ('completed','invoiced')
    AND p.rei_hours IS NOT NULL
    AND p.rei_hours > 0
    AND (p_job_id IS NULL OR j.id = p_job_id);

  -- Return summary
  SELECT COUNT(*) INTO v_inserted FROM watchdog_flags;
  RETURN jsonb_build_object(
    'flags_total',   v_inserted,
    'flags_deleted', v_deleted,
    'scope',         CASE WHEN p_job_id IS NOT NULL THEN 'job:' || p_job_id::text ELSE 'all' END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION refresh_watchdog_flags(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION refresh_watchdog_flags(uuid, numeric, numeric) TO authenticated;

-- ─── Comments ─────────────────────────────────────────────────────────────────
COMMENT ON TABLE watchdog_flags IS
  'Advisory watchdog flags for suspicious job/invoice records. Never blocks — advisory only.';
COMMENT ON TABLE watchdog_flag_dismissals IS
  'Dismissal records (looks_fine | needs_fix) for watchdog flags. Logged for audit trail.';

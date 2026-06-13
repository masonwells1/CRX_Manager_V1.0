-- ============================================================================
-- Fix plpgsql_check 42P01 (2026-06-10 error-prevention sweep, execution log
-- docs/audits/2026-06-10-error-prevention-execution-log.md §4 item 1):
-- create_job_from_quote_section INSERTs into relation activity_log, WHICH
-- DOES NOT EXIST (to_regclass('public.activity_log') IS NULL, live-verified
-- 2026-06-10). The correct relation is activity_feed.
-- ----------------------------------------------------------------------------
-- RUNTIME IMPACT (why this is not just lint noise): plpgsql resolves a
-- statement's relations at first execution of that statement, so EVERY call
-- that reaches the logging INSERT raises 42P01 and aborts the whole
-- transaction — the just-created job, job_fields, and job_chemicals rows all
-- roll back with it. "Schedule Job" from QuoteBuilder
-- (src/pages/QuoteBuilder.tsx:1200, the function's only caller) fails 100% of
-- the time. This fix therefore unbreaks job-from-quote-section creation
-- entirely, not merely the activity logging.
--
-- BASELINE (verbatim-from-live discipline):
--   create_job_from_quote_section(p_quote_id uuid, p_section_id uuid,
--     p_performed_by uuid, p_idempotency_key text)
--   live prosrc md5: 71125a16b6b2652fc6a7add0612b45b7
--     (captured 2026-06-10 via md5(prosrc); single overload; SECURITY DEFINER;
--      proconfig search_path=public, pg_temp; proacl grantees
--      {postgres, authenticated, service_role} — no anon, no PUBLIC)
--   The live body is the 20260609195843 strict-actor version with the disk
--   file's inline comments stripped — as with 20260610191456, the LIVE
--   catalog text (NOT the disk text) is the verbatim base below.
--   Precedent for the activity_feed column shape (read-only reference, that
--   function is NOT touched here): draw_down_quote live prosrc md5
--   a1bba5327bed9c8d97f1622514e571e4 logs
--   INSERT INTO activity_feed (event_type, description, performed_by,
--     related_entity_type, related_entity_id, customer_id).
--
-- DELTAS, exhaustively — there is exactly ONE, sentinel-delimited F1<<< >>>F1:
--   (F1) The single broken logging statement — previously targeting
--        activity_log with columns (action, entity_type, entity_id,
--        performed_by, details) and event token 'job_created_from_quote' —
--        is re-pointed to activity_feed using its live column shape
--        (event_type, description, performed_by, related_entity_type,
--        related_entity_id, customer_id; live-verified 2026-06-10:
--        performed_by NOT NULL FK->profiles, customer_id FK->customers,
--        event_type/description NOT NULL text with no CHECK constraint).
--        The event token 'job_created_from_quote' is kept. The old jsonb
--        details payload (job_number, quote_id, quote_number, section_name)
--        is folded into the description text — activity_feed has no jsonb
--        column; quote_id/job linkage is carried by related_entity_id +
--        the description. NULL-safety: v_job_number (next_job_number()) and
--        v_quote.quote_number are never NULL; a NULL section_name is handled
--        by COALESCE so description (NOT NULL) cannot become NULL; v_actor
--        is auth.uid(), proven non-NULL and an existing active profiles row
--        by the strict-actor gate above it, satisfying the performed_by FK.
--   Everything else is byte-identical to the live baseline. The idempotency
--   default is written `DEFAULT NULL` (live canonical form NULL::text) per
--   the 20260609195843 precedent to avoid the cross-function ::text
--   proximity heuristic — no behavioral difference.
--
-- GRANTS: restated verbatim to the live ACL ({postgres owner, authenticated,
-- service_role}; anon and PUBLIC have nothing) and asserted in the
-- self-verification block. CREATE OR REPLACE preserves the ACL; the explicit
-- statements below make the intended state self-documenting.
-- caller-analysis: create_job_from_quote_section — exactly 1 caller:
--   src/pages/QuoteBuilder.tsx:1200 ("Schedule Job", admin/sales_rep route,
--   passes p_performed_by=profile.id + useIdempotencyKey key). No Edge
--   Function, cron, or SQL callers. The REVOKE/GRANT pair below is a no-op
--   restatement of the live ACL: no role gains or loses EXECUTE.
--
-- Self-verification (bottom): overloads=1, F1 sentinel markers present in
-- prosrc, activity_feed referenced and activity_log absent from prosrc,
-- SECURITY DEFINER + search_path retained, grant assertions
-- (authenticated yes / anon no / service_role yes).
-- Smoke (rolled back, run post-apply):
--   scripts/smoke/smoke-job_from_quote_activity_feed_fix.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
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
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
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
$function$;

-- ----------------------------------------------------------------------------
-- Grants: restate the live ACL verbatim (no role gains or loses EXECUTE; see
-- the caller-analysis disposition in the header).
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.create_job_from_quote_section(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_job_from_quote_section(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'create_job_from_quote_section' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_job_from_quote_section overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'create_job_from_quote_section' AND pronamespace = 'public'::regnamespace;

  -- The F1 delta sentinels must be present in the deployed body
  IF v_src NOT LIKE '%F1<<<%' OR v_src NOT LIKE '%>>>F1%' THEN
    RAISE EXCEPTION 'create_job_from_quote_section: F1 delta sentinel markers missing from prosrc';
  END IF;

  -- The fix itself: activity_feed (with its column shape) in, activity_log gone.
  -- NOTE: the token scan below is deliberately strict (bare token, zero
  -- occurrences) — the F1 in-body comment therefore must never spell the old
  -- relation name, or this assertion will (correctly) abort the apply.
  -- Mentions outside the dollar-quoted body (header, this DO block) are fine.
  IF v_src NOT LIKE '%INSERT INTO activity_feed (event_type, description, performed_by,%' THEN
    RAISE EXCEPTION 'create_job_from_quote_section: activity_feed INSERT missing from prosrc';
  END IF;
  IF position('activity_log' IN v_src) > 0 THEN
    RAISE EXCEPTION 'create_job_from_quote_section: prosrc still references the nonexistent activity_log relation';
  END IF;

  -- The target relation must actually exist (and the broken one must not)
  IF to_regclass('public.activity_feed') IS NULL THEN
    RAISE EXCEPTION 'activity_feed relation missing — fix target invalid';
  END IF;
  IF to_regclass('public.activity_log') IS NOT NULL THEN
    RAISE EXCEPTION 'activity_log unexpectedly exists — re-evaluate this fix before applying';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'create_job_from_quote_section' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'create_job_from_quote_section must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL: authenticated keeps EXECUTE (strict-actor gate is the in-body
  -- control), anon must not have it, service_role must.
  IF NOT has_function_privilege('authenticated', 'public.create_job_from_quote_section(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_job_from_quote_section: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.create_job_from_quote_section(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_job_from_quote_section: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.create_job_from_quote_section(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_job_from_quote_section: service_role lost EXECUTE';
  END IF;
END $$;

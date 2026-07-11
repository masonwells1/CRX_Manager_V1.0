-- ============================================================================
-- APPLIED LIVE 2026-07-02 (structure-fix loop, Wave A / A12) via gated MCP apply_migration
-- with Mason's explicit OK. Reviewers rls-security + migration-drift = CLEAN; verified live
-- post-apply: 1 overload, SECDEF + search_path=public,pg_temp, ACL authenticated (no anon).
--
-- WHAT: New RPC save_field_crop_history(field_id, season, crop_type, ...) that
--       INSERT..ON CONFLICT (field_id, season) upserts a field_crop_history row.
-- WHY:  field_crop_history.harvest_date / variety / planting_date / yield /
--       notes currently have NO write path. The only writer is the trigger
--       snapshot_field_crop_history, which fires on a field's crop_type change and
--       writes ONLY (field_id, season, crop_type) — the office can never record a
--       harvest date, variety, yield, or notes (the PHI / crop-record gap, A12).
--       FieldDashboard's Crop History tab is read-only today.
-- SCOPE: additive — one brand-new function (no existing overload; confirmed
--        save_field_crop_history absent from pg_proc pre-apply). Nothing else changes.
--        The auto-trigger is deliberately untouched: on conflict it updates ONLY
--        crop_type (EXCLUDED.crop_type), so it will not clobber a manual harvest_date.
-- PATTERN (verified against live manual_inventory_add, the house template):
--        SECURITY DEFINER + SET search_path = public, pg_temp; strict-actor
--        (auth.uid(); ACTOR_MISMATCH on p_performed_by mismatch); role gate
--        admin/sales_rep — MIRRORS the live field_crop_history INSERT/UPDATE RLS
--        (is_admin() OR is_sales_rep()); NOT applicator (applicator has SELECT only).
--        Idempotency via the canonical check_idempotency / save_idempotency helpers
--        (both search_path-safe). Season derived with compute_season when p_season NULL.
--        Conflict target = the live UNIQUE index idx_field_crop_history_unique (field_id, season).
--        field_crop_history has NO updated_at column — none is written.
--        anon EXECUTE revoked; authenticated granted (matches manual_inventory_add ACL).
--
-- SMOKE (2026-07-02, live tx aborted via summary RAISE — NOTHING persisted; verified
--   save_field_crop_history absent from live pg_proc post-run, count=0):
--   plpgsql_check_function('save_field_crop_history(uuid,integer,text,text,date,date,
--   numeric,text,text,uuid,text)') = NO FINDINGS - CLEAN.
-- CODEX (gpt-5.5 xhigh, --uncommitted, 2 rounds this session): R1 found ONE real P2 —
--   blank "Add Entry" could upsert NULLs over an EXISTING season's variety/dates/yield/
--   notes (the auto-trigger commonly creates a current-season row) → FIXED: Add mode now
--   ONLY offers seasons that have no row yet + a handleSave guard; editing an existing
--   season prefills via the row pencil. R2 confirmed that data-loss P2 is RESOLVED. R2's
--   only remaining note is the EXPECTED parked-coupling (the UI needs this RPC live) —
--   not a code defect; handled by the DRAFT/APPLY ordering below.
-- APPLY ORDER: this migration is ADDITIVE (new RPC; no existing caller). Apply it FIRST,
--   regenerate supabase types, THEN merge/deploy the FieldDashboard frontend. Never deploy
--   the frontend ahead of this migration (the Save button would hit PostgREST 404).
-- ============================================================================

-- idempotency-body-check: exempt (uses check_idempotency/save_idempotency helpers)

CREATE OR REPLACE FUNCTION public.save_field_crop_history(
  p_field_id        uuid,
  p_season          integer,
  p_crop_type       text,
  p_variety         text    DEFAULT NULL,
  p_planting_date   date    DEFAULT NULL,
  p_harvest_date    date    DEFAULT NULL,
  p_yield_per_acre  numeric DEFAULT NULL,
  p_yield_unit      text    DEFAULT NULL,
  p_notes           text    DEFAULT NULL,
  p_performed_by    uuid    DEFAULT NULL,
  p_idempotency_key text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor        uuid;
  v_season       integer;
  v_id           uuid;
  v_idemp        jsonb;
  v_result       jsonb;
BEGIN
  -- strict-actor (canonical) --------------------------------------------------
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- idempotency replay --------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    v_idemp := check_idempotency(p_idempotency_key, 'save_field_crop_history');
    IF v_idemp IS NOT NULL THEN RETURN v_idemp; END IF;
  END IF;

  -- validate inputs -----------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM fields WHERE id = p_field_id) THEN
    RAISE EXCEPTION 'FIELD_NOT_FOUND';
  END IF;
  IF p_crop_type IS NULL OR btrim(p_crop_type) = '' THEN
    RAISE EXCEPTION 'CROP_TYPE_REQUIRED';
  END IF;

  -- season: explicit if provided, else derive from planting date / today ------
  v_season := COALESCE(p_season, compute_season(COALESCE(p_planting_date, CURRENT_DATE)));

  -- upsert on the (field_id, season) unique index -----------------------------
  INSERT INTO field_crop_history (
    field_id, season, crop_type, variety, planting_date, harvest_date,
    yield_per_acre, yield_unit, notes
  ) VALUES (
    p_field_id, v_season, btrim(p_crop_type), p_variety, p_planting_date, p_harvest_date,
    p_yield_per_acre, p_yield_unit, p_notes
  )
  ON CONFLICT (field_id, season) DO UPDATE SET
    crop_type      = EXCLUDED.crop_type,
    variety        = EXCLUDED.variety,
    planting_date  = EXCLUDED.planting_date,
    harvest_date   = EXCLUDED.harvest_date,
    yield_per_acre = EXCLUDED.yield_per_acre,
    yield_unit     = EXCLUDED.yield_unit,
    notes          = EXCLUDED.notes
  RETURNING id INTO v_id;

  v_result := jsonb_build_object('success', true, 'id', v_id, 'season', v_season);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_crop_history', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_field_crop_history(uuid, integer, text, text, date, date, numeric, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_field_crop_history(uuid, integer, text, text, date, date, numeric, text, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_field_crop_history(uuid, integer, text, text, date, date, numeric, text, text, uuid, text) TO authenticated;

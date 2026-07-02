-- Layer 2 · Part A · Cycle A4 — job inventory reserve engine (the core)
-- ============================================================================
-- Makes a scheduled/in_progress job EARMARK (soft-reserve) its job_chemicals so
-- two dispatchers can't double-book the same stock and a shortfall surfaces at
-- schedule time. Owner decisions: §6.1 WARN (never block) · §6.2 auto-reserve ·
-- §6.3 expires_at = NULL · §6.5 job draw consumes the quote's booking · §6.6 no
-- backfill (the triggers only fire on FUTURE writes).
--
-- Pieces:
--   _sync_job_holds(job, actor)  — the engine (rebuild-from-scratch). Locks job →
--       parent quote → per-product inventory row; job hold = FULL job demand
--       (source_id=job_id, expires_at=NULL); job_product_draws = LEAST(demand,
--       remaining quote booking) for planned parents; resyncs the parent quote
--       via _sync_planned_holds (A2). RELEASE branch for terminal/deleted jobs:
--       drops the job hold; REVERSES the draw only for cancelled/soft-deleted
--       jobs (a completed/invoiced job CONSUMED its draw — stock is deducted by
--       complete_job — so its draw and the quote's reduced booking persist).
--       Returns {shortfalls:[...]} (warn text). Warn-only.
--   job_chemicals statement triggers  — auto-fire on INSERT/UPDATE/DELETE (all 3
--       job_chemicals writers funnel through here). §6.2 auto-reserve.
--   jobs lifecycle trigger  — job holds are non-expiring (§6.3), so this is their
--       ONLY release path: on any status / soft-delete change, re-run the engine
--       (reserves if scheduled/in_progress, releases otherwise). Without this a
--       completed/cancelled/deleted job would strand its reservation forever.
--   reserve_job_inventory(job, actor)  — explicit SECDEF entry returning the warn
--       shortfalls so a dispatcher sees warnings on demand.
--
-- status-enum-check: exempt
--   (writes the inventory_holds.hold_type literal 'job'; the CHECK was extended
--    to a superset in A1 20260702170000. Registry is regenerated post-apply.)
-- ============================================================================

-- ── Engine ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._sync_job_holds(p_job_id uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job jobs%ROWTYPE;
  v_quote quotes%ROWTYPE;
  v_planned_open boolean := false;
  v_actor uuid;
  v_item RECORD;
  v_job_demand numeric;
  v_quote_booking numeric;
  v_order_drawn numeric;
  v_other_job_drawn numeric;
  v_remaining numeric;
  v_job_drawn numeric;
  v_free numeric;
  v_shortfalls jsonb := '[]'::jsonb;
BEGIN
  v_actor := COALESCE(p_actor, auth.uid());

  -- Lock the job first, then the parent quote (matches _sync_planned_holds /
  -- draw_down_quote lock order: quote-descended work locks the quote before
  -- inventory).
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('shortfalls', v_shortfalls); END IF;

  IF v_job.quote_id IS NOT NULL THEN
    SELECT * INTO v_quote FROM quotes
    WHERE id = v_job.quote_id AND deleted_at IS NULL
    FOR UPDATE;
    v_planned_open := FOUND
      AND v_quote.is_planned
      AND v_quote.status NOT IN ('declined', 'expired', 'cancelled');
  END IF;

  -- RELEASE state: a deleted or terminal job holds nothing. Drop its job holds.
  -- Reverse the DRAW only when the reserved chemical was NEVER applied — i.e. a
  -- cancelled job, or a job soft-deleted while still scheduled/in_progress.
  -- (Codex A+B P1 #1) A COMPLETED or INVOICED job consumed its draw (complete_job
  -- already deducted the real stock); soft-deleting it later must NOT reverse the
  -- draw, or the parent quote would regain drawable/rollable balance for chemical
  -- that was physically applied.
  IF v_job.deleted_at IS NOT NULL OR v_job.status NOT IN ('scheduled', 'in_progress') THEN
    DELETE FROM inventory_holds WHERE source_id = p_job_id AND hold_type = 'job';
    IF v_job.status = 'cancelled'
       OR (v_job.deleted_at IS NOT NULL AND v_job.status IN ('scheduled', 'in_progress')) THEN
      DELETE FROM job_product_draws WHERE job_id = p_job_id;
    END IF;
    IF v_job.quote_id IS NOT NULL THEN
      PERFORM _sync_planned_holds(v_job.quote_id, v_actor);
    END IF;
    RETURN jsonb_build_object('shortfalls', v_shortfalls);
  END IF;

  -- RESERVE: rebuild this job's draws + holds from scratch.
  DELETE FROM inventory_holds WHERE source_id = p_job_id AND hold_type = 'job';
  DELETE FROM job_product_draws WHERE job_id = p_job_id;

  FOR v_item IN
    -- Demand in INVENTORY units (Codex P1): convert each chemical's quantity from
    -- its unit to the product's inventory_unit — matching complete_job's
    -- deduction and the quote booking (which is stored in inventory units). 1:1
    -- when the units already match (the common case). Fall back to the raw
    -- quantity for a blank/unconvertible unit so the warn-only reserve never
    -- raises (unlike complete_job, which does).
    SELECT jc.product_id,
           SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL
    GROUP BY jc.product_id
    HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) > 0
  LOOP
    v_job_demand := v_item.job_demand;
    v_job_drawn := 0;

    -- Lock the product's inventory row FIRST (Codex P2): serializes concurrent
    -- reservations of the same product so the shortfall read below sees the
    -- other transaction's committed hold instead of both missing the warning.
    -- Quote is already locked above; lock order quote -> inventory matches
    -- draw_down_quote. (No row = a product with no stock; nothing to serialize,
    -- and the shortfall loop reports the full demand.)
    PERFORM 1 FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF v_planned_open THEN
      -- Quote-wide booking for this product (matches quote_product_draws grain).
      SELECT COALESCE(SUM(qi.total_units_needed), 0) INTO v_quote_booking
      FROM quote_items qi
      WHERE qi.quote_id = v_job.quote_id AND qi.product_id = v_item.product_id;

      SELECT COALESCE(quantity_drawn, 0) INTO v_order_drawn
      FROM quote_product_draws
      WHERE quote_id = v_job.quote_id AND product_id = v_item.product_id;
      v_order_drawn := COALESCE(v_order_drawn, 0);

      -- Other jobs' draws (this job's rows were just deleted above).
      SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_other_job_drawn
      FROM job_product_draws
      WHERE quote_id = v_job.quote_id AND product_id = v_item.product_id;

      v_remaining := GREATEST(v_quote_booking - v_order_drawn - v_other_job_drawn, 0);
      v_job_drawn := LEAST(v_job_demand, v_remaining);

      IF v_job_drawn > 0 THEN
        INSERT INTO job_product_draws (job_id, quote_id, product_id, quantity_drawn)
        VALUES (p_job_id, v_job.quote_id, v_item.product_id, v_job_drawn)
        ON CONFLICT (job_id, product_id)
        DO UPDATE SET quantity_drawn = EXCLUDED.quantity_drawn, updated_at = now();
      END IF;
    END IF;

    -- The job hold reserves the FULL job demand. The drawn portion shrinks the
    -- quote's crop_program hold (resync below), so quote_remaining + job_hold
    -- never exceeds the booking. expires_at = NULL (§6.3).
    INSERT INTO inventory_holds (
      product_id, customer_id, quantity, hold_type, source_id,
      notes, created_by, expires_at, is_active
    ) VALUES (
      v_item.product_id, v_job.customer_id, v_job_demand, 'job', p_job_id,
      'Job reservation for ' || COALESCE(v_job.job_number, p_job_id::text),
      COALESCE(v_actor, v_job.created_by), NULL, true
    );
  END LOOP;

  -- Resync the parent quote's crop_program holds to account for this job's draws
  -- (A2 made _sync_planned_holds job-draw-aware). Before computing warn
  -- shortfalls so free reflects the final hold state.
  IF v_planned_open THEN
    PERFORM _sync_planned_holds(v_job.quote_id, v_actor);
  END IF;

  -- WARN (never block, §6.1): per product, free = available − prebooked − active
  -- non-expired holds. Negative free (or no inventory row) => short.
  FOR v_item IN
    -- Demand in INVENTORY units (Codex P1): convert each chemical's quantity from
    -- its unit to the product's inventory_unit — matching complete_job's
    -- deduction and the quote booking (which is stored in inventory units). 1:1
    -- when the units already match (the common case). Fall back to the raw
    -- quantity for a blank/unconvertible unit so the warn-only reserve never
    -- raises (unlike complete_job, which does).
    SELECT jc.product_id,
           SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) AS job_demand
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id AND jc.product_id IS NOT NULL
    GROUP BY jc.product_id
    HAVING SUM(COALESCE(field_app_priced_quantity(jc.quantity, jc.unit, p.inventory_unit, p.product_form), jc.quantity)) > 0
  LOOP
    SELECT inv.quantity_available - inv.quantity_prebooked
           - COALESCE((
               SELECT SUM(h.quantity) FROM inventory_holds h
               WHERE h.product_id = v_item.product_id AND h.is_active = true
                 AND (h.expires_at IS NULL OR h.expires_at >= CURRENT_DATE)
             ), 0)
      INTO v_free
    FROM inventory inv
    WHERE inv.product_id = v_item.product_id AND inv.location = 'Main Warehouse';

    IF v_free IS NULL THEN
      -- No Main Warehouse inventory row => the whole demand is short (Codex P2).
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'product_id', v_item.product_id,
        'product_name', (SELECT product_name FROM products WHERE id = v_item.product_id),
        'short', v_item.job_demand
      );
    ELSIF v_free < 0 THEN
      v_shortfalls := v_shortfalls || jsonb_build_object(
        'product_id', v_item.product_id,
        'product_name', (SELECT product_name FROM products WHERE id = v_item.product_id),
        'short', -v_free
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('shortfalls', v_shortfalls);
END;
$function$;

-- ── Auto-reserve: job_chemicals statement triggers ──────────────────────────
CREATE OR REPLACE FUNCTION public._trg_sync_job_holds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT job_id FROM affected WHERE job_id IS NOT NULL LOOP
    PERFORM _sync_job_holds(r.job_id, auth.uid());
  END LOOP;
  RETURN NULL;  -- AFTER STATEMENT: return value ignored
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_job_holds_ins ON public.job_chemicals;
CREATE TRIGGER trg_sync_job_holds_ins
  AFTER INSERT ON public.job_chemicals
  REFERENCING NEW TABLE AS affected
  FOR EACH STATEMENT EXECUTE FUNCTION public._trg_sync_job_holds();

DROP TRIGGER IF EXISTS trg_sync_job_holds_upd ON public.job_chemicals;
CREATE TRIGGER trg_sync_job_holds_upd
  AFTER UPDATE ON public.job_chemicals
  REFERENCING NEW TABLE AS affected
  FOR EACH STATEMENT EXECUTE FUNCTION public._trg_sync_job_holds();

DROP TRIGGER IF EXISTS trg_sync_job_holds_del ON public.job_chemicals;
CREATE TRIGGER trg_sync_job_holds_del
  AFTER DELETE ON public.job_chemicals
  REFERENCING OLD TABLE AS affected
  FOR EACH STATEMENT EXECUTE FUNCTION public._trg_sync_job_holds();

-- ── Lifecycle release: jobs status / soft-delete trigger (Codex P1) ──────────
-- Job holds never expire (§6.3), so they are released ONLY here. Any status or
-- deleted_at change re-runs the engine: it reserves when scheduled/in_progress
-- and releases (dropping the job hold, reversing the draw for cancelled/deleted)
-- otherwise. Without this, a completed/cancelled/invoiced/soft-deleted job would
-- strand its non-expiring reservation (and the parent quote's reduced booking).
CREATE OR REPLACE FUNCTION public._trg_release_job_holds_on_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM _sync_job_holds(NEW.id, auth.uid());
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_release_job_holds_on_lifecycle ON public.jobs;
CREATE TRIGGER trg_release_job_holds_on_lifecycle
  AFTER UPDATE OF status, deleted_at ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public._trg_release_job_holds_on_lifecycle();

-- ── Explicit entry: reserve_job_inventory (returns the warn shortfalls) ──────
CREATE OR REPLACE FUNCTION public.reserve_job_inventory(
  p_job_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- idempotency-body-check: exempt
-- No p_idempotency_key by design: _sync_job_holds is rebuild-from-scratch
-- (naturally idempotent — a replay re-reserves with no duplicate side effect)
-- and returns the CURRENT shortfalls, which a cached-replay key would stale.
DECLARE
  v_actor uuid;
  v_role text;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  v_result := _sync_job_holds(p_job_id, v_actor);
  RETURN jsonb_build_object('success', true) || v_result;
END;
$function$;

-- ── Grants: engine + trigger fns are internal (owner-invoked); the RPC is
--    frontend-callable by staff. anon revoked on all (Layer 2 §7). ────────────
REVOKE ALL ON FUNCTION public._sync_job_holds(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_job_holds(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public._trg_sync_job_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._trg_sync_job_holds() TO service_role;

REVOKE ALL ON FUNCTION public._trg_release_job_holds_on_lifecycle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._trg_release_job_holds_on_lifecycle() TO service_role;

REVOKE ALL ON FUNCTION public.reserve_job_inventory(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_job_inventory(uuid, uuid) TO authenticated, service_role;

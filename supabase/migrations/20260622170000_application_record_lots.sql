-- B1 Lot Capture & Trace — core migration (ADDITIVE; no existing column/money/lifecycle changes).
--
-- WHY: chemical LOT/batch numbers are tracked only on paper today. This brings lot into the
-- system and links it to what was actually applied, so the business can answer the recall /
-- compliance question: "which lot of which product went on which field, on what date, for which
-- customer?" Scope is CAPTURE & TRACE ONLY — no inventory-per-lot math (deferred Wave C).
--
-- WHAT THIS ADDS:
--   1. New table application_record_lots — one row per (application record, product, lot);
--      multiple lots per product allowed. RLS mirrors application_records.
--   2. RPC set_application_record_lots(...) — replace-the-lots save for one application record
--      (canonical idempotency via check_idempotency/save_idempotency, strict-actor, in-body role
--      gate, parent FOR UPDATE race lock, validates each product_id is on the record).
--   3. RPC get_recent_lots_for_product(uuid) — recent distinct received lots for the app-time
--      suggestion dropdown (read-only, admin/sales).
--   4. RPC get_lot_application_trace(text) — the compliance payoff: every application that used a
--      lot (product, field(s), date, customer, applicator, record #, invoice). Reads
--      application_record_lots as the source of truth (case-insensitive lot match).
--   5. CREATE OR REPLACE create_application_record_from_blend_ticket — reproduced VERBATIM from the
--      live body with ONLY a lot-propagation INSERT added (auto-fills lots from
--      blend_ticket_products.lot_number so blend-sourced applications get lots with no re-typing).
--
-- PROOF: exercised via rolled-back BEGIN..ROLLBACK smoke against live (zero footprint). NOT applied
-- to prod by the build loop — apply is the owner's gate (see HANDOFF.md).
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.get_lot_application_trace(text);
--   DROP FUNCTION IF EXISTS public.get_recent_lots_for_product(uuid);
--   DROP FUNCTION IF EXISTS public.set_application_record_lots(uuid, jsonb, uuid, text);
--   DROP TABLE IF EXISTS public.application_record_lots;
--   -- and restore the prior create_application_record_from_blend_ticket body.

-- ============================================================================
-- 1. TABLE: application_record_lots
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.application_record_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_record_id uuid NOT NULL REFERENCES public.application_records(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  lot_number text NOT NULL,
  source_receiving_record_id uuid REFERENCES public.receiving_records(id) ON DELETE SET NULL,
  quantity_from_lot numeric,
  unit text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id),
  -- No updated_at: rows are REPLACED (delete + reinsert) by the save RPC, never edited in place.
  CONSTRAINT application_record_lots_lot_number_not_blank CHECK (btrim(lot_number) <> ''),
  -- quantity_from_lot is "how much from this lot" — a negative would corrupt the compliance
  -- trace; reject it (NULL = not recorded, which is fine).
  CONSTRAINT application_record_lots_quantity_non_negative CHECK (quantity_from_lot IS NULL OR quantity_from_lot >= 0)
);

CREATE INDEX IF NOT EXISTS idx_arl_application_record ON public.application_record_lots(application_record_id);
CREATE INDEX IF NOT EXISTS idx_arl_product ON public.application_record_lots(product_id);
-- Indexes the EXACT normalized expression get_lot_application_trace filters on
-- (lower(btrim(lot_number))) so recall lookups by lot use this index instead of seq-scanning.
CREATE INDEX IF NOT EXISTS idx_arl_lot_lower ON public.application_record_lots(lower(btrim(lot_number)));
-- One row per (application record, product, normalized lot) — the SOW invariant. Case-insensitive
-- so the recall trace (which matches case-insensitively) can never double-list the same applied lot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_arl_unique_record_product_lot
  ON public.application_record_lots (application_record_id, product_id, lower(btrim(lot_number)));

ALTER TABLE public.application_record_lots ENABLE ROW LEVEL SECURITY;

-- RLS: WRITES ARE RPC-ONLY. All legitimate inserts/updates/deletes go through the
-- SECURITY DEFINER RPCs below (set_application_record_lots + the blend-ticket propagation),
-- which run as the table owner and bypass RLS while enforcing product-on-record, source-receipt,
-- duplicate-lot, and quantity validation. There is intentionally NO client INSERT/UPDATE/DELETE
-- policy, so a direct PostgREST write (even by admin/sales) is denied by RLS default-deny — that
-- closes the bypass where a direct write could push an unvalidated row into the compliance trace
-- (Codex P2). Clients get a SELECT policy only: admin/sales, OR an applicator on their OWN records
-- (explicit join to the parent's applicator_id — the lot row has no applicator_id of its own).
-- DROP-then-CREATE so the migration is re-runnable after a partial apply (DATABASE_CHANGE_CHECKLIST);
-- the arl_insert/update/delete drops also retire those policies if an earlier draft created them.
DROP POLICY IF EXISTS arl_select ON public.application_record_lots;
DROP POLICY IF EXISTS arl_insert ON public.application_record_lots;
DROP POLICY IF EXISTS arl_update ON public.application_record_lots;
DROP POLICY IF EXISTS arl_delete ON public.application_record_lots;

CREATE POLICY arl_select ON public.application_record_lots
  FOR SELECT TO authenticated
  USING (
    is_admin() OR is_sales_rep() OR (
      is_applicator() AND EXISTS (
        SELECT 1 FROM public.application_records ar
        WHERE ar.id = application_record_id
          AND ar.applicator_id = (SELECT auth.uid())
      )
    )
  );

-- ============================================================================
-- 2. RPC: set_application_record_lots — replace-the-lots save for one record
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_application_record_lots(
  p_application_record_id uuid,
  p_lots jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_rec            record;
  v_lot            jsonb;
  v_product_id     uuid;
  v_lot_number     text;
  v_src            uuid;
  v_valid_products uuid[];
  v_seen           text[] := '{}';
  v_key            text;
  v_count          int := 0;
  v_result         jsonb;
BEGIN
  -- strict-actor (bind auth.uid(); reject a spoofed p_performed_by)
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- in-body role gate (the real gate — the EXECUTE grant is not enough)
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to set application record lots';
  END IF;

  -- lock the parent record FIRST (race safety for the delete+reinsert) and validate it exists
  SELECT * INTO v_rec FROM application_records
   WHERE id = p_application_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APPLICATION_RECORD_NOT_FOUND: %', p_application_record_id;
  END IF;

  -- idempotency check AFTER the lock, BEFORE any mutation: same-key concurrent retries
  -- serialize on the parent FOR UPDATE, so the loser sees the winner's committed key and
  -- replays the cached result instead of re-running the delete/reinsert (Codex P2 — a
  -- pre-lock check let both racers pass before either saved the key).
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'set_application_record_lots');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_lots IS NULL OR jsonb_typeof(p_lots) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_LOTS_PAYLOAD: p_lots must be a JSON array';
  END IF;

  -- valid products = the non-null product_id values in this record's product_data
  SELECT COALESCE(array_agg(DISTINCT (pd->>'product_id')::uuid), '{}')
    INTO v_valid_products
    FROM jsonb_array_elements(v_rec.product_data) pd
   WHERE NULLIF(pd->>'product_id', '') IS NOT NULL;

  -- replace: clear this record's lots, then reinsert from the payload
  DELETE FROM application_record_lots WHERE application_record_id = p_application_record_id;

  FOR v_lot IN SELECT * FROM jsonb_array_elements(p_lots)
  LOOP
    v_product_id := NULLIF(v_lot->>'product_id', '')::uuid;
    v_lot_number := btrim(COALESCE(v_lot->>'lot_number', ''));

    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'LOT_MISSING_PRODUCT: each lot requires a product_id';
    END IF;
    IF v_lot_number = '' THEN
      RAISE EXCEPTION 'LOT_MISSING_NUMBER: each lot requires a non-blank lot_number';
    END IF;
    IF NOT (v_product_id = ANY (v_valid_products)) THEN
      RAISE EXCEPTION 'PRODUCT_NOT_ON_RECORD: product % is not in this application record', v_product_id;
    END IF;

    -- if a source receiving record is cited, it must actually be for THIS product + lot —
    -- otherwise a stale/edited suggestion would point the compliance trace at the wrong
    -- receipt (Codex P2). Free-typed lots pass source_receiving_record_id = NULL (no check).
    v_src := NULLIF(v_lot->>'source_receiving_record_id', '')::uuid;
    IF v_src IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM receiving_records rr
      WHERE rr.id = v_src
        AND rr.product_id = v_product_id
        AND lower(btrim(rr.lot_number)) = lower(v_lot_number)
    ) THEN
      RAISE EXCEPTION 'SOURCE_RECEIPT_MISMATCH: receiving record % is not for product % lot %', v_src, v_product_id, v_lot_number;
    END IF;

    -- one row per (product, normalized lot) within this record (the SOW invariant + the unique
    -- index backstop) — reject a duplicate payload entry with a friendly token instead of a 23505.
    v_key := v_product_id::text || '|' || lower(v_lot_number);
    IF v_key = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_LOT: product % lot % is listed more than once for this record', v_product_id, v_lot_number;
    END IF;
    v_seen := v_seen || v_key;

    INSERT INTO application_record_lots (
      application_record_id, product_id, lot_number,
      source_receiving_record_id, quantity_from_lot, unit, notes, created_by
    ) VALUES (
      p_application_record_id, v_product_id, v_lot_number,
      v_src,
      NULLIF(v_lot->>'quantity_from_lot', '')::numeric,
      NULLIF(v_lot->>'unit', ''),
      NULLIF(v_lot->>'notes', ''),
      v_actor
    );
    v_count := v_count + 1;
  END LOOP;

  -- Audit trail: lot assignments are recall-critical and this is a replace-all edit (the DELETE
  -- above cleared the prior rows). Record it in the activity feed so a later recall investigation
  -- can see who changed a record's lots and when — created_by on the new rows alone misses edits
  -- (and a clear-to-zero leaves no row at all).
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES (
    'application_record_lots_updated',
    'Lots updated on application record ' || v_rec.record_number || ' — ' || v_count || ' lot(s)',
    v_actor, 'application_record', p_application_record_id, v_rec.customer_id
  );

  v_result := jsonb_build_object('success', true, 'count', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'set_application_record_lots', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_application_record_lots(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_application_record_lots(uuid, jsonb, uuid, text) TO authenticated;

-- ============================================================================
-- 3. RPC: get_recent_lots_for_product — app-time suggestion dropdown (read-only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_recent_lots_for_product(p_product_id uuid)
RETURNS TABLE (
  lot_number text,
  last_received_at timestamptz,
  receiving_record_id uuid,
  source text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required';
  END IF;

  -- One row per distinct (case-insensitive) lot — the newest receiving record for that lot.
  -- receiving_record_id lets the editor save source_receiving_record_id so the provenance
  -- validation path in set_application_record_lots fires (a suggested lot keeps its receipt link).
  RETURN QUERY
  SELECT t.lot_number, t.last_received_at, t.receiving_record_id, 'receiving'::text AS source
  FROM (
    SELECT DISTINCT ON (lower(btrim(rr.lot_number)))
           btrim(rr.lot_number) AS lot_number,
           rr.received_at        AS last_received_at,
           rr.id                 AS receiving_record_id
    FROM receiving_records rr
    WHERE rr.product_id = p_product_id
      AND rr.lot_number IS NOT NULL
      AND btrim(rr.lot_number) <> ''
    ORDER BY lower(btrim(rr.lot_number)), rr.received_at DESC
  ) t
  ORDER BY t.last_received_at DESC
  LIMIT 50;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_recent_lots_for_product(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recent_lots_for_product(uuid) TO authenticated;

-- ============================================================================
-- 4. RPC: get_lot_application_trace — recall / compliance lookup (read-only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_lot_application_trace(p_lot_number text)
RETURNS TABLE (
  application_record_id uuid,
  record_number text,
  product_id uuid,
  product_name text,
  lot_number text,
  quantity_from_lot numeric,
  unit text,
  application_date date,
  customer_id uuid,
  customer_name text,
  applicator_id uuid,
  applicator_name text,
  field_names text,
  invoice_id uuid,
  source_receiving_record_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required';
  END IF;

  RETURN QUERY
  SELECT
    arl.application_record_id,
    ar.record_number,
    arl.product_id,
    p.product_name,
    arl.lot_number,
    arl.quantity_from_lot,
    arl.unit,
    ar.application_date,
    ar.customer_id,
    c.farm_name AS customer_name,
    ar.applicator_id,
    pr.full_name AS applicator_name,
    -- prefer the per-field acres rows; fall back to the legacy single application_records.field_id
    -- so single-field / legacy records (and blend records with no blend_ticket_fields) still answer
    -- "which field received this lot" (Codex P2).
    COALESCE(
      (SELECT string_agg(f.field_name, ', ' ORDER BY arf.sort_order)
         FROM application_record_fields arf
         JOIN fields f ON f.id = arf.field_id
        WHERE arf.application_record_id = ar.id),
      (SELECT f2.field_name FROM fields f2 WHERE f2.id = ar.field_id)
    ) AS field_names,
    -- Invoiced status. application_records.invoice_id is only set for source_type='job'
    -- (transfer_job_to_invoice); blend-sourced records link via invoices.blend_ticket_id
    -- (create_invoice_from_blend_ticket never stamps ar.invoice_id), so a billed blend ticket
    -- would otherwise read as not-invoiced. Fall back to the most recent ACTIVE blend invoice
    -- so the compliance trace reflects real billing (Codex P2).
    COALESCE(
      ar.invoice_id,
      CASE WHEN ar.source_type = 'blend_ticket' THEN (
        SELECT i.id FROM invoices i
        WHERE i.blend_ticket_id = ar.source_id
          AND i.status NOT IN ('voided', 'cancelled')
          AND i.deleted_at IS NULL
        ORDER BY i.created_at DESC
        LIMIT 1
      ) END
    ) AS invoice_id,
    arl.source_receiving_record_id
  FROM application_record_lots arl
  JOIN application_records ar ON ar.id = arl.application_record_id
  LEFT JOIN products p ON p.id = arl.product_id
  LEFT JOIN customers c ON c.id = ar.customer_id
  LEFT JOIN profiles pr ON pr.id = ar.applicator_id
  WHERE lower(btrim(arl.lot_number)) = lower(btrim(p_lot_number))
  ORDER BY ar.application_date DESC, ar.record_number, p.product_name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_lot_application_trace(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_lot_application_trace(text) TO authenticated;

-- ============================================================================
-- 5. Blend-ticket lot propagation — CREATE OR REPLACE of the live function with
--    ONLY the lot-insert added. The rest of the body is reproduced VERBATIM from
--    the live definition (single overload; idempotency op 'create_app_record_from_bt';
--    strict-actor; FOR UPDATE; short-stock ledger; single record per ticket; uuid[] return).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_application_record_from_blend_ticket(p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_ticket         record;
  v_product_data   jsonb;
  v_season         integer;
  v_bt_product     record;
  v_field          record;
  v_record_id      uuid;
  v_record_ids     uuid[] := '{}';
  v_record_number  text;
  v_applicator_id  uuid;
  v_inv            record;
  v_inv_found      boolean;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_short_count    int := 0;
  v_field_count    int := 0;
  v_first_field_id uuid;
  v_app_time       time;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create application records from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'create_app_record_from_bt';
    IF v_existing IS NOT NULL THEN
      RETURN ARRAY(SELECT jsonb_array_elements_text(v_existing))::uuid[];
    END IF;
  END IF;

  SELECT bt.* INTO v_ticket FROM blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved. Current status: %', v_ticket.review_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM application_records
    WHERE source_type = 'blend_ticket' AND source_id = p_blend_ticket_id
  ) THEN
    RAISE EXCEPTION 'Application record(s) already exist for this blend ticket';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', btp.product_id, 'product_name', btp.product_name,
        'quantity', btp.quantity, 'unit', btp.unit,
        'rate_per_acre', btp.rate_per_acre, 'rate_unit', btp.rate_per_acre_unit,
        'epa_registration', p.epa_registration, 'is_rup', COALESCE(p.is_rup, false)
      ) ORDER BY btp.sequence_order
    ), '[]'::jsonb
  ) INTO v_product_data
  FROM blend_ticket_products btp
  LEFT JOIN products p ON p.id = btp.product_id
  WHERE btp.blend_ticket_id = p_blend_ticket_id;

  v_season := CASE
    WHEN EXTRACT(MONTH FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) >= 10
    THEN EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date) + 1
    ELSE EXTRACT(YEAR FROM COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date)
  END;

  BEGIN
    v_app_time := NULLIF(btrim(v_ticket.ticket_time), '')::time;
  EXCEPTION WHEN OTHERS THEN
    v_app_time := NULL;
  END;

  v_applicator_id := v_ticket.applicator_id;
  IF v_applicator_id IS NULL AND v_ticket.applicator_name IS NOT NULL THEN
    SELECT id INTO v_applicator_id FROM profiles
    WHERE full_name = v_ticket.applicator_name AND role = 'applicator' LIMIT 1;
  END IF;

  SELECT btf.field_id INTO v_first_field_id
    FROM blend_ticket_fields btf
   WHERE btf.blend_ticket_id = p_blend_ticket_id
   ORDER BY btf.sort_order
   LIMIT 1;

  v_record_number := next_application_record_number();
  INSERT INTO application_records (
    record_number, source_type, source_id, customer_id, applicator_id, field_id,
    application_date, application_time, product_data, total_acres,
    total_volume, total_volume_unit, weather_conditions, notes, season, created_by
  ) VALUES (
    v_record_number, 'blend_ticket', p_blend_ticket_id,
    v_ticket.customer_id, v_applicator_id, COALESCE(v_first_field_id, v_ticket.field_id),
    COALESCE(v_ticket.ticket_date, v_ticket.upload_date)::date, v_app_time,
    v_product_data, v_ticket.total_acres,
    v_ticket.total_volume, v_ticket.total_volume_unit, NULL, v_ticket.notes, v_season, p_performed_by
  ) RETURNING id INTO v_record_id;
  v_record_ids := v_record_ids || v_record_id;

  -- B1 lot propagation (ADDED): auto-fill application_record_lots from the blend ticket's
  -- per-product lot numbers so blend-sourced applications carry lots with no re-typing.
  -- Skips null product_id and blank lot_number; dedupes identical (product_id, lot_number)
  -- component rows; source_receiving_record_id stays NULL (these came from the blend, not a
  -- receiving record). Filtering keeps this insert from ever rolling back the whole RPC.
  INSERT INTO application_record_lots (application_record_id, product_id, lot_number, created_by)
  SELECT v_record_id, d.product_id, d.lot_number, p_performed_by
  FROM (
    SELECT DISTINCT ON (btp.product_id, lower(btrim(btp.lot_number)))
           btp.product_id, btrim(btp.lot_number) AS lot_number
    FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id
      AND btp.product_id IS NOT NULL
      AND btp.lot_number IS NOT NULL
      AND btrim(btp.lot_number) <> ''
    ORDER BY btp.product_id, lower(btrim(btp.lot_number))
  ) d;

  FOR v_field IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS acres,
           COALESCE(btf.sort_order, 0) AS sort_order
    FROM blend_ticket_fields btf
    LEFT JOIN fields f ON f.id = btf.field_id
    WHERE btf.blend_ticket_id = p_blend_ticket_id ORDER BY btf.sort_order
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_field.field_id, v_field.acres, v_field.sort_order);
    v_field_count := v_field_count + 1;
  END LOOP;

  FOR v_bt_product IN
    SELECT btp.product_id, btp.quantity FROM blend_ticket_products btp
    WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL AND btp.quantity > 0
  LOOP
    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_bt_product.quantity;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_bt_product.product_id, 'Main Warehouse', -v_bt_product.quantity, 0, 0);
    ELSE
      UPDATE inventory
      SET quantity_available = quantity_available - v_bt_product.quantity,
          updated_at         = now()
      WHERE product_id = v_bt_product.product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, requires_review
    ) VALUES (
      v_bt_product.product_id, 'job_applied', v_bt_product.quantity, 'Main Warehouse',
      p_performed_by,
      'Blend ticket application: ' || v_ticket.ticket_number ||
        ' (application record ' || v_record_id::text || ')' ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      v_short_flag
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'application_record_created',
    'Application record ' || v_record_number || ' created from blend ticket ' || v_ticket.ticket_number ||
      ' (' || v_field_count || ' field(s))' ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END,
    p_performed_by, 'blend_ticket', p_blend_ticket_id, v_ticket.customer_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_app_record_from_bt', to_jsonb(v_record_ids));
  END IF;

  RETURN v_record_ids;
END;
$function$;

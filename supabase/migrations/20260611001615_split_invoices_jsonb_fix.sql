-- ============================================================================
-- Fix plpgsql_check 42804 (2026-06-10 error-prevention review §4.1 follow-up
-- queue): create_split_invoices_from_order writes TEXT into
-- idempotency_keys.result (jsonb) — the exact create_quote_version class
-- fixed 2026-06-09 (20260609195843: ::text -> to_jsonb).
-- ----------------------------------------------------------------------------
-- BUG + EVIDENCE
-- * idempotency_keys.result is jsonb (information_schema, verified live
--   2026-06-10). The live body's idempotency save is:
--     INSERT INTO idempotency_keys (idempotency_key, operation, result)
--     VALUES (p_idempotency_key, 'create_split_invoices_from_order',
--             array_to_string(v_invoice_ids, ','));
--   array_to_string() returns text and there is no implicit text->jsonb
--   assignment cast, so the statement raises SQLSTATE 42804 when reached.
--   plpgsql parses statements lazily, so the function "works" until the save
--   line actually runs: any call WITH an idempotency key on an order that
--   HAS field-billing splits does all of its work (split invoices, items,
--   audit rows, feed row) and then aborts at the very end — the whole call
--   rolls back. The split+idempotency path can never have completed in prod.
--   The no-splits path is unaffected (it delegates to
--   create_invoice_from_order, which uses the check_idempotency /
--   save_idempotency helpers correctly).
-- * The READ side has the mirror bug and MUST be fixed in the same pass:
--   v_existing is declared text. With the save fixed to store a jsonb string
--   ("id1,id2"), the live `SELECT result INTO v_existing` would assign via
--   I/O conversion and yield the DOUBLE-QUOTED jsonb literal "id1,id2", and
--   the replay's string_to_array(...)::uuid[] would raise 22P02 on every
--   cache hit. `result #>> '{}'` unwraps the JSON string to bare text.
--   Repo precedent for the unwrap: 20260501150000_field_app_workflow_phase20
--   line 92: `(v_existing #>> '{}')::uuid`.
--
-- BASELINE (live catalog, read 2026-06-10 via Supabase MCP, pg_proc)
-- * md5(prosrc) = 70bf20a13b28c0851e85a55a49544b82
--   Single overload. Identity args: p_order_id uuid, p_salesman_id uuid,
--   p_invoice_type text, p_idempotency_key text. RETURNS uuid[].
--   SECURITY DEFINER; SET search_path TO 'public', 'pg_temp';
--   proacl {postgres=X, authenticated=X, service_role=X} (no anon/PUBLIC).
-- * EXPECTED post-apply md5(prosrc) = d515f71b72dfbcf290ec258776b46502 —
--   computed server-side by applying exactly the two deltas below to the
--   live prosrc with replace() (each target string verified to occur exactly
--   once). The self-verification block asserts this md5, so any
--   transcription drift in this file fails the apply loudly.
--
-- DELTAS (exhaustive — body otherwise byte-identical to live):
-- * [DELTA:split_invoices_jsonb_fix:read]  — idempotency replay lookup:
--       SELECT result INTO v_existing ...
--    -> SELECT result #>> '{}' INTO v_existing ...
-- * [DELTA:split_invoices_jsonb_fix:write] — idempotency save (the 42804
--   line, ~line 62 per plpgsql_check):
--       ..., array_to_string(v_invoice_ids, ','));
--    -> ..., to_jsonb(array_to_string(v_invoice_ids, ',')));
-- Sentinel comments inside the body delimit both deltas; their presence in
-- the deployed prosrc is asserted below.
--
-- DELIBERATELY NOT CHANGED (minimal-delta discipline; already-queued items):
-- * The idempotency lookup stays operation-UNSCOPED (WHERE idempotency_key =
--   p_idempotency_key, no operation filter) — part of the queued 22-RPC
--   idempotency-scoping sweep (execution log §4.4); one migration, not this.
-- * No role gate added: the fn binds auth.uid() for attribution only (the
--   documented auth-bound-role-ungated sweep class); it is also on the
--   zero-caller REVOKE-candidates list (caller-graph: zero UI/Edge/cron
--   callers). Both are their own /ship items — grant policy is NOT changed
--   here, only restated verbatim from live.
--
-- GRANTS: restated verbatim from live proacl and asserted in the
-- self-verification block (authenticated keeps EXECUTE — in-body auth is the
-- gate per house convention; anon/PUBLIC have none; service_role keeps it).
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
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
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
$function$;

-- ----------------------------------------------------------------------------
-- Grants — restated verbatim from live proacl; NO policy change in this fix.
-- caller-analysis: create_split_invoices_from_order — zero UI/Edge/cron
-- callers (caller-graph.json zero_caller_authenticated, "candidate — zero
-- callers found anywhere"); REVOKE-from-authenticated decision belongs to the
-- queued REVOKE-candidates /ship item, NOT this 42804 fix. Live ACL is
-- {postgres, authenticated, service_role}; the statements below reproduce it
-- exactly so the migration is self-contained and assertable.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_split_invoices_from_order(uuid, uuid, text, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
  v_md5 text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'create_split_invoices_from_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_split_invoices_from_order overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc, md5(prosrc) INTO v_src, v_md5
  FROM pg_proc WHERE proname = 'create_split_invoices_from_order' AND pronamespace = 'public'::regnamespace;

  -- All four delta sentinel markers present in the deployed body
  IF position('[DELTA:split_invoices_jsonb_fix:read-begin]' IN v_src) = 0
     OR position('[DELTA:split_invoices_jsonb_fix:read-end]' IN v_src) = 0
     OR position('[DELTA:split_invoices_jsonb_fix:write-begin]' IN v_src) = 0
     OR position('[DELTA:split_invoices_jsonb_fix:write-end]' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: delta sentinel markers missing from prosrc';
  END IF;

  -- Fixed statements present; the broken text-into-jsonb write gone
  IF position('to_jsonb(array_to_string(v_invoice_ids' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: to_jsonb write fix missing from prosrc';
  END IF;
  IF position($probe$result #>> '{}' INTO v_existing$probe$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: jsonb-unwrap read fix missing from prosrc';
  END IF;
  IF position($probe$'create_split_invoices_from_order', array_to_string(v_invoice_ids$probe$ IN v_src) > 0 THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: old bare-text idempotency write still present';
  END IF;

  -- Byte-exact verbatim+delta fidelity (baseline 70bf20a13b28c0851e85a55a49544b82 + 2 deltas)
  IF v_md5 <> 'd515f71b72dfbcf290ec258776b46502' THEN
    RAISE EXCEPTION 'create_split_invoices_from_order prosrc md5 = %, expected d515f71b72dfbcf290ec258776b46502', v_md5;
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'create_split_invoices_from_order' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'create_split_invoices_from_order must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL preserved exactly: authenticated keeps EXECUTE (in-body auth is the
  -- gate), anon must not have it, service_role must.
  IF NOT has_function_privilege('authenticated', 'public.create_split_invoices_from_order(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.create_split_invoices_from_order(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.create_split_invoices_from_order(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'create_split_invoices_from_order: service_role lost EXECUTE';
  END IF;
END $$;

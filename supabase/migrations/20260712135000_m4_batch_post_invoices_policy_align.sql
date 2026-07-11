-- M4 (report §3.2 + §6 decision 7): align the LAST out-of-line posting surface.
--
-- Settled policy (decision 7): "Who may post invoices → Admin + sales; align all surfaces."
-- Every posting surface a USER touches already follows it — post_invoice and
-- post_invoice_group gate on admin+sales, and the chemical bulk-post screen
-- (Invoices.tsx handleBatchPost) was rewritten to loop post_invoice client-side
-- (admin+sales, partial-tolerant, per-invoice error summary). The server-side
-- batch_post_invoices RPC is the only leftover: still admin-ONLY + all-or-nothing.
-- It currently has NO caller (grep: no .rpc('batch_post_invoices') in src/), so this
-- is defense-in-depth — bring the dead RPC up to policy so a future re-wiring can't
-- silently reintroduce the admin-only / opaque-error inconsistency.
--
-- Two changes, nothing else:
--   1. Role gate admin-only -> admin+sales, mirroring post_invoice EXACTLY.
--   2. All-or-nothing -> partial-tolerant: each invoice posts in its own
--      subtransaction (BEGIN/EXCEPTION) so one bad row (closed period, wrong
--      status, pricing pending) no longer rolls back the good ones; the result
--      carries a per-invoice failures[] array. Matches the client-side loop.
--
-- Signature is byte-identical (p_invoice_ids uuid[], p_idempotency_key text DEFAULT NULL),
-- so CREATE OR REPLACE keeps the single overload and existing grants; Returns stays jsonb
-- (no type regen). anon already lacks EXECUTE; re-REVOKE for belt-and-suspenders.
--
-- caller-analysis: batch_post_invoices :: ZERO callers in the freshly-regenerated caller-graph
--   (zero_caller_authenticated; regenerated 2026-07-10 via generate-caller-graph.mjs). The chemical
--   bulk-post UI (Invoices.tsx handleBatchPost) loops post_invoice client-side and never calls this
--   RPC. REVOKE is anon-only — anon already lacked EXECUTE (has_function_privilege=false) — and
--   authenticated retains EXECUTE (explicit GRANT below). No caller is affected.

CREATE OR REPLACE FUNCTION public.batch_post_invoices(p_invoice_ids uuid[], p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_count int := 0;
  v_total bigint := 0;
  v_actor uuid;
  v_actor_role text;
  v_existing jsonb;
  v_failures jsonb := '[]'::jsonb;
  v_first_posted uuid;
  v_err text;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  -- M4: admin+sales (was admin-only). Mirrors post_invoice's gate exactly.
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to batch post invoices';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'batch_post_invoices';
    -- M4: return the actual cached result (was: an empty {count:0,idempotent:true} stub).
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN RAISE EXCEPTION 'No invoice IDs provided'; END IF;

  -- M4: partial-tolerant (was all-or-nothing). Each post_invoice runs in its own
  -- subtransaction; a failure rolls back only that invoice and is recorded in
  -- v_failures instead of aborting the batch.
  FOREACH v_id IN ARRAY p_invoice_ids LOOP
    BEGIN
      PERFORM post_invoice(v_id);
      v_count := v_count + 1;
      IF v_first_posted IS NULL THEN v_first_posted := v_id; END IF;
      v_total := v_total + COALESCE((SELECT total_amount_cents FROM invoices WHERE id = v_id), 0);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      v_failures := v_failures || jsonb_build_object('invoice_id', v_id, 'error', v_err);
    END;
  END LOOP;

  -- Append-only provenance: only when something actually posted. entity_id points at a
  -- REAL posted invoice (v_first_posted), never a row that failed.
  IF v_count > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_posted', 'invoice', v_first_posted, v_actor_role,
      jsonb_build_object(
        'batch_count', v_count,
        'failed_count', jsonb_array_length(v_failures),
        'invoice_ids', to_jsonb(p_invoice_ids)
      ),
      v_total,
      'Batch posted ' || v_count || ' invoice(s) totaling $' || (v_total / 100.0)::numeric(12,2) ||
        CASE WHEN jsonb_array_length(v_failures) > 0
             THEN ' (' || jsonb_array_length(v_failures) || ' failed)' ELSE '' END
    );
  END IF;

  v_result := jsonb_build_object(
    'success', (jsonb_array_length(v_failures) = 0),
    'count', v_count,
    'total_cents', v_total,
    'failed', v_failures
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_post_invoices', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.batch_post_invoices(uuid[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.batch_post_invoices(uuid[], text) TO authenticated;

-- Post-checks: single overload, correct grants, policy + tolerance markers present.
-- Reads pg_proc.prosrc (the stored body) directly — asserts the new body only, never clones.
DO $$
DECLARE
  v_overloads int;
  v_src text;
BEGIN
  SELECT count(*), max(prosrc) INTO v_overloads, v_src
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'batch_post_invoices';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'M4 post-check: expected exactly 1 batch_post_invoices overload, found %', v_overloads;
  END IF;

  IF has_function_privilege('anon', 'public.batch_post_invoices(uuid[], text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M4 post-check: anon must NOT have EXECUTE on batch_post_invoices';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.batch_post_invoices(uuid[], text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M4 post-check: authenticated must have EXECUTE on batch_post_invoices';
  END IF;

  IF v_src NOT LIKE '%role IN (''admin'', ''sales_rep'')%' THEN
    RAISE EXCEPTION 'M4 post-check: batch_post_invoices does not gate on admin+sales';
  END IF;
  IF v_src NOT LIKE '%EXCEPTION WHEN OTHERS%' THEN
    RAISE EXCEPTION 'M4 post-check: batch_post_invoices is not partial-tolerant';
  END IF;
END $$;

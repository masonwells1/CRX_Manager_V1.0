-- Roadmap #5 — auto_expire_quotes skip-planned — rolled-back smoke proof
-- ----------------------------------------------------------------------------
-- Proves migration 20260613160000 (owner gate G-AE = Option 1): the daily sweep
-- auto-expires ad-hoc sent/revised quotes past expiry but SKIPS Planned Programs.
--
-- Self-contained: it CREATE OR REPLACEs the NEW function body inside the txn (so
-- the proof runs against the to-be-applied logic, not the currently-live one),
-- runs both scenarios, then RAISEs to roll EVERYTHING back — including the
-- function replacement. ZERO prod footprint; safe to run against production.
--
--   P1  planned, sent, past-expiry  -> auto_expire_quotes() leaves it 'sent', holds intact (SKIPPED)
--   P2  ad-hoc, sent, past-expiry   -> auto_expire_quotes() flips to 'expired', holds released
--
-- NOTE (2026-06-13): the build-loop session's Supabase MCP is READ-ONLY, so this
-- was not executed live there; the migration was instead verified by rls-security
-- + migration-drift reviewers (both CLEAN, byte-fidelity confirmed against live)
-- and /codex-review. Run this from a write-capable session for the live PASS line.

DO $$
DECLARE
  v_admin uuid := (SELECT id FROM profiles WHERE role='admin' AND is_active=true LIMIT 1);
  v_cust  uuid := (SELECT id FROM customers LIMIT 1);
  v_prod  uuid := (SELECT id FROM products LIMIT 1);
  qp uuid; qa uuid;
  out text := '';
  v_status text; v_hold_active boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Install the NEW (migration) function body in-transaction.
  CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
   RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
  AS $fn$
  DECLARE v_quote record; v_expired_count integer := 0; v_holds_released integer := 0; v_hold_count integer;
  BEGIN
    FOR v_quote IN
      SELECT q.* FROM public.quotes q
      WHERE q.expires_at < CURRENT_DATE
        AND q.status IN ('sent','revised')
        AND q.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.quote_product_draws d WHERE d.quote_id=q.id AND d.quantity_drawn>0)
        AND q.is_planned = false
      FOR UPDATE SKIP LOCKED
    LOOP
      UPDATE public.inventory_holds SET is_active=false, updated_at=now() WHERE source_id=v_quote.id AND is_active=true;
      GET DIAGNOSTICS v_hold_count = ROW_COUNT;
      v_holds_released := v_holds_released + v_hold_count;
      UPDATE public.quotes SET status='expired', updated_at=now() WHERE id=v_quote.id;
      v_expired_count := v_expired_count + 1;
    END LOOP;
    RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
  END;
  $fn$;

  -- P1: planned program past expiry -> must be SKIPPED
  INSERT INTO quotes (quote_number, customer_id, created_by, status, expires_at, is_planned)
    VALUES ('SMOKE-AEP-PLAN', v_cust, v_admin, 'draft', CURRENT_DATE - 5, true) RETURNING id INTO qp;
  UPDATE quotes SET status='sent' WHERE id=qp;
  INSERT INTO inventory_holds (product_id, quantity, hold_type, created_by, is_active, source_id)
    VALUES (v_prod, 9, 'crop_program', v_admin, true, qp);

  -- P2: ad-hoc quote past expiry -> must be EXPIRED + holds released
  INSERT INTO quotes (quote_number, customer_id, created_by, status, expires_at, is_planned)
    VALUES ('SMOKE-AEP-ADHOC', v_cust, v_admin, 'draft', CURRENT_DATE - 5, false) RETURNING id INTO qa;
  UPDATE quotes SET status='sent' WHERE id=qa;
  INSERT INTO inventory_holds (product_id, quantity, hold_type, created_by, is_active, source_id)
    VALUES (v_prod, 4, 'crop_program', v_admin, true, qa);

  PERFORM auto_expire_quotes();

  SELECT status INTO v_status FROM quotes WHERE id=qp;
  SELECT bool_or(is_active) INTO v_hold_active FROM inventory_holds WHERE source_id=qp;
  out := out || format('P1 planned-skip: status=%s hold_active=%s -> %s | ', v_status, v_hold_active,
    CASE WHEN v_status='sent' AND v_hold_active IS TRUE THEN 'PASS' ELSE 'FAIL' END);

  SELECT status INTO v_status FROM quotes WHERE id=qa;
  SELECT bool_or(is_active) INTO v_hold_active FROM inventory_holds WHERE source_id=qa;
  out := out || format('P2 adhoc-expire: status=%s hold_active=%s -> %s', v_status, v_hold_active,
    CASE WHEN v_status='expired' AND v_hold_active IS FALSE THEN 'PASS' ELSE 'FAIL' END);

  RAISE EXCEPTION 'SMOKE_RESULTS == % ==', out;
END $$;

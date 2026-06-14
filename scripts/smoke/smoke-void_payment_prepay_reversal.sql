-- ============================================================================
-- SMOKE TEST (rolled back by design): void_payment overpayment prepay-credit
-- reversal (chip task_d53a1704; migration void_payment_prepay_reversal.sql)
-- ----------------------------------------------------------------------------
-- THE CHAIN:
--   posted invoice fixture (draft insert -> draft->posted update, per the
--   trg_invoice_draft_insert / status-enforcer pair)
--     -> allocate_payment #1: $800.00 payment, $300.00 allocated to the
--        invoice, $500.00 overpayment -> prepay credit created with
--        source_reference = 'From payment <reference_number>' and
--        customers.prepay_balance_cents += 50000
--     -> decoy credit (same customer/season/source_type, DIFFERENT
--        reference) — must survive every void untouched (over-match guard)
--     -> allocate_payment #2: $200.00 pure overpayment, ref/check NULL ->
--        credit source_reference = 'From payment <set2-uuid>' (the COALESCE
--        fallback format) + a hand-inserted LEGACY-format credit
--        (source_reference = bare set2 uuid::text) for the same set
--     -> void_payment #1: prepay credit reversed (balance 0, [VOIDED: note),
--        customers.prepay_balance_cents restored, invoice paid_amount back
--        to 0 / still 'posted', allocation set is_active=false (ILA rows
--        preserved as history — the table has no is_active column),
--        financial_audit_log payment_voided row carries
--        prepay_reversed_cents=50000, idempotency_keys row written with
--        operation='void_payment'
--     -> double-void guard: second void raises 'Payment already voided'
--     -> void_payment #2: BOTH formats reversed in one void
--        (20000 new-format + 11111 legacy = 31111), decoy still intact,
--        customer balance lands exactly on the decoy's 7777
--   -> RAISE 'SMOKE_PASS_ROLLBACK' (nothing persists).
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or run-smoke.mjs) as postgres/service_role. The DO block
-- ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' — that exact text =
-- PASS; ANY other error = FAIL.
--
-- Auth: void_payment/allocate_payment derive the actor from auth.uid(),
-- which reads request.jwt.claims — injected via set_config(..., true) using
-- a REAL active admin profile id (runtime lookup; raises SMOKE_SETUP if none).
-- Fixture INSERTs bypass RLS because we run as the table owner; the RPCs
-- under test still enforce their own auth/role gates.
--
-- Live-state preconditions (checked up front, SMOKE_SETUP if unmet):
--   * at least one active admin profile;
--   * CURRENT_DATE not inside a CLOSED accounting period
--     (allocate_payment calls check_period_open(p_payment_date)).
--
-- DELIBERATE SCOPE NOTE: allocation #1 is PARTIAL (30000 of a 50000 invoice)
-- so the invoice stays 'posted'. Voiding a payment that FULLY paid an
-- invoice crashes today on the live status enforcer (paid->posted is not an
-- allowed transition and void_payment has no admin_override bracket) — a
-- separate live bug, out of scope for this chip, enumerated in the migration
-- header. Do not "improve" this smoke to a full payment until that ships.
--
-- DRY-VALIDATED AGAINST THE LIVE CATALOG 2026-06-10 (the 42703 discipline) —
-- every reference below was confirmed via information_schema.columns,
-- pg_constraint, pg_trigger and the live function catalog:
--   functions (6): allocate_payment(uuid,bigint,text,text,text,date,text,
--     jsonb,uuid,text); void_payment(uuid,text,uuid,text); current_season();
--     and, exercised transitively inside allocate_payment as owner:
--     check_period_open(date), check_idempotency(text,text),
--     save_idempotency(text,text,jsonb)
--   tables/columns (9 tables, 37 columns):
--     accounting_periods: status, period_start, period_end
--     profiles: id, role, is_active, created_at
--     customers: id, farm_name, prepay_balance_cents
--     invoices: id, customer_id, invoice_number, invoice_type, status,
--       total_amount_cents, paid_amount_cents, created_by
--     prepay_credits: id, customer_id, season, original_amount_cents,
--       balance_cents, source_type, source_reference, notes, created_by
--     allocation_sets: id, is_active, notes
--     invoice_line_allocations: allocation_set_id
--     financial_audit_log: operation_type, entity_type, entity_id, new_values
--     idempotency_keys: idempotency_key, operation
--   triggers accounted for (5): trg_invoice_draft_insert (forces the draft
--     insert), enforce_invoice_status_transition (draft->posted is legal),
--     set_invoices_updated_at, trg_sync_blend_ticket_payment (no-op, no
--     blend ticket), set_prepay_credits_updated_at
--   constraints accounted for (10): invoices_status_check,
--     invoices_paid_non_negative, invoices_balance_non_negative,
--     prepay_balance_non_negative, allocation_sets_entity_type_check,
--     allocation_sets_entity_type_entity_id_version_key,
--     financial_audit_log_operation_type_check ('payment_allocated',
--     'payment_voided'), financial_audit_log_entity_type_check
--     ('allocation_set'), profiles_role_check, ila_target_check
--   No sequences are consumed (invoice_number supplied explicitly) — zero
--   non-transactional side effects.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin       uuid;
  v_suffix      text := substr(md5(random()::text), 1, 8);
  v_customer_id uuid;
  v_invoice_id  uuid;
  v_set1_id     uuid;
  v_set2_id     uuid;
  v_res         jsonb;
  v_n           int;
  v_cents       bigint;
  v_status      text;
  v_notes       text;
  v_active      boolean;
  v_ref         text;
  v_raised      boolean := false;
BEGIN
  -- --------------------------------------------------------------------
  -- 0. Preconditions + auth as a real active admin
  -- --------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM accounting_periods
    WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end
  ) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: CURRENT_DATE falls in a CLOSED accounting period - allocate_payment cannot run today';
  END IF;

  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- --------------------------------------------------------------------
  -- 1. Fixtures: customer + posted $500.00 invoice
  -- --------------------------------------------------------------------
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] VPP Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  -- trg_invoice_draft_insert forces draft on INSERT; draft->posted is an
  -- enforcer-legal UPDATE.
  INSERT INTO invoices (customer_id, invoice_number, invoice_type, status, total_amount_cents, created_by)
  VALUES (v_customer_id, '[SMOKE]-VPP-' || v_suffix, 'chemical_sale', 'draft', 50000, v_admin)
  RETURNING id INTO v_invoice_id;

  UPDATE invoices SET status = 'posted' WHERE id = v_invoice_id;

  -- --------------------------------------------------------------------
  -- 2. allocate_payment #1: 80000 total, 30000 allocated (PARTIAL — see
  --    scope note), 50000 overpayment -> prepay credit
  -- --------------------------------------------------------------------
  v_res := allocate_payment(
    v_customer_id, 80000, 'check',
    '[SMOKE]-VPP-REF-' || v_suffix, NULL, CURRENT_DATE,
    '[SMOKE] vpp payment 1',
    jsonb_build_array(jsonb_build_object('invoice_id', v_invoice_id, 'amount_cents', 30000)),
    v_admin, 'smk-vpp-' || v_suffix || '-a1');

  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'total_allocated_cents')::bigint, -1) <> 30000
     OR COALESCE((v_res->>'prepay_created_cents')::bigint, -1) <> 50000
     OR COALESCE((v_res->>'invoices_paid')::int, -1) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: allocate_payment #1 returned % (expected 30000 allocated / 50000 prepay / 1 invoice)', v_res;
  END IF;
  v_set1_id := (v_res->>'allocation_set_id')::uuid;

  SELECT paid_amount_cents, status INTO v_cents, v_status FROM invoices WHERE id = v_invoice_id;
  IF v_cents <> 30000 OR v_status <> 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice after allocate: paid=%, status=% (expected 30000/posted)', v_cents, v_status;
  END IF;

  -- the overpayment credit: exactly one, the documented format, full balance
  SELECT count(*) INTO v_n FROM prepay_credits
  WHERE customer_id = v_customer_id AND source_type = 'overpayment';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % overpayment credit(s) after allocate #1, expected 1', v_n;
  END IF;
  SELECT balance_cents, source_reference INTO v_cents, v_ref FROM prepay_credits
  WHERE customer_id = v_customer_id AND source_type = 'overpayment';
  IF v_cents <> 50000 OR v_ref <> 'From payment [SMOKE]-VPP-REF-' || v_suffix THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit #1 balance=%, source_reference=% (expected 50000 / From payment [SMOKE]-VPP-REF-%)',
      v_cents, v_ref, v_suffix;
  END IF;

  SELECT prepay_balance_cents INTO v_cents FROM customers WHERE id = v_customer_id;
  IF v_cents <> 50000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer prepay balance after allocate #1 = %, expected 50000', v_cents;
  END IF;

  SELECT count(*) INTO v_n FROM invoice_line_allocations WHERE allocation_set_id = v_set1_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ILA rows for set1 = %, expected 1', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 3. Decoy credit (same customer/season/source_type, different reference)
  --    + allocate_payment #2 (pure overpayment, ref/check NULL -> COALESCE
  --    falls back to the set uuid inside the 'From payment ' format)
  --    + a hand-inserted LEGACY bare-uuid credit for set2
  -- --------------------------------------------------------------------
  INSERT INTO prepay_credits (customer_id, season, original_amount_cents, balance_cents,
    source_type, source_reference, notes, created_by)
  VALUES (v_customer_id, current_season(), 7777, 7777,
    'overpayment', 'From payment [SMOKE]-VPP-DECOY-' || v_suffix, '[SMOKE] decoy credit', v_admin);
  UPDATE customers SET prepay_balance_cents = prepay_balance_cents + 7777 WHERE id = v_customer_id;

  v_res := allocate_payment(
    v_customer_id, 20000, 'cash',
    NULL, NULL, CURRENT_DATE,
    '[SMOKE] vpp payment 2',
    '[]'::jsonb,
    v_admin, 'smk-vpp-' || v_suffix || '-a2');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'prepay_created_cents')::bigint, -1) <> 20000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: allocate_payment #2 returned % (expected 20000 prepay)', v_res;
  END IF;
  v_set2_id := (v_res->>'allocation_set_id')::uuid;

  -- the no-ref/no-check fallback format
  SELECT count(*) INTO v_n FROM prepay_credits
  WHERE customer_id = v_customer_id AND source_type = 'overpayment'
    AND source_reference = 'From payment ' || v_set2_id::text AND balance_cents = 20000;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: set2 fallback-format credit not found (count=%)', v_n;
  END IF;

  -- legacy bare-uuid format (what the BROKEN void_payment used to expect)
  INSERT INTO prepay_credits (customer_id, season, original_amount_cents, balance_cents,
    source_type, source_reference, notes, created_by)
  VALUES (v_customer_id, current_season(), 11111, 11111,
    'overpayment', v_set2_id::text, '[SMOKE] legacy-format credit', v_admin);
  UPDATE customers SET prepay_balance_cents = prepay_balance_cents + 11111 WHERE id = v_customer_id;

  SELECT prepay_balance_cents INTO v_cents FROM customers WHERE id = v_customer_id;
  IF v_cents <> 88888 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer prepay balance before voids = %, expected 88888 (50000+7777+20000+11111)', v_cents;
  END IF;

  -- --------------------------------------------------------------------
  -- 4. void_payment #1: the chip's core assertion — overpayment credit
  --    reversed, customer balance restored, allocations deactivated
  -- --------------------------------------------------------------------
  v_res := void_payment(v_set1_id, '[SMOKE] reversal test', v_admin, 'smk-vpp-' || v_suffix || '-v1');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'reversed_cents')::bigint, -1) <> 30000
     OR COALESCE((v_res->>'invoices_affected')::int, -1) <> 1
     OR COALESCE((v_res->>'prepay_reversed_cents')::bigint, -1) <> 50000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment #1 returned % (expected 30000 reversed / 1 invoice / 50000 prepay reversed — prepay_reversed_cents=0 is THE pre-fix bug)', v_res;
  END IF;

  -- credit #1 zeroed + annotated
  SELECT balance_cents, notes INTO v_cents, v_notes FROM prepay_credits
  WHERE customer_id = v_customer_id AND source_type = 'overpayment'
    AND source_reference = 'From payment [SMOKE]-VPP-REF-' || v_suffix;
  IF v_cents <> 0 OR v_notes NOT LIKE '%[VOIDED:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit #1 after void: balance=%, notes=% (expected 0 + [VOIDED: annotation)', v_cents, v_notes;
  END IF;

  -- decoy untouched (over-match guard)
  SELECT balance_cents INTO v_cents FROM prepay_credits
  WHERE customer_id = v_customer_id
    AND source_reference = 'From payment [SMOKE]-VPP-DECOY-' || v_suffix;
  IF v_cents <> 7777 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: DECOY credit was touched by void #1 (balance=%, expected 7777)', v_cents;
  END IF;

  -- set2's credits untouched by set1's void (cross-set isolation)
  SELECT count(*) INTO v_n FROM prepay_credits
  WHERE customer_id = v_customer_id AND balance_cents > 0
    AND source_reference IN ('From payment ' || v_set2_id::text, v_set2_id::text);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: set2 credits after void #1 = % live rows, expected 2', v_n;
  END IF;

  -- customer balance restored by exactly the reversed amount
  SELECT prepay_balance_cents INTO v_cents FROM customers WHERE id = v_customer_id;
  IF v_cents <> 38888 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer prepay balance after void #1 = %, expected 38888 (88888-50000)', v_cents;
  END IF;

  -- invoice reversed, still posted
  SELECT paid_amount_cents, status INTO v_cents, v_status FROM invoices WHERE id = v_invoice_id;
  IF v_cents <> 0 OR v_status <> 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice after void #1: paid=%, status=% (expected 0/posted)', v_cents, v_status;
  END IF;

  -- allocation set deactivated + annotated; ILA rows preserved as history
  SELECT is_active, notes INTO v_active, v_notes FROM allocation_sets WHERE id = v_set1_id;
  IF v_active IS NOT FALSE OR v_notes NOT LIKE '%[VOIDED:%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: set1 after void: is_active=%, notes=% (expected false + [VOIDED: annotation)', v_active, v_notes;
  END IF;
  SELECT count(*) INTO v_n FROM invoice_line_allocations WHERE allocation_set_id = v_set1_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: ILA rows for set1 after void = %, expected 1 (history preserved)', v_n;
  END IF;

  -- audit + idempotency rows landed with the right shape
  SELECT count(*) INTO v_n FROM financial_audit_log
  WHERE operation_type = 'payment_voided' AND entity_type = 'allocation_set'
    AND entity_id = v_set1_id AND (new_values->>'prepay_reversed_cents')::bigint = 50000;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: payment_voided audit rows with prepay_reversed_cents=50000 for set1 = % (expected 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM idempotency_keys
  WHERE idempotency_key = 'smk-vpp-' || v_suffix || '-v1' AND operation = 'void_payment';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment idempotency_keys row missing (count=%)', v_n;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. Double-void guard
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM void_payment(v_set1_id, '[SMOKE] double void', v_admin, NULL);
    v_raised := false;
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLERRM <> 'Payment already voided' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: double void raised "%" (expected "Payment already voided")', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'SMOKE_FAIL: double void did not raise';
  END IF;

  -- --------------------------------------------------------------------
  -- 6. void_payment #2: BOTH source_reference formats reversed in one void
  -- --------------------------------------------------------------------
  v_res := void_payment(v_set2_id, '[SMOKE] reversal test 2', v_admin, 'smk-vpp-' || v_suffix || '-v2');
  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_res->>'reversed_cents')::bigint, -1) <> 0
     OR COALESCE((v_res->>'invoices_affected')::int, -1) <> 0
     OR COALESCE((v_res->>'prepay_reversed_cents')::bigint, -1) <> 31111 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment #2 returned % (expected 0 reversed / 0 invoices / 31111 prepay reversed = 20000 fallback + 11111 legacy)', v_res;
  END IF;

  SELECT count(*) INTO v_n FROM prepay_credits
  WHERE customer_id = v_customer_id AND balance_cents > 0
    AND source_reference IN ('From payment ' || v_set2_id::text, v_set2_id::text);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % set2 credit(s) still live after void #2, expected 0', v_n;
  END IF;

  SELECT balance_cents INTO v_cents FROM prepay_credits
  WHERE customer_id = v_customer_id
    AND source_reference = 'From payment [SMOKE]-VPP-DECOY-' || v_suffix;
  IF v_cents <> 7777 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: DECOY credit was touched by void #2 (balance=%, expected 7777)', v_cents;
  END IF;

  SELECT prepay_balance_cents INTO v_cents FROM customers WHERE id = v_customer_id;
  IF v_cents <> 7777 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: customer prepay balance after void #2 = %, expected 7777 (only the decoy remains)', v_cents;
  END IF;

  SELECT is_active INTO v_active FROM allocation_sets WHERE id = v_set2_id;
  IF v_active IS NOT FALSE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: set2 still active after void #2';
  END IF;

  -- --------------------------------------------------------------------
  -- Full chain passed — force rollback of everything above.
  -- --------------------------------------------------------------------
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;

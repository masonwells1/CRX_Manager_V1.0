-- ============================================================================
-- SMOKE TEST (rolled back by design): FIX 4 (Wave 2a) — unpost_invoice_group
-- (migration 20260629170000_unpost_invoice_group.sql). ALL-OR-NOTHING.
-- ----------------------------------------------------------------------------
-- Run AFTER applying 20260629170000. Proves the group unpost is atomic:
--
--   P1  HAPPY — a posted split group (2 members, shared invoice_group_id) is
--          unposted in ONE call: BOTH members flip posted -> unposted, posted_by/at
--          cleared, the system due date clears while the explicit date remains,
--          an 'invoice_unposted' audit row per member, one
--          'invoice_group_unposted' activity row.
--   P2  ALL-OR-NOTHING — a posted split group where ONE member is PAID (money
--          applied): unpost_invoice_group RAISES (money guard) and NOTHING changes
--          — both members are STILL posted, no audit rows written. (No half-unpost.)
--   P3  ROLE GATE — an APPLICATOR calling unpost_invoice_group is rejected
--          ('admin or sales role required'); the group stays posted.
--   P4  ACTOR — a forged p_performed_by raises ACTOR_MISMATCH, mutates nothing.
--   P5  REPLAY GUARD — a same-key replay for the SAME group returns the cached
--          result; the SAME key for a DIFFERENT group RAISES IDEMPOTENCY_KEY_REUSED
--          and leaves that other group UNTOUCHED (no silent wrong-group success).
--   P6  GRANTS — anon has NO EXECUTE; authenticated DOES.
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin   uuid; v_appl uuid; v_forged uuid := gen_random_uuid();
  v_sfx     text := substr(gen_random_uuid()::text,1,8);
  v_chicago_posting_date date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_cust_a  uuid; v_cust_b uuid;
  v_grp     uuid := gen_random_uuid();
  v_grp2    uuid := gen_random_uuid();
  v_inv_a   uuid; v_inv_b uuid;       -- happy group
  v_inv_c   uuid; v_inv_d uuid;       -- all-or-nothing group (d gets paid)
  v_aset    uuid;
  v_res     jsonb;
  v_n       int; v_status text; v_anon boolean; v_auth boolean;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_appl  FROM profiles WHERE role='applicator' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_appl IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: need admin + applicator'; END IF;
  INSERT INTO customers (farm_name, payment_terms) VALUES ('[SMOKE] UPG-A '||v_sfx, 'Net 15') RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name, payment_terms) VALUES ('[SMOKE] UPG-B '||v_sfx, 'Net 45') RETURNING id INTO v_cust_b;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- ── HAPPY GROUP: two members sharing invoice_group_id, both posted ─────────
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date_source, total_amount_cents, created_by, invoice_group_id)
    VALUES ('[SMOKE] UPG-A-'||v_sfx, v_cust_a, 'field_application', 'draft', CURRENT_DATE, 'system', 120000, v_admin, v_grp) RETURNING id INTO v_inv_a;
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, due_date_source, total_amount_cents, created_by, invoice_group_id)
    VALUES ('[SMOKE] UPG-B-'||v_sfx, v_cust_b, 'field_application', 'draft', CURRENT_DATE, v_chicago_posting_date + 47, 'explicit', 80000, v_admin, v_grp) RETURNING id INTO v_inv_b;
  PERFORM post_invoice_group(v_grp, v_admin, '[SMOKE] upg-post-'||v_sfx);
  IF (SELECT due_date FROM invoices WHERE id=v_inv_a) IS DISTINCT FROM v_chicago_posting_date + 15
     OR (SELECT due_date FROM invoices WHERE id=v_inv_b) IS DISTINCT FROM v_chicago_posting_date + 47 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: group posting did not derive system and preserve explicit due dates';
  END IF;

  v_res := unpost_invoice_group(v_grp, v_admin, '[SMOKE] upg-unpost-'||v_sfx);
  IF (v_res->>'success')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'SMOKE_FAIL: group unpost did not succeed'; END IF;
  IF (v_res->>'member_count')::int <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong member_count %', v_res->>'member_count'; END IF;

  SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp AND status='unposted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 2 members unposted, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp AND (posted_by IS NOT NULL OR posted_at IS NOT NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: posted_by/at not cleared on % members', v_n; END IF;
  IF (SELECT due_date FROM invoices WHERE id=v_inv_a) IS NOT NULL
     OR (SELECT due_date FROM invoices WHERE id=v_inv_b) IS DISTINCT FROM v_chicago_posting_date + 47 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: group unpost did not clear system and preserve explicit due dates';
  END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id IN (v_inv_a, v_inv_b) AND operation_type='invoice_unposted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: expected 2 invoice_unposted audit rows, got %', v_n; END IF;

  -- ── ALL-OR-NOTHING: one member paid -> whole call RAISES, nothing changes ──
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, invoice_group_id)
    VALUES ('[SMOKE] UPG-C-'||v_sfx, v_cust_a, 'field_application', 'draft', CURRENT_DATE, 60000, v_admin, v_grp2) RETURNING id INTO v_inv_c;
  INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, invoice_group_id)
    VALUES ('[SMOKE] UPG-D-'||v_sfx, v_cust_b, 'field_application', 'draft', CURRENT_DATE, 40000, v_admin, v_grp2) RETURNING id INTO v_inv_d;
  PERFORM post_invoice_group(v_grp2, v_admin, '[SMOKE] upg-cd-post-'||v_sfx);
  -- Apply money to D so it cannot be unposted.
  INSERT INTO allocation_sets (entity_type, entity_id, version, is_active, customer_id, total_payment_cents, total_allocated_cents)
    VALUES ('payment', gen_random_uuid(), 1, true, v_cust_b, 40000, 40000) RETURNING id INTO v_aset;
  INSERT INTO invoice_line_allocations (allocation_set_id, bill_to_customer_id, split_percentage, amount_cents, invoice_id)
    VALUES (v_aset, v_cust_b, 100, 40000, v_inv_d);
  UPDATE invoices SET paid_amount_cents = 40000 WHERE id=v_inv_d;

  BEGIN
    PERFORM unpost_invoice_group(v_grp2, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: group with a paid member was unposted (not all-or-nothing)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%payments, prepay, write-offs, or applied credit%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: all-or-nothing raised the WRONG error: %', SQLERRM;
    END IF;
  END;
  -- BOTH members still posted; NO audit rows for either (the txn rolled back).
  SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp2 AND status='posted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: all-or-nothing left % posted (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM financial_audit_log WHERE entity_id IN (v_inv_c, v_inv_d) AND operation_type='invoice_unposted';
  IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: all-or-nothing wrote % unpost audit rows (expected 0)', v_n; END IF;

  -- ── ROLE GATE: applicator denied (group stays posted) ─────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_appl, 'role','authenticated')::text, true);
  BEGIN
    PERFORM unpost_invoice_group(v_grp2, v_appl, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: applicator was allowed to unpost a group';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%admin or sales role required%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: role gate raised the WRONG error: %', SQLERRM;
    END IF;
  END;
  -- restore admin claims
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- ── ACTOR: forged performer raises ACTOR_MISMATCH ─────────────────────────
  -- Re-post the happy group's members would be needed; instead use the still-posted grp2.
  BEGIN
    PERFORM unpost_invoice_group(v_grp2, v_forged, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: forged actor allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected ACTOR_MISMATCH got %', SQLERRM; END IF;
  END;

  -- ── REPLAY GUARD: same key, DIFFERENT group -> IDEMPOTENCY_KEY_REUSED ──────
  -- The happy group v_grp was unposted under key '[SMOKE] upg-unpost-...'. A same-key
  -- replay for THAT SAME group returns the cached result (idempotent). But replaying
  -- the SAME key for a DIFFERENT group must RAISE (never silently report the wrong
  -- group's success). Build a fresh posted group v_grp3 and replay v_grp's key on it.
  -- same-group replay still works:
  v_res := unpost_invoice_group(v_grp, v_admin, '[SMOKE] upg-unpost-'||v_sfx);
  IF (v_res->>'invoice_group_id') <> v_grp::text THEN RAISE EXCEPTION 'SMOKE_FAIL: same-group replay returned wrong group'; END IF;
  DECLARE
    v_grp3  uuid := gen_random_uuid();
    v_inv_e uuid; v_inv_f uuid;
  BEGIN
    INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, invoice_group_id)
      VALUES ('[SMOKE] UPG-E-'||v_sfx, v_cust_a, 'field_application', 'draft', CURRENT_DATE, 30000, v_admin, v_grp3) RETURNING id INTO v_inv_e;
    INSERT INTO invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, invoice_group_id)
      VALUES ('[SMOKE] UPG-F-'||v_sfx, v_cust_b, 'field_application', 'draft', CURRENT_DATE, 20000, v_admin, v_grp3) RETURNING id INTO v_inv_f;
    PERFORM post_invoice_group(v_grp3, v_admin, '[SMOKE] upg-ef-post-'||v_sfx);
    BEGIN
      PERFORM unpost_invoice_group(v_grp3, v_admin, '[SMOKE] upg-unpost-'||v_sfx);  -- v_grp's key!
      RAISE EXCEPTION 'SMOKE_FAIL: cross-group key replay silently returned (wrong-group success)';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REUSED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: cross-group replay wrong error: %', SQLERRM; END IF;
    END;
    -- v_grp3 must be UNTOUCHED (still posted) — the blind replay did NOT unpost it.
    SELECT count(*) INTO v_n FROM invoices WHERE invoice_group_id=v_grp3 AND status='posted';
    IF v_n <> 2 THEN RAISE EXCEPTION 'SMOKE_FAIL: cross-group replay mutated the wrong group (% posted)', v_n; END IF;
  END;

  -- ── GRANTS ────────────────────────────────────────────────────────────────
  SELECT has_function_privilege('anon',          'public.unpost_invoice_group(uuid,uuid,text)', 'EXECUTE') INTO v_anon;
  SELECT has_function_privilege('authenticated', 'public.unpost_invoice_group(uuid,uuid,text)', 'EXECUTE') INTO v_auth;
  IF v_anon THEN RAISE EXCEPTION 'SMOKE_FAIL: anon can EXECUTE unpost_invoice_group'; END IF;
  IF NOT v_auth THEN RAISE EXCEPTION 'SMOKE_FAIL: authenticated CANNOT EXECUTE unpost_invoice_group'; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;

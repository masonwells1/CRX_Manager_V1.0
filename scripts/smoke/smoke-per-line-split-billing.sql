-- ============================================================================
-- SMOKE TEST (rolled back by design): per-line split-billing engine —
-- save_field_app_split_invoice (public wrapper) + _save_field_app_split_invoice_impl
-- + resolve_line_split_vector + compute_line_split_allocation
-- (migrations 20260720213000 schema / 20260720214000 calculator / 20260720233000 save RPC).
-- ----------------------------------------------------------------------------
-- Proves:
--   P0  — FLAG GATE: with app_settings.per_line_split_billing_enabled <> 'true',
--          the wrapper refuses with SPLIT_BILLING_DISABLED (the guard actually
--          raises; it is not just present in the source).
--   P1  — PENNY-EXACT ODD SPLIT: a manual-override chemical line of exactly 1501
--          cents (odd, indivisible by 2) across a 50/50 two-owner field produces
--          one draft child invoice per co-owner via the source_lr largest-
--          remainder path (plus a 100c/acre manual service line splitting 5000/5000):
--          child totals are 5751 + 5750 = 11501 EXACTLY, integer
--          cents, and the stored invoice_line_shares / invoice_items /
--          invoice_shares all tie to the same figures (no independent re-round).
--   P2  — STORED-ROW INVARIANTS: per billing line, SUM(share amount_cents) ==
--          field_app_billing_lines.source_line_cents, SUM(split_micro_pct) ==
--          100000000, SUM(allocated_quantity) == source_quantity at 4dp, and
--          each invoice_item.extended_cents == its share's amount_cents.
--   P3  — IDEMPOTENT REPLAY: the same save with the SAME p_idempotency_key and
--          identical payload returns the SAME invoice ids and creates no second
--          set of invoices.
--   P4  — CALCULATOR DIRECT: compute_line_split_allocation splits a 100-cent
--          flat fee across a 3-way even vector (from compute_even_split_vector)
--          as {34,33,33} summing to exactly 100 (largest-remainder, tie-break
--          customer_id ASC).
--   G1  — SPLIT_DUPLICATE_PRODUCT raises when the same chemical product appears
--          on two lines.
--   G2  — SPLIT_FIELD_NOT_ON_JOB raises when billing a field that is not one of
--          the source job's job_fields.
--   G3  — SPLIT_JOB_IMMUTABLE raises when a re-save tries to attach a source job
--          to a set that was first saved without one.
--   G5  — regression probe (bug FIXED live 2026-07-21 by migration
--          20260721180000): a chemical-only save (no service line) must succeed;
--          the pre-fix impl crashed on the unassigned v_app_service record.
--   G4  — RESOLVER_NOT_AUTHORIZED raises for a NON-ADMIN sales_rep directly
--          resolving a split vector for customers not assigned to them (probed
--          as a real active sales_rep, per the "admin-only proof misses
--          non-admin guards" gotcha; skipped with a NOTICE only if the live DB
--          has no active sales_rep to impersonate).
--
-- Honest limits (not covered here): posting/unposting the group and the
-- post-time snapshot trigger (post_invoice_group consumes payments/idempotency
-- machinery better exercised by its own chains), service/fuel/flat line kinds,
-- per-person mixed-tier pricing (needs governed products pricing writes — the
-- pricing-governance trigger is deliberately not poked; the product fixture is
-- a PRICE-LESS SHELL and the line uses an explicit manual override, which the
-- engine treats as a uniform price), and commissions on a job-backed happy path
-- (the happy path saves job-less; the job fixture only feeds the G2/G3 guards).
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin   uuid;
  v_rep     uuid;
  v_sfx     text := substr(gen_random_uuid()::text,1,8);
  v_cust_a  uuid; v_cust_b  uuid;
  v_field   uuid; v_field2  uuid;
  v_prod    uuid;
  v_svc     uuid;
  v_chem_only jsonb;
  v_g5_invoices int := 0;
  v_job     uuid;
  v_idem    text := 'smoke-plsb-'||v_sfx;
  v_invoice jsonb;
  v_fields  jsonb;
  v_lines   jsonb;
  v_save    jsonb;
  v_save2   jsonb;
  v_set_id  uuid;
  v_group   uuid;
  v_ids     uuid[];
  v_ids2    uuid[];
  v_sum     bigint;
  v_min     bigint;
  v_max     bigint;
  v_inv_count int;
  v_line_id uuid;
  v_src_cents bigint;
  v_src_qty numeric;
  v_share_cents bigint;
  v_share_micro bigint;
  v_share_qty   numeric;
  v_share_cnt   int;
  v_mismatch    int;
  v_calc    jsonb;
  v_amts    bigint[];
  v_err     text;
BEGIN
  -- ---- Actor: a REAL active admin, auth simulated via transaction-local claims.
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- ---- Fixtures: two co-owners on one 50/50 field, a second field NOT on the
  -- job, a PRICE-LESS product shell (pricing-governance trigger untouched; the
  -- line prices itself via an explicit manual override), and a completed job
  -- that owns ONLY the first field (feeds G2/G3).
  INSERT INTO customers (farm_name, assigned_tier) VALUES ('[E2E][SMOKE] PLSB A '||v_sfx, 1) RETURNING id INTO v_cust_a;
  INSERT INTO customers (farm_name, assigned_tier) VALUES ('[E2E][SMOKE] PLSB B '||v_sfx, 1) RETURNING id INTO v_cust_b;
  INSERT INTO fields (field_name, customer_id, total_acres)
    VALUES ('[E2E][SMOKE] PLSB Field '||v_sfx, v_cust_a, 100) RETURNING id INTO v_field;
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust_a, 50, true);
  INSERT INTO field_billing_defaults (field_id, customer_id, split_pct, is_primary)
    VALUES (v_field, v_cust_b, 50, false);
  INSERT INTO fields (field_name, customer_id, total_acres)
    VALUES ('[E2E][SMOKE] PLSB OffJob '||v_sfx, v_cust_a, 40) RETURNING id INTO v_field2;
  INSERT INTO products (product_name, unit_size) VALUES ('[E2E][SMOKE] PLSB Prod '||v_sfx, 'gal') RETURNING id INTO v_prod;
  INSERT INTO application_services (name, is_active) VALUES ('[E2E][SMOKE] PLSB Svc '||v_sfx, true) RETURNING id INTO v_svc;
  INSERT INTO jobs (job_number, customer_id, status, job_date, total_acres, created_by)
    VALUES ('[E2E][SMOKE] PLSB-'||v_sfx, v_cust_a, 'completed', CURRENT_DATE, 100, v_admin) RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 0);

  -- The shared save payload (reused VERBATIM for the idempotent replay — the
  -- wrapper hashes the payload and rejects a same-key different-payload retry).
  v_invoice := jsonb_build_object('invoice_date', CURRENT_DATE::text, 'header_notes', '[SMOKE] per-line split');
  v_fields  := jsonb_build_array(jsonb_build_object('field_id', v_field, 'applied_acres', 100));
  -- Manual-override chemical: 1501 c/gal x qty 1 = 1501 cents — an ODD source
  -- total that cannot split evenly two ways; only largest-remainder keeps the
  -- child sum exact (751 + 750). rate_unit matches the shell's null inventory
  -- unit, so field_app_priced_quantity is the identity conversion.
  -- Chemical-only payload: kept for the G5 fail-first probe below (the live impl
  -- crashes on any save with NO service line — v_app_service is referenced at
  -- plan-build for every line kind but only assigned for service lines).
  v_chem_only := jsonb_build_array(jsonb_build_object(
    'line_kind', 'chemical', 'product_id', v_prod, 'description', '[E2E][SMOKE] PLSB Chem',
    'source_quantity', 1, 'rate_unit', 'gal',
    'manual_override', true, 'source_unit_price_cents', 1501
  ));
  -- Happy-path payload: a manual-rate service line (100 c/acre x 100 acres =
  -- 10000c, splitting evenly 5000/5000) PLUS the odd-cents chemical line.
  -- The service line MUST come FIRST: the G5 bug means any line processed
  -- before the first service line hits the unassigned v_app_service record.
  v_lines := jsonb_build_array(jsonb_build_object(
    'line_kind', 'service', 'application_service_id', v_svc,
    'description', '[E2E][SMOKE] PLSB Svc', 'source_acres', 100,
    'manual_override', true, 'source_unit_price_cents', 100
  )) || v_chem_only;

  -- ---- P0: feature-flag gate fires for real (flag forced OFF first) ----------
  INSERT INTO app_settings (setting_key, setting_value)
    VALUES ('per_line_split_billing_enabled', 'false')
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'false';
  BEGIN
    PERFORM save_field_app_split_invoice(NULL, NULL, v_invoice, v_fields, v_lines, v_admin, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL(P0): save succeeded with the feature flag OFF';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'SPLIT_BILLING_DISABLED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(P0): wrong flag-off error: %', v_err;
    END IF;
  END;
  UPDATE app_settings SET setting_value = 'true' WHERE setting_key = 'per_line_split_billing_enabled';

  -- ---- G5 regression probe (bug FIXED live 2026-07-21, migration 20260721180000):
  -- a save with NO service line must succeed. The pre-fix impl referenced
  -- v_app_service.name at plan-build for EVERY line kind but only assigned the
  -- record for service lines, so a cold-connection save whose lines before the
  -- first service line were any other kind crashed with 55000 'record
  -- "v_app_service" is not assigned yet' (flaky by connection-pool warmth: a
  -- warmed plan cache masked it). This probe runs FIRST (cold plan) so any
  -- regression reproduces deterministically.
  BEGIN
    PERFORM save_field_app_split_invoice(NULL, NULL, v_invoice, v_fields, v_chem_only, v_admin, NULL, NULL);
    v_g5_invoices := 2; -- the successful probe minted its own pair for the co-owners
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL(G5 REGRESSION): first cold save with no service line crashed — %', SQLERRM;
  END;

  -- ---- P1: penny-exact odd split through the PUBLIC wrapper -------------------
  v_save   := save_field_app_split_invoice(NULL, NULL, v_invoice, v_fields, v_lines, v_admin, NULL, v_idem);
  v_set_id := (v_save->>'billing_set_id')::uuid;
  v_group  := (v_save->>'invoice_group_id')::uuid;
  v_ids    := ARRAY(SELECT (jsonb_array_elements_text(v_save->'invoice_ids'))::uuid);
  IF v_set_id IS NULL OR v_group IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): save returned no billing_set_id/invoice_group_id (%)', v_save;
  END IF;
  IF array_length(v_ids,1) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): expected 2 child invoices, got %', array_length(v_ids,1);
  END IF;
  SELECT COALESCE(SUM(total_amount_cents),0), MIN(total_amount_cents), MAX(total_amount_cents), count(*)
    INTO v_sum, v_min, v_max, v_inv_count
    FROM invoices WHERE invoice_group_id = v_group AND deleted_at IS NULL;
  IF v_inv_count <> 2 OR (SELECT count(DISTINCT customer_id) FROM invoices WHERE invoice_group_id = v_group) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): group is not one live invoice per co-owner (count %)', v_inv_count;
  END IF;
  -- 1501c chemical (odd, LR-split 751/750) + 10000c service (5000/5000)
  -- => children 5751/5750, sum exactly 11501.
  IF v_sum <> 11501 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): child totals sum to % cents, expected exactly 11501 (penny drift!)', v_sum;
  END IF;
  IF v_sum % 2 = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1 setup): total % is even — not an indivisible penny test', v_sum;
  END IF;
  IF v_min <> 5750 OR v_max <> 5751 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P1): largest-remainder shape wrong — children are %/% (expected 5750/5751)', v_min, v_max;
  END IF;

  -- ---- P2: stored-row invariants (never trust the RPC's self-report) ----------
  SELECT id, source_line_cents, source_quantity INTO v_line_id, v_src_cents, v_src_qty
    FROM field_app_billing_lines WHERE billing_set_id = v_set_id AND line_kind = 'chemical';
  IF v_line_id IS NULL OR v_src_cents <> 1501 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): billing line missing or source_line_cents % <> 1501', v_src_cents;
  END IF;
  SELECT COALESCE(SUM(amount_cents),0), COALESCE(SUM(split_micro_pct),0),
         SUM(allocated_quantity), count(*)
    INTO v_share_cents, v_share_micro, v_share_qty, v_share_cnt
    FROM invoice_line_shares WHERE billing_line_id = v_line_id;
  IF v_share_cnt <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): expected 2 invoice_line_shares, got %', v_share_cnt;
  END IF;
  IF v_share_cents <> v_src_cents THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): share cents % <> source_line_cents %', v_share_cents, v_src_cents;
  END IF;
  IF v_share_micro <> 100000000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): split_micro_pct sum % <> 100000000', v_share_micro;
  END IF;
  IF round(COALESCE(v_share_qty,0),4) <> round(v_src_qty,4) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): allocated_quantity sum % <> source_quantity %', v_share_qty, v_src_qty;
  END IF;
  -- item <-> share <-> header ties
  SELECT count(*) INTO v_mismatch
    FROM invoice_items ii JOIN invoice_line_shares ils ON ils.invoice_item_id = ii.id
   WHERE ii.invoice_id = ANY(v_ids) AND ii.extended_cents IS DISTINCT FROM ils.amount_cents;
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): % invoice_item(s) whose extended_cents <> their line share amount', v_mismatch;
  END IF;
  IF EXISTS (
    SELECT 1 FROM invoices i WHERE i.invoice_group_id = v_group AND i.deleted_at IS NULL
       AND i.total_amount_cents <> (SELECT COALESCE(SUM(s.amount_cents),0) FROM invoice_shares s WHERE s.invoice_id = i.id)
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P2): a child header total does not match its compat invoice_shares row';
  END IF;

  -- ---- P3: idempotent replay — same key + same payload => same ids ------------
  v_save2 := save_field_app_split_invoice(NULL, NULL, v_invoice, v_fields, v_lines, v_admin, NULL, v_idem);
  v_ids2  := ARRAY(SELECT (jsonb_array_elements_text(v_save2->'invoice_ids'))::uuid);
  IF v_ids2 IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P3): idempotent replay returned different invoice ids (double-save risk)';
  END IF;
  SELECT count(*) INTO v_inv_count FROM invoices
   WHERE customer_id IN (v_cust_a, v_cust_b) AND invoice_type = 'field_application' AND deleted_at IS NULL;
  IF v_inv_count <> 2 + v_g5_invoices THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P3): replay created extra invoices — % exist for the two co-owners (exp %)', v_inv_count, 2 + v_g5_invoices;
  END IF;

  -- ---- P4: calculator direct — 100 cents 3-way even => {34,33,33} -------------
  v_calc := compute_line_split_allocation(jsonb_build_object(
    'billing_line_id', 'smoke-'||v_sfx, 'line_kind', 'flat_fee', 'source_flat_cents', 100,
    'base_price_source', 'flat',
    'shares', (SELECT jsonb_agg(jsonb_build_object(
                 'customer_id', e->>'customer_id', 'micro_pct', (e->>'micro_pct')::bigint,
                 'split_mode', 'custom', 'price_mode', 'default'))
                 FROM jsonb_array_elements(compute_even_split_vector(
                        jsonb_build_array('c1-'||v_sfx, 'c2-'||v_sfx, 'c3-'||v_sfx))) AS e)));
  v_amts := ARRAY(SELECT (a->>'amount_cents')::bigint
                    FROM jsonb_array_elements(v_calc->'allocations') AS a
                   ORDER BY (a->>'amount_cents')::bigint DESC);
  IF (v_calc->>'group_total_cents')::bigint <> 100
     OR v_amts <> ARRAY[34,33,33]::bigint[] THEN
    RAISE EXCEPTION 'SMOKE_FAIL(P4): 3-way even split of 100c gave % (total %), expected {34,33,33}=100',
      v_amts, v_calc->>'group_total_cents';
  END IF;

  -- ---- G1: same chemical product on two lines is refused ----------------------
  BEGIN
    PERFORM save_field_app_split_invoice(NULL, NULL, v_invoice, v_fields,
      v_lines || v_lines,   -- the same product twice
      v_admin, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL(G1): duplicate-product save was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'SPLIT_DUPLICATE_PRODUCT%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(G1): wrong duplicate-product error: %', v_err;
    END IF;
  END;

  -- ---- G2: billing a field that is not on the source job is refused -----------
  BEGIN
    PERFORM save_field_app_split_invoice(NULL, v_job, v_invoice,
      jsonb_build_array(jsonb_build_object('field_id', v_field2, 'applied_acres', 40)),
      v_lines, v_admin, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL(G2): off-job field save was accepted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'SPLIT_FIELD_NOT_ON_JOB%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(G2): wrong off-job-field error: %', v_err;
    END IF;
  END;

  -- ---- G3: attaching a source job on re-save of a job-less set is refused -----
  BEGIN
    PERFORM save_field_app_split_invoice(v_set_id, v_job, v_invoice, v_fields, v_lines, v_admin, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL(G3): re-save changed the set''s source job';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'SPLIT_JOB_IMMUTABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL(G3): wrong job-immutability error: %', v_err;
    END IF;
  END;

  -- ---- G4: resolver auth gate probed as a NON-ADMIN ---------------------------
  -- The earlier save set crx.split_writer='on' transaction-locally (it survives
  -- to the end of this DO block), which would exempt the resolver's ownership
  -- gate — force it back off before probing. The smoke customers have no
  -- assigned_sales_rep, so ANY real sales_rep must be refused.
  SELECT id INTO v_rep FROM profiles
   WHERE role = 'sales_rep' AND is_active = true AND id <> v_admin
   ORDER BY created_at LIMIT 1;
  IF v_rep IS NULL THEN
    RAISE NOTICE 'G4 SKIPPED: no active sales_rep profile to impersonate — resolver non-admin gate NOT verified';
  ELSE
    PERFORM set_config('crx.split_writer', 'off', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role','authenticated')::text, true);
    BEGIN
      PERFORM resolve_line_split_vector(ARRAY[v_field], NULL,
        jsonb_build_object(v_field::text, 100));
      RAISE EXCEPTION 'SMOKE_FAIL(G4): non-admin resolved another rep''s customers'' split vector';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'RESOLVER_NOT_AUTHORIZED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL(G4): wrong resolver auth error: %', v_err;
      END IF;
    END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  END IF;

  RAISE NOTICE 'SMOKE OK: flag gate, 751/750 of 1501c penny-exact, stored invariants tie, idempotent replay, {34,33,33} 3-way, dup-product/off-job-field/job-immutable/resolver-auth guards fired';
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;

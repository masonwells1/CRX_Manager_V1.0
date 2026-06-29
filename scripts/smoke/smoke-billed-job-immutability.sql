-- ============================================================================
-- SMOKE TEST (rolled back by design): _enforce_billed_job_immutability trigger
-- migrations 20260625190000_guard_billed_job_immutability.sql
--          + 20260629120000_guard_billed_job_immutability_invoice_id.sql (P1 remediation)
-- ----------------------------------------------------------------------------
-- Regression guard for the BEFORE-UPDATE billed-job immutability trigger on
-- public.jobs. The invariant: a NON-admin (sales_rep) cannot mutate billed
-- history on an INVOICED job, but legitimate exempt paths, the admin hatch, and
-- the two sanctioned SECURITY DEFINER transfer writers all still work.
--
-- Role-sim: setup runs as the table owner (RLS bypassed). Each "non-admin"
-- assertion runs under `SET LOCAL ROLE authenticated` with request.jwt.claims
-- sub = a real sales_rep (so is_admin()=false, is_sales_rep()=true). RESET ROLE
-- returns to owner for the admin/hatch/transfer asserts.
--
--   BLOCKED (non-admin, invoiced job) — each RAISES, mutates nothing:
--     B1  soft-delete (deleted_at NULL -> non-NULL)
--     B2  rewrite total_price_cents
--     B3  rewrite invoice_id -> NULL          (P1 remediation: detach)
--     B4  rewrite invoice_id -> other invoice (P1 remediation: repoint)
--   EXEMPT (non-admin, invoiced job) — each SUCCEEDS:
--     E1  printed_at / last_printed_by (print audit stamp)
--     E2  applied_acres               (as-applied recompute rollup)
--     E3  updated_at / updated_by     (bookkeeping)
--     E4  status forward transition   (invoiced is terminal forward; we instead
--                                       prove a *non-status* exempt edit; status
--                                       itself is governed by the sibling enforcer)
--   HATCH:
--     H1  an ADMIN (jwt sub = admin) CAN rewrite total_price_cents on the
--         invoiced job (the human correction path)
--     H2  app.admin_override='true' lets an otherwise-blocked write through
--   LEGIT WRITERS (the two SECURITY DEFINER transfer RPCs still succeed):
--     L1  transfer_job_to_invoice  (writes jobs.invoice_id while status='completed')
--     L2  transfer_invoice_to_job  (clears jobs.invoice_id under the override hatch)
--
-- Ends in RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any other error = FAIL.
-- ============================================================================
DO $smoke$
DECLARE
  v_sfx     text := substr(gen_random_uuid()::text,1,8);
  v_admin   uuid;
  v_sales   uuid;
  v_cust    uuid;
  v_prodA   uuid;
  v_field   uuid;
  v_job     uuid;   -- the INVOICED job under guard
  v_job2    uuid;   -- a second completed job (source of L1 transfer)
  v_inv     uuid;   -- the invoice linked to v_job
  v_inv2    uuid;   -- a second invoice (B4 repoint target)
  v_res     jsonb;
  v_jobR    RECORD;
  v_n       int;
  v_price   bigint;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin'     AND is_active=true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_sales FROM profiles WHERE role='sales_rep' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no admin profile'; END IF;
  IF v_sales IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no sales_rep profile'; END IF;

  -- ── SETUP (owner privileges, RLS bypassed; act as admin for the build) ─────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] IMMUT '||v_sfx) RETURNING id INTO v_cust;
  INSERT INTO products (product_name, unit_size, epa_registration, product_form)
    VALUES ('[SMOKE] IMMUT Prod '||v_sfx,'GL','[SMOKE]-EPA-IM','liquid') RETURNING id INTO v_prodA;
  INSERT INTO fields (customer_id, field_name, crop_type)
    VALUES (v_cust,'[SMOKE] IMMUT F1 '||v_sfx,'corn') RETURNING id INTO v_field;

  -- Build a completed job, then transfer it to an invoice so its status='invoiced'
  -- and invoice_id is set the SANCTIONED way (exercises L1 as part of setup).
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] IMMUT JOB-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, 50000, 20000, v_admin)
    RETURNING id INTO v_job;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job, v_field, 100, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job, v_prodA, 10, 'GL', 0.5, 'PT', 2000, 5000, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job;
  UPDATE jobs SET status='completed'   WHERE id=v_job;

  v_res := transfer_job_to_invoice(v_job, v_admin, '[SMOKE] im-fwd-'||v_sfx);   -- L1 (setup)
  v_inv := (v_res->>'invoice_id')::uuid;
  SELECT * INTO v_jobR FROM jobs WHERE id=v_job;
  IF v_jobR.status<>'invoiced' OR v_jobR.invoice_id<>v_inv THEN
    RAISE EXCEPTION 'SMOKE_SETUP: job not invoiced/linked after transfer (% / %)', v_jobR.status, v_jobR.invoice_id;
  END IF;

  -- A SECOND completed job + its invoice, for the B4 repoint target.
  INSERT INTO jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] IMMUT JOB2-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-3, 2026, 70000, 30000, v_admin)
    RETURNING id INTO v_job2;
  INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job2, v_field, 50, 1);
  INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_job2, v_prodA, 5, 'GL', 0.5, 'PT', 2000, 5000, 1);
  UPDATE jobs SET status='in_progress' WHERE id=v_job2;
  UPDATE jobs SET status='completed'   WHERE id=v_job2;
  v_res := transfer_job_to_invoice(v_job2, v_admin, '[SMOKE] im-fwd2-'||v_sfx);
  v_inv2 := (v_res->>'invoice_id')::uuid;

  -- ════════════════════════════════════════════════════════════════════════
  -- NON-ADMIN BLOCKED PATHS — become the sales_rep with RLS enforced.
  -- ════════════════════════════════════════════════════════════════════════
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- B1: soft-delete a billed job -> RAISES.
  BEGIN
    UPDATE jobs SET deleted_at = now() WHERE id = v_job;
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: B1 non-admin soft-deleted an invoiced job';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE '%cannot be deleted by a non-admin%' THEN
      RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: B1 wrong error: %', SQLERRM;
    END IF;
  END;

  -- B2: rewrite total_price_cents -> RAISES.
  BEGIN
    UPDATE jobs SET total_price_cents = 99999 WHERE id = v_job;
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: B2 non-admin rewrote total_price_cents on an invoiced job';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE '%cannot edit its billed-relevant fields%' THEN
      RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: B2 wrong error: %', SQLERRM;
    END IF;
  END;

  -- B3: detach invoice_id -> NULL -> RAISES (P1 remediation).
  BEGIN
    UPDATE jobs SET invoice_id = NULL WHERE id = v_job;
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: B3 non-admin detached invoice_id (->NULL) on a billed job';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE '%cannot edit its billed-relevant fields%' THEN
      RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: B3 wrong error: %', SQLERRM;
    END IF;
  END;

  -- B4: repoint invoice_id -> another invoice -> RAISES (P1 remediation).
  BEGIN
    UPDATE jobs SET invoice_id = v_inv2 WHERE id = v_job;
    RESET ROLE;
    RAISE EXCEPTION 'SMOKE_FAIL: B4 non-admin repointed invoice_id on a billed job';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RESET ROLE; RAISE; END IF;
    IF SQLERRM NOT LIKE '%cannot edit its billed-relevant fields%' THEN
      RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: B4 wrong error: %', SQLERRM;
    END IF;
  END;

  -- Sanity: nothing above mutated the row (still invoiced, linked, original price).
  SELECT * INTO v_jobR FROM jobs WHERE id=v_job;
  IF v_jobR.status<>'invoiced' OR v_jobR.invoice_id<>v_inv
     OR v_jobR.total_price_cents<>50000 OR v_jobR.deleted_at IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: a blocked path leaked a mutation (% / % / % / %)',
      v_jobR.status, v_jobR.invoice_id, v_jobR.total_price_cents, v_jobR.deleted_at;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- NON-ADMIN EXEMPT PATHS — same sales_rep, must SUCCEED.
  -- ════════════════════════════════════════════════════════════════════════
  -- E1: print-audit stamp.
  UPDATE jobs SET printed_at = now(), last_printed_by = v_sales WHERE id = v_job;
  SELECT last_printed_by INTO v_jobR.last_printed_by FROM jobs WHERE id=v_job;
  IF v_jobR.last_printed_by IS DISTINCT FROM v_sales THEN
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: E1 print stamp did not persist';
  END IF;

  -- E2: as-applied recompute rollup column.
  UPDATE jobs SET applied_acres = 42 WHERE id = v_job;
  SELECT applied_acres INTO v_jobR.applied_acres FROM jobs WHERE id=v_job;
  IF v_jobR.applied_acres IS DISTINCT FROM 42 THEN
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: E2 applied_acres did not persist (%)', v_jobR.applied_acres;
  END IF;

  -- E3/E4: bookkeeping + a no-op-on-billed-columns edit (updated_by) succeeds.
  UPDATE jobs SET updated_by = v_sales WHERE id = v_job;
  SELECT updated_by INTO v_jobR.updated_by FROM jobs WHERE id=v_job;
  IF v_jobR.updated_by IS DISTINCT FROM v_sales THEN
    RESET ROLE; RAISE EXCEPTION 'SMOKE_FAIL: E3 updated_by did not persist';
  END IF;

  RESET ROLE;

  -- ════════════════════════════════════════════════════════════════════════
  -- ADMIN HATCH — admin CAN make the otherwise-blocked change.
  -- ════════════════════════════════════════════════════════════════════════
  -- H1: admin jwt sub -> is_admin()=true -> early return -> price rewrite allowed.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);
  UPDATE jobs SET total_price_cents = 55500 WHERE id = v_job;
  SELECT total_price_cents INTO v_price FROM jobs WHERE id=v_job;
  IF v_price <> 55500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: H1 admin could not correct billed total_price_cents (%)', v_price;
  END IF;

  -- H2: the SECURITY DEFINER override hatch lets a write through even without is_admin().
  -- Simulate the sales_rep jwt but flip the definer-flow hatch (as a SECURITY DEFINER
  -- RPC would via SET LOCAL app.admin_override='true').
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role','authenticated')::text, true);
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE jobs SET total_price_cents = 56000 WHERE id = v_job;
  SELECT total_price_cents INTO v_price FROM jobs WHERE id=v_job;
  IF v_price <> 56000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: H2 admin_override hatch did not let the write through (%)', v_price;
  END IF;
  PERFORM set_config('app.admin_override', 'false', true);

  -- ════════════════════════════════════════════════════════════════════════
  -- LEGIT SECURITY DEFINER WRITERS still succeed.
  -- ════════════════════════════════════════════════════════════════════════
  -- Restore admin context for the RPC calls (they strict-actor bind auth.uid()).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- L1: transfer_job_to_invoice writes jobs.invoice_id while status='completed'
  --     (the guard early-returns for non-billed status). Use v_job2's twin path:
  --     v_job2 is already invoiced from setup; build a fresh completed job here.
  DECLARE
    v_job3 uuid; v_inv3 uuid;
  BEGIN
    INSERT INTO jobs (job_number, customer_id, status, job_date, season, total_price_cents, total_cost_cents, created_by)
      VALUES ('[SMOKE] IMMUT JOB3-'||v_sfx, v_cust, 'scheduled', CURRENT_DATE-2, 2026, 30000, 12000, v_admin)
      RETURNING id INTO v_job3;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job3, v_field, 25, 1);
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
      VALUES (v_job3, v_prodA, 3, 'GL', 0.5, 'PT', 2000, 5000, 1);
    UPDATE jobs SET status='in_progress' WHERE id=v_job3;
    UPDATE jobs SET status='completed'   WHERE id=v_job3;
    v_res := transfer_job_to_invoice(v_job3, v_admin, '[SMOKE] im-L1-'||v_sfx);
    v_inv3 := (v_res->>'invoice_id')::uuid;
    SELECT * INTO v_jobR FROM jobs WHERE id=v_job3;
    IF v_jobR.status<>'invoiced' OR v_jobR.invoice_id<>v_inv3 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: L1 transfer_job_to_invoice did not invoice/link (% / %)', v_jobR.status, v_jobR.invoice_id;
    END IF;

    -- L2: transfer_invoice_to_job clears jobs.invoice_id under the override hatch.
    v_res := transfer_invoice_to_job(v_inv3, v_admin, '[SMOKE] im-L2-'||v_sfx);
    IF (v_res->>'success')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'SMOKE_FAIL: L2 transfer_invoice_to_job did not succeed';
    END IF;
    SELECT * INTO v_jobR FROM jobs WHERE id=v_job3;
    IF v_jobR.status<>'completed' OR v_jobR.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: L2 reverse did not restore job/clear invoice_id (% / %)', v_jobR.status, v_jobR.invoice_id;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;

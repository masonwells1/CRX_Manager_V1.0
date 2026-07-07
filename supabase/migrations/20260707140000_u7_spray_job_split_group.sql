-- 20260707140000_u7_spray_job_split_group.sql
-- U7 (business-workflow-review #42 / #100 / #50) — SPRAY-JOB half of splits unification.
--
-- GOAL: when a spray job's fields are billed to MORE THAN ONE owner (landlord/tenant),
-- "Transfer to Invoice" now produces ONE payable invoice PER owner (an invoice GROUP,
-- linked by invoices.invoice_group_id) instead of a single invoice to the primary
-- customer carrying unpayable invoice_shares. Each owner's invoice bills that owner's
-- acre-weighted share of the job's chemicals + application fee, and mints that owner's
-- own per-invoice commission. SINGLE-OWNER jobs are unchanged (byte-identical path).
--
-- APPROACH: mirror the SHIPPED delivery half (create_split_invoices_from_order):
--   * split each agreed price BY billable acres, penny-exact via calculate_billing_splits;
--   * job chemicals apply at a uniform rate across all the job's fields, so an owner's
--     slice of every chemical == (owner billable acres / total billable acres);
--   * commission is minted per member invoice on THAT member's chemical-line profit —
--     the U8 helper _insert_commissions_for_job is CALLED per member (unchanged); its
--     internals are NOT touched. commissions carry (job_id, invoice_id), so the existing
--     invoice_id-scoped reversal in void/delete/transfer-back already reverses per member.
--
-- SCOPE (v1, disclosed): per-field $/acre PRICE OVERRIDES are NOT supported in the split
-- (the delivery half ignores price_override too). A multi-owner job that carries an
-- override is REFUSED with SPLIT_OVERRIDE_UNSUPPORTED rather than silently re-priced;
-- bill it as a single invoice or via the field-application editor.
--
-- Four functions change (all keep their signature -> CREATE OR REPLACE preserves grants):
--   1. transfer_job_to_invoice  — NEW multi-owner group branch (single-owner unchanged).
--   2. void_invoice             — job-release becomes "release only when the LAST live
--                                 group member is gone; re-point jobs.invoice_id off a
--                                 voided anchor to a surviving member".
--   3. delete_invoices          — same group-aware release.
--   4. transfer_invoice_to_job  — reverse the WHOLE group from the anchor; refuse from a
--                                 non-anchor member.
--
-- The three lifecycle edits change ONLY the job-release block (commission reversal there
-- is already commissions.invoice_id-scoped and needs no change) — proven byte-identical
-- everywhere else via reconstruction md5.

-- ============================================================================
-- 1. transfer_job_to_invoice — multi-owner per-owner invoice GROUP
-- ============================================================================
CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-8 (G1 per-acre fee) locals
  v_fee jsonb;
  v_fee_total bigint := 0;
  v_fee_cost bigint := 0;
  v_fee_c bigint;
  v_cost_c bigint;
  v_fee_acres numeric := 0;
  -- U8 (#99 commissions on the application channel) locals
  v_commission_split jsonb;
  v_chem_profit_cents bigint := 0;
  -- U7 (#42/#100/#50 multi-owner group) locals
  v_n_owners integer := 0;
  v_group_id uuid;
  v_owner_ids uuid[];
  v_owner_names text[];
  v_owner_acres numeric[];
  v_owner_primary boolean[];
  v_total_billable_acres numeric := 0;
  v_acre_pcts numeric[];
  v_chem_price_split bigint[];
  v_chem_cost_split bigint[];
  v_oidx integer;
  v_member_id uuid;
  v_member_ids uuid[] := '{}';
  v_anchor_id uuid;
  v_member_acres numeric;
  v_member_total bigint;
  v_member_cost bigint;
  v_member_profit_cents bigint := 0;
  v_member_field_names text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- BEGIN DELTA-7 (G3 strict-actor): the role gate above is on auth.uid(), but
  -- p_performed_by was written verbatim to created_by / the activity log, so the
  -- recorded performer was forgeable. Bind the authenticated user and reject a
  -- mismatch (matches complete_job / start_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  -- END DELTA-7

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_job_to_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.* INTO v_job FROM jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  IF v_job.status = 'invoiced' THEN RAISE EXCEPTION 'Job already invoiced'; END IF;
  IF v_job.status != 'completed' THEN RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status; END IF;

  -- U6 #91b: refuse to invoice the job if a blend ticket for the SAME job has already
  -- been billed (payment_status='billed' = a live, non-voided invoice exists for it).
  -- The blend-ticket invoice and this job invoice bill the same application, so
  -- allowing both double-bills the customer. Block, do not warn. (The
  -- trg_sync_blend_ticket_payment trigger resets billed->unbilled when that invoice
  -- is voided, so a genuine re-bill after a void is unaffected.)
  -- Codex R3 P2: test for a LIVE blend-ticket invoice directly (mirror of the
  -- opposite guard's invoices.job_id test) — payment_status can be written
  -- manually via update_blend_ticket_billing_status and drift out of sync.
  IF EXISTS (
    SELECT 1 FROM blend_tickets bt
    JOIN invoices i ON i.blend_ticket_id = bt.id
    WHERE bt.job_id = p_job_id
      AND bt.deleted_at IS NULL  -- Codex R2 P2: a soft-deleted ticket must not block forever
      AND i.status NOT IN ('voided', 'cancelled')
      AND i.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ALREADY_BILLED: a blend ticket for this job has already been billed; invoicing the job too would double-bill the customer. Void that blend-ticket invoice first if you meant to re-bill here.';
  END IF;

  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat, f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN v_crop_types := array_append(v_crop_types, v_field.f_crop_type); END IF;
  END LOOP;

  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type FROM unnest(v_crop_types);
  END IF;

  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.vehicle_name INTO v_vehicle_name FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  -- ==========================================================================
  -- U7 (#42 / #100 / #50): MULTI-OWNER per-owner invoice GROUP.
  -- Trigger ONLY on EXPLICIT multi-owner billing: >1 distinct field_billing_defaults
  -- customer across the job's fields (the landlord/tenant setup the finding is about).
  -- A job with NO billing defaults keeps today's single-invoice behavior, even if its
  -- fields belong to different customers — no surprise change. In the group path, any
  -- field WITHOUT billing defaults falls back to the field's own customer at 100%
  -- (mirror of create_split_invoices_from_order).
  -- ==========================================================================
  SELECT count(DISTINCT fbd.customer_id) INTO v_n_owners
    FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
    WHERE jf.job_id = p_job_id;

  IF COALESCE(v_n_owners, 0) > 1 THEN
    -- Scope guard: per-field $/acre overrides are not supported by the percentage/acre
    -- split. Refuse rather than silently drop an override the single-invoice path honors.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_OVERRIDE_UNSUPPORTED: this multi-owner job has per-field $/acre price overrides. Percentage split billing does not support overrides — bill it as a single invoice, or price each owner in the field-application editor.';
    END IF;

    -- Validate every billed field's splits total 100 (mirror FIELD_SPLIT_NOT_100), so the
    -- owner acre shares sum to the job acres and calculate_billing_splits stays penny-exact.
    IF EXISTS (
      SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      WHERE jf.job_id = p_job_id
      GROUP BY jf.field_id HAVING sum(fbd.split_pct) < 99.99 OR sum(fbd.split_pct) > 100.01
    ) THEN
      RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: one or more of this job''s fields has billing splits that do not total 100%%. Fix the field billing defaults before invoicing.';
    END IF;

    -- Ordered owner arrays (stable ORDER BY owner_id) with each owner's BILLABLE ACRES:
    -- fbd fields contribute acres_to_treat * split_pct/100; non-fbd fields contribute
    -- their full acres to the field's own customer.
    SELECT array_agg(owner_id ORDER BY owner_id),
           array_agg(farm_name ORDER BY owner_id),
           array_agg(billable_acres ORDER BY owner_id),
           array_agg(is_primary ORDER BY owner_id)
      INTO v_owner_ids, v_owner_names, v_owner_acres, v_owner_primary
    FROM (
      SELECT owner_id,
             sum(billable_acres) AS billable_acres,
             bool_or(is_primary) AS is_primary,
             max(farm_name) AS farm_name
      FROM (
        SELECT fbd.customer_id AS owner_id,
               COALESCE(jf.acres_to_treat, 0) * fbd.split_pct / 100.0 AS billable_acres,
               COALESCE(fbd.is_primary, false) AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN customers c ON c.id = fbd.customer_id
          WHERE jf.job_id = p_job_id
        UNION ALL
        SELECT COALESCE(f.customer_id, v_job.customer_id) AS owner_id,
               COALESCE(jf.acres_to_treat, 0) AS billable_acres,
               false AS is_primary, c.farm_name
          FROM job_fields jf
          JOIN fields f ON f.id = jf.field_id
          JOIN customers c ON c.id = COALESCE(f.customer_id, v_job.customer_id)
          WHERE jf.job_id = p_job_id
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) parts
      GROUP BY owner_id
    ) oa;

    v_total_billable_acres := COALESCE((SELECT sum(a) FROM unnest(v_owner_acres) a), 0);
    IF v_total_billable_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_NO_ACRES: cannot split a multi-owner job with zero billable acres (job %)', v_job.job_number;
    END IF;

    -- Acre-share percentages across owners (sum to exactly 100 -> penny-exact splits).
    SELECT array_agg(a / v_total_billable_acres * 100 ORDER BY ord)
      INTO v_acre_pcts FROM unnest(v_owner_acres) WITH ORDINALITY AS u(a, ord);

    v_group_id := gen_random_uuid();

    -- Create one draft invoice per owner (empty; filled in the chemical/fee loops below).
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_acres := v_owner_acres[v_oidx];

      -- Fields this owner is billed for (informational header list).
      SELECT array_agg(DISTINCT fname ORDER BY fname) INTO v_member_field_names FROM (
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
          JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND fbd.customer_id = v_owner_ids[v_oidx]
        UNION
        SELECT f.field_name AS fname
          FROM job_fields jf JOIN fields f ON f.id = jf.field_id
          WHERE jf.job_id = p_job_id AND f.customer_id = v_owner_ids[v_oidx]
            AND NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd2 WHERE fbd2.field_id = jf.field_id)
      ) mf;

      v_invoice_number := next_invoice_number('field_application');
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
        field_names, crop_type, total_acres, applicator_name, vehicle_name,
        application_date, header_notes, season, created_by, job_id,
        application_service_id, invoice_group_id
      ) VALUES (
        v_invoice_number, v_owner_ids[v_oidx], 'field_application', 'draft',
        CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
        0, 0, 0, 0,
        COALESCE(v_member_field_names, v_field_names), v_crop_type, v_member_acres, v_applicator_name, v_vehicle_name,
        v_job.job_date, v_job.notes,
        COALESCE(
          v_job.season,
          CASE WHEN extract(month FROM CURRENT_DATE) >= 10
               THEN extract(year FROM CURRENT_DATE)::integer + 1
               ELSE extract(year FROM CURRENT_DATE)::integer END
        ),
        p_performed_by, p_job_id, v_job.application_service_id, v_group_id
      ) RETURNING id INTO v_member_id;
      v_member_ids := array_append(v_member_ids, v_member_id);
    END LOOP;

    -- Chemical lines: split each chemical's agreed price/cost across owners BY acre share
    -- (penny-exact). qty / applied-acres are prorated by the same share.
    v_item_order := 0;
    FOR v_chem IN
      SELECT jc.product_id, jc.rate_per_acre,
             safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
             safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
             jc.quantity,
             jc.customer_supplied,
             p.product_name, p.unit_size, p.epa_registration, p.product_form,
             COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
      FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
      WHERE jc.job_id = p_job_id ORDER BY p.product_name
    LOOP
      v_item_order := v_item_order + 1;
      -- customer-supplied products carry $0 price AND $0 cost (we didn't buy them).
      v_chem_price_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END, v_acre_pcts);
      v_chem_cost_split := calculate_billing_splits(
        CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END, v_acre_pcts);

      FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
        v_member_acres := v_owner_acres[v_oidx];
        -- Owner's applied amount = rate x their acres (their slice of the uniform-rate
        -- application). The line quantity stays 1 (a single job-chemical line, matching
        -- the single-owner path where unit_price == extended); the real applied amount
        -- lives in total_applied / total_applied_gl_lb.
        v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_member_acres > 0
          THEN v_chem.rate_per_acre * v_member_acres ELSE NULL END;
        SELECT * INTO v_conversion
          FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
          epa_registration, product_form, is_application_fee, price_source
        ) VALUES (
          v_member_ids[v_oidx], v_chem.product_id,
          CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
          1,
          v_chem.unit_size,
          v_chem_price_split[v_oidx],
          v_chem_price_split[v_oidx],
          v_chem_cost_split[v_oidx],
          v_item_order, v_member_acres,
          v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
          COALESCE(v_chem.rate_unit, v_chem.unit_size),
          v_conversion.converted_value, v_conversion.converted_unit,
          v_chem.epa_registration, v_chem.product_form, false,
          CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
        );
      END LOOP;
    END LOOP;

    -- Per-owner totals, per-acre application fee, header flip, and per-member commission.
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      v_member_acres := v_owner_acres[v_oidx];

      SELECT COALESCE(SUM(extended_cents), 0), COALESCE(SUM(cost_cents), 0)
        INTO v_member_total, v_member_cost
        FROM invoice_items WHERE invoice_id = v_member_id;

      -- DELTA-8 per-acre machine fee at this owner's own rate, on this owner's acres.
      IF v_job.application_service_id IS NOT NULL AND v_member_acres > 0 THEN
        v_fee := compute_application_service_fee(
                   v_job.application_service_id, v_owner_ids[v_oidx], v_member_acres, v_job.season);
        v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
        v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
        IF v_fee_c > 0 THEN
          v_item_order := v_item_order + 1;
          INSERT INTO invoice_items (
            invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
            cost_cents, sort_order, acres, rate_per_acre, rate_unit,
            is_application_fee, price_source
          ) VALUES (
            v_member_id, COALESCE(v_fee->>'service_name', 'Application'), v_member_acres, 'acre',
            ROUND(v_fee_c / v_member_acres)::bigint, v_fee_c,
            v_cost_c, v_item_order, v_member_acres,
            ROUND(v_fee_c / v_member_acres)::bigint, 'acre',
            true, 'tier'
          );
          v_member_total := v_member_total + v_fee_c;
          v_member_cost  := v_member_cost + v_cost_c;
        END IF;
      END IF;

      UPDATE invoices SET total_amount_cents = v_member_total, total_cost_cents = v_member_cost
        WHERE id = v_member_id;

      -- one invoice_shares row (100% of this member -> itself) so statements/year-end read it.
      INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
      VALUES (v_member_id, v_owner_ids[v_oidx], v_owner_names[v_oidx], 100.0, v_member_acres, v_member_total,
              COALESCE(v_owner_primary[v_oidx], false), v_oidx);

      -- DELTA-4: draft -> unposted now that the member is fully built.
      UPDATE invoices SET status = 'unposted' WHERE id = v_member_id;
    END LOOP;

    -- Commission split resolution (mirror of the single-owner path: snapshot on the job,
    -- else the parent quote's split, else the customer default for pre-U8 jobs).
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Anchor = the primary owner's member (else the first). jobs.invoice_id is a scalar,
    -- so it points at the anchor; siblings are found via invoices.invoice_group_id / job_id.
    -- v_member_ids[i] corresponds to v_owner_ids[i] / v_owner_primary[i] (same build order).
    v_anchor_id := v_member_ids[1];
    FOR v_oidx IN 1 .. array_length(v_owner_ids, 1) LOOP
      IF COALESCE(v_owner_primary[v_oidx], false) THEN
        v_anchor_id := v_member_ids[v_oidx];
        EXIT;
      END IF;
    END LOOP;

    UPDATE jobs SET status = 'invoiced', invoice_id = v_anchor_id,
      commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
    WHERE id = p_job_id;
    UPDATE application_records SET invoice_id = v_anchor_id WHERE source_type = 'job' AND source_id = p_job_id;

    -- Per-member commission: on THAT member's chemical-line profit (product lines only,
    -- excludes the per-acre fee). Sum across members == the whole job's chemical profit.
    FOR v_oidx IN 1 .. array_length(v_member_ids, 1) LOOP
      v_member_id := v_member_ids[v_oidx];
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
        INTO v_member_profit_cents
      FROM invoice_items ii
      WHERE ii.invoice_id = v_member_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      PERFORM _insert_commissions_for_job(
        p_job_id, v_member_id, v_owner_ids[v_oidx],
        v_member_profit_cents::numeric / 100.0,
        v_commission_split,
        CURRENT_DATE
      );

      -- Per-member creation audit row (mirror of the single path's invoice_created row).
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_user_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_member_id, auth.uid(),
        (SELECT role FROM profiles WHERE id = auth.uid()),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_member_id),
          'job_id', p_job_id,
          'customer_id', v_owner_ids[v_oidx],
          'invoice_group_id', v_group_id,
          'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_member_id)
        ),
        (SELECT total_amount_cents FROM invoices WHERE id = v_member_id),
        'Split invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_member_id) ||
          ' created from job ' || v_job.job_number || ' (per-owner group)'
      );
    END LOOP;

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('job_invoiced',
      'Job ' || v_job.job_number || ' transferred to a ' || array_length(v_member_ids, 1) ||
        '-owner split invoice group',
      COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

    v_result := jsonb_build_object(
      'success', true, 'job_id', p_job_id,
      'invoice_id', v_anchor_id,
      'invoice_ids', to_jsonb(v_member_ids),
      'invoice_group_id', v_group_id,
      'invoice_count', array_length(v_member_ids, 1),
      'split', true
    );

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
    END IF;

    RETURN v_result;
  END IF;
  -- ================= end multi-owner group path =================

  -- OVERNIGHT FIX (Run 2 cycle 6 — invoice-number canonicalization, Codex-confirmed MEDIUM):
  -- use the shared next_invoice_number() — the SAME invoice_number_seq, 'invoice_number:INV:<year>'
  -- advisory lock, and setval self-heal that every other invoice creator AND the
  -- invoices.invoice_number column default use. The previous inline
  -- `pg_advisory_xact_lock(hashtext('invoice_number'))` + MAX(regexp_replace(...))+1 scan took a
  -- DIFFERENT advisory-lock key, so it did not serialize against other INV creators (two callers
  -- could compute the same number -> 23505 on the UNIQUE index invoices_invoice_number_key,
  -- aborting the transfer) and it never advanced invoice_number_seq.
  v_invoice_number := next_invoice_number('field_application');

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres, applicator_name, vehicle_name,
    application_date, header_notes, season, created_by, job_id,
    application_service_id
  ) VALUES (
    -- insert as 'draft' (DELTA-1) — trg_invoice_draft_insert rejects non-draft,
    -- non-credit_memo inserts; DELTA-4 flips to 'unposted' once fully built.
    v_invoice_number, v_job.customer_id, 'field_application', 'draft',
    CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    v_job.job_date, v_job.notes,
    -- N2-7 #109<<< stamp the JOB's season, not the season-of-now. An invoice cut in a
    -- later season for a prior-season job must file under the job's season (reports/
    -- year-end read invoices.season). invoices.season is NOT NULL and jobs.season is
    -- nullable, so COALESCE back to the ORIGINAL CURRENT_DATE-based expression when the
    -- job has no season — never stamp NULL, and legacy null-season jobs behave exactly
    -- as before this migration.
    COALESCE(
      v_job.season,
      CASE WHEN extract(month FROM CURRENT_DATE) >= 10
           THEN extract(year FROM CURRENT_DATE)::integer + 1
           ELSE extract(year FROM CURRENT_DATE)::integer END
    ),
    -- >>>N2-7 #109
    p_performed_by, p_job_id, v_job.application_service_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre,
           safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
           safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
           jc.customer_supplied,
           p.product_name, p.unit_size, p.epa_registration, p.product_form,
           COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    -- U4<<< a grower-supplied product costs us nothing (we didn't buy it) — keep
    -- it OUT of the invoice cost so margin isn't understated. (#53/#54)
    v_total_cost_cents := v_total_cost_cents + CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END;
    -- >>>U4
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- DELTA-6: call convert_to_gl_lb unconditionally so v_conversion always receives a
    -- tuple structure (the helper returns one row even for NULL inputs); an unrated line
    -- yields (NULL, NULL) without leaving v_conversion unassigned.
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres, rate_per_acre, rate_unit,
      total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee, price_source
    ) VALUES (
      v_invoice_id, v_chem.product_id,
      -- U4<<< customer-supplied: keep the line (legal/application record) but at $0
      -- with a labeled description; force cost + price to 0. price_source='manual'
      -- pins the $0 (Codex R5 P1: a product-backed $0 line without it would be
      -- re-priced by tier when the unposted invoice is edited + re-saved). (#53/#54)
      CASE WHEN v_chem.customer_supplied THEN v_chem.product_name || ' (customer supplied)' ELSE v_chem.product_name END,
      1,
      v_chem.unit_size,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_price, 0) END,
      CASE WHEN v_chem.customer_supplied THEN 0 ELSE COALESCE(v_chem.chem_cost, 0) END,
      -- >>>U4
      v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value, v_conversion.converted_unit,
      v_chem.epa_registration, v_chem.product_form, false,
      CASE WHEN v_chem.customer_supplied THEN 'manual' ELSE NULL END
    );
  END LOOP;

  UPDATE invoices SET total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

  IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id) THEN
    SELECT EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL) INTO v_has_price_override;
    FOR v_share IN
      SELECT fbd.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct) END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE WHEN count(DISTINCT fbd.price_override_cents) = 1 AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents) ELSE NULL END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
          v_amount := ROUND(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct, v_share.share_acres, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;
    -- OVERNIGHT FIX (Run 2 cycle 2, finding #3 — penny-drift): reconcile the header to the share
    -- sum for BOTH the override AND the percentage-split path (was override-only). Independent
    -- per-customer ROUND(total_price_cents * pct/100) can drift ±1c on odd-cent splits, so without
    -- this the percentage-split header stayed at total_price_cents while invoice_shares summed a cent
    -- off — and get_customer_year_end_summary / get_detailed_statement_data read invoice_shares.amount_cents,
    -- so statements wouldn't tie. v_share_total is the exact sum of the shares; DELTA-8 then adds the
    -- per-acre fee to both shares and header, preserving the tie. The single-customer ELSE branch
    -- already inserts header = its one share, so it ties without this.
    UPDATE invoices SET total_amount_cents = v_share_total WHERE id = v_invoice_id;
  ELSE
    INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, COALESCE(v_job.total_price_cents, 0), true, 1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  -- DELTA-8 (G1 per-acre application fee, PER-CUSTOMER rate): now that invoice_shares exist,
  -- charge each billed customer the per-acre machine fee at that customer's own rate; add each
  -- customer's fee to their share, emit one is_application_fee line, fold into the header.
  IF v_job.application_service_id IS NOT NULL AND v_total_acres > 0 THEN
    FOR v_share IN
      SELECT id, customer_id, COALESCE(acres, 0) AS acres, price_per_acre_cents
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    LOOP
      -- A grower on a price_override (all-inclusive $/acre) does NOT also pay the per-acre
      -- machine fee, or they'd be double-charged (mirrors save_field_app_invoice).
      IF v_share.price_per_acre_cents IS NOT NULL THEN CONTINUE; END IF;
      v_fee := compute_application_service_fee(
                 v_job.application_service_id, v_share.customer_id, v_share.acres, v_job.season);
      v_fee_c  := COALESCE((v_fee->>'total_fee_cents')::bigint, 0);
      v_cost_c := COALESCE((v_fee->>'total_cost_cents')::bigint, 0);
      v_fee_total := v_fee_total + v_fee_c;
      v_fee_cost  := v_fee_cost  + v_cost_c;
      v_fee_acres := v_fee_acres + v_share.acres;
      IF v_fee_c <> 0 THEN
        UPDATE invoice_shares SET amount_cents = amount_cents + v_fee_c WHERE id = v_share.id;
      END IF;
    END LOOP;

    IF v_fee_total > 0 AND v_fee_acres > 0 THEN
      v_item_order := v_item_order + 1;
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, COALESCE(v_fee->>'service_name', 'Application'), v_fee_acres, 'acre',
        ROUND(v_fee_total / v_fee_acres)::bigint, v_fee_total,
        v_fee_cost, v_item_order, v_fee_acres,
        ROUND(v_fee_total / v_fee_acres)::bigint, 'acre',
        true, 'tier'
      );
      UPDATE invoices SET
        total_amount_cents = COALESCE(total_amount_cents, 0) + v_fee_total,
        total_cost_cents   = total_cost_cents + v_fee_cost
      WHERE id = v_invoice_id;
    END IF;
  END IF;
  -- END DELTA-8

  -- U8<<< (#99): resolve the commission split. New jobs carry a creation-time
  -- snapshot (quote-born: the quote's split via create_job_from_quote_section;
  -- direct: the customer default via trg_jobs_snapshot_commission_split), so this
  -- fallback only fires for PRE-U8 jobs. Order-channel parity (Codex R3 P1): a
  -- quote-born job uses the parent quote's split and ONLY that — convert_quote_to_order
  -- passes only v_quote.commission_split, so a NULL quote split pays no commission,
  -- never the customer default. A pre-U8 direct job uses the customer default, like
  -- a direct order. Codex R2 P2: the resolved fallback is PERSISTED onto the job in
  -- the same UPDATE that flips it to 'invoiced', so attribution locks at first use.
  v_commission_split := v_job.commission_split;
  IF v_commission_split IS NULL THEN
    IF v_job.quote_id IS NOT NULL THEN
      SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
    ELSE
      SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
    END IF;
  END IF;
  -- >>>U8

  UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_id,
    -- U8 (Codex R2 P2 + R4 P1): persist the resolution — even a nothing-anywhere
    -- result locks as the empty sentinel so re-invoices never re-read live sources.
    commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
  WHERE id = p_job_id;
  UPDATE application_records SET invoice_id = v_invoice_id WHERE source_type = 'job' AND source_id = p_job_id;

  -- DELTA-4: invoice was inserted as 'draft'; flip to 'unposted' now that items, shares and
  -- totals are final. draft -> unposted is allowed by _enforce_invoice_status_transition.
  UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id;

  -- U8<<< (#99): mint the application-channel commissions — chemical-line profit only.
  -- Mirror of the order channel (convert_quote_to_order → _insert_commissions_for_order).
  -- Profit basis: the chemical lines just written to THIS invoice. The per-acre machine
  -- fee (is_application_fee=true, product_id NULL) is excluded per the owner rule, and
  -- customer-supplied lines carry $0 price AND $0 cost so they contribute exactly 0.
  -- invoice_items money is bigint CENTS; commissions are numeric DOLLARS → /100.0.
  -- The helper no-ops on a NULL/splits-less split and validates a present one
  -- (COMMISSION_SPLIT_INVALID aborts, matching the order-conversion behavior).
  -- Pending amounts stay in sync with later unposted-invoice edits via the
  -- recompute in the item-rewrite path (Codex R2 P1), mirroring update_order_items.
  SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - COALESCE(ii.cost_cents, 0)), 0)
    INTO v_chem_profit_cents
  FROM invoice_items ii
  WHERE ii.invoice_id = v_invoice_id
    AND COALESCE(ii.is_application_fee, false) = false
    AND ii.product_id IS NOT NULL;

  PERFORM _insert_commissions_for_job(
    p_job_id, v_invoice_id, v_job.customer_id,
    v_chem_profit_cents::numeric / 100.0,
    v_commission_split,
    CURRENT_DATE
  );
  -- >>>U8

  -- DELTA-5: log to activity_feed (performed_by NOT NULL: COALESCE to auth.uid()).
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('job_invoiced',
    'Job ' || v_job.job_number || ' transferred to invoice ' || v_invoice_number,
    COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);

  -- OVERNIGHT FIX (finding #3): write the canonical 'invoice_created' financial_audit_log row
  -- the other six invoice creators write, so the append-only money ledger records creation
  -- provenance for job-built invoices too. Read the FINAL header total back (DELTA-8 may have
  -- adjusted it). Shape mirrors save_field_app_invoice's invoice_created row.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id, auth.uid(),
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'job_id', p_job_id,
      'customer_id', v_job.customer_id,
      'total_cents', (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id)
    ),
    (SELECT total_amount_cents FROM invoices WHERE id = v_invoice_id),
    'Invoice ' || v_invoice_number || ' created from job ' || v_job.job_number
  );

  v_result := jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ============================================================================
-- 2. void_invoice — group-aware job release (byte-identical except the two
--    job-release blocks; proven via reverse-apply md5 == faf972d55dc8fbec130a6f0987b494c3)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id uuid, p_void_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv record; v_alloc record; v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0; v_prepay_app record; v_actor_role text;
  v_allocation_set_ids uuid[]; v_commissions_cancelled integer := 0; v_existing jsonb;
  v_job record;  -- U6 #65: job-release locals
BEGIN
  SELECT role INTO v_actor_role FROM profiles WHERE id = auth.uid();
  -- U6 (rls-review M1): IS DISTINCT FROM — the live `!= 'admin'` was NULL-unsafe
  -- (a caller with no profile row yields NULL != 'admin' = NULL → gate silently
  -- passed; downstream NOT NULLs caught it, but the gate itself should hold).
  IF v_actor_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only admin users can void invoices'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  IF v_inv.status = 'voided' THEN RAISE EXCEPTION 'Invoice already voided'; END IF;
  IF v_inv.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot void a cancelled invoice'; END IF;

  -- draft/unposted invoices were never posted: no allocations/prepay/commissions to reverse,
  -- and the status trigger only allows →voided from posted/overdue. Route to 'cancelled'
  -- (draft→cancelled / unposted→cancelled are allowed transitions) and return.
  IF v_inv.status IN ('draft', 'unposted') THEN
    UPDATE invoices SET status = 'cancelled', void_reason = p_void_reason, updated_at = now()
    WHERE id = p_invoice_id;

    -- U6 #65: release a job that was transferred into THIS (now cancelled) field-app
    -- invoice so it is no longer stranded at terminal 'invoiced'. See header note for
    -- the admin-override-GUC rationale. Only touch the job if it still owns this invoice.
    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
      IF FOUND AND v_job.status = 'invoiced' THEN
        -- U7 group-aware release: reopen the job only when the LAST live group member is
        -- gone; if THIS was the anchor but siblings remain, re-point job + app records.
        IF EXISTS (SELECT 1 FROM invoices o
                   WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                     AND o.invoice_type = 'field_application'
                     AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
          IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
            UPDATE application_records SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
            SET LOCAL app.admin_override = 'true';
            UPDATE jobs SET invoice_id = (
              SELECT o.id FROM invoices o
               WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                 AND o.invoice_type = 'field_application'
                 AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
               ORDER BY o.created_at, o.id LIMIT 1)
              WHERE id = v_inv.job_id;
            RESET app.admin_override;
          END IF;
        ELSE
          UPDATE application_records SET invoice_id = NULL
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      END IF;
    END IF;

    -- U8<<< (#99): job-invoice commissions are created AT invoicing (unlike the order
    -- channel, whose commissions predate the invoice), so a job invoice cancelled while
    -- still draft/unposted already has live pending commissions — cancel them here.
    -- Codex R1 P1: scope by commissions.invoice_id (the exact generation THIS invoice
    -- minted), not by job-level liveness — job_id alone cannot tell an old generation
    -- from the current one across a void→re-invoice cycle.
    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      -- Codex R6 P1: order-channel payout protections, mirrored. (a) Pending rows in
      -- an ACTIVE payout batch block the reversal (void the commission payment first
      -- — its void resets them to pending here, or cancels them if this invoice is
      -- already dead), exactly like ORDER_HAS_BATCHED_COMMISSIONS on cancel_order.
      -- (b) Rows already PAID stay on the ledger, but every admin is notified for
      -- manual review, because the released job can be re-invoiced and re-earn.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice cancelled — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was cancelled but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', p_invoice_id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
    -- >>>U8

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
    VALUES ('invoice_cancelled', 'invoice', p_invoice_id, v_actor_role,
      jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents),
      jsonb_build_object('status', 'cancelled', 'void_reason', p_void_reason, 'commissions_cancelled', v_commissions_cancelled),
      0,
      'Cancelled ' || v_inv.invoice_number || ' (was ' || v_inv.status || ') — ' || p_void_reason);

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_cancelled',
      'Cancelled invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
      auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
        'success', true, 'invoice_id', p_invoice_id, 'status', 'cancelled',
        'allocations_reversed_cents', 0, 'prepay_restored_cents', 0, 'commissions_cancelled', v_commissions_cancelled));
    END IF;
    RETURN;
  END IF;

  IF v_inv.status = 'posted' THEN PERFORM check_period_open(v_inv.invoice_date); END IF;

  SELECT ARRAY(SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
    WHERE invoice_id = p_invoice_id AND allocation_set_id IS NOT NULL) INTO v_allocation_set_ids;

  FOR v_alloc IN SELECT ila.id, ila.amount_cents, ila.allocation_set_id FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.amount_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  IF v_total_allocations_reversed > 0 AND array_length(v_allocation_set_ids, 1) > 0 THEN
    UPDATE allocation_sets SET total_allocated_cents = (SELECT COALESCE(SUM(amount_cents), 0)
      FROM invoice_line_allocations WHERE allocation_set_id = allocation_sets.id),
      updated_at = now() WHERE id = ANY(v_allocation_set_ids);
  END IF;

  FOR v_prepay_app IN SELECT pa.id, pa.applied_amount_cents, pa.prepay_credit_id FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.applied_amount_cents;
    UPDATE prepay_credits SET balance_cents = balance_cents + v_prepay_app.applied_amount_cents,
      updated_at = now() WHERE id = v_prepay_app.prepay_credit_id;
    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now() WHERE id = v_inv.customer_id;
  END IF;

  UPDATE invoices SET status = 'voided', voided_by = auth.uid(), voided_at = now(),
    void_reason = p_void_reason, total_amount_cents = 0, paid_amount_cents = 0,
    prepay_applied_cents = 0, write_off_cents = 0, updated_at = now()
  WHERE id = p_invoice_id;

  -- U6 #65: release a job that was transferred into THIS (now voided) field-app
  -- invoice so it is no longer stranded at terminal 'invoiced'. See header note for
  -- the admin-override-GUC rationale. Only touch the job if it still owns this invoice.
  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
    IF FOUND AND v_job.status = 'invoiced' THEN
      -- U7 group-aware release: reopen the job only when the LAST live group member is
      -- gone; if THIS was the anchor but siblings remain, re-point job + app records.
      IF EXISTS (SELECT 1 FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
        IF v_job.invoice_id IS NOT DISTINCT FROM p_invoice_id THEN
          UPDATE application_records SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
          SET LOCAL app.admin_override = 'true';
          UPDATE jobs SET invoice_id = (
            SELECT o.id FROM invoices o
             WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
               AND o.invoice_type = 'field_application'
               AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
             ORDER BY o.created_at, o.id LIMIT 1)
            WHERE id = v_inv.job_id;
          RESET app.admin_override;
        END IF;
      ELSE
        UPDATE application_records SET invoice_id = NULL
          WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;
        SET LOCAL app.admin_override = 'true';
        UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
        RESET app.admin_override;
      END IF;
    END IF;
  END IF;

  IF v_inv.order_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE order_id = v_inv.order_id
        AND id != p_invoice_id AND status NOT IN ('voided', 'cancelled') AND deleted_at IS NULL) THEN
      UPDATE commissions SET status = 'cancelled' WHERE order_id = v_inv.order_id AND status = 'pending';
      GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
    END IF;
  END IF;

  -- U8<<< (#99): application-channel mirror of the order-keyed reversal above — a
  -- voided job invoice cancels the pending commissions THIS invoice minted. A
  -- field_application invoice has order_id NULL, so the block above never fires for
  -- it; only one of the two blocks can run for any given invoice. Codex R1 P1:
  -- scoped by commissions.invoice_id (generation-precise), not job-level liveness.
  IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
    -- Codex R6 P1: same payout protections as the early-cancel path above.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
        AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
    ) THEN
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      SELECT p.id, 'Job invoice voided — commissions already paid',
        'Invoice ' || v_inv.invoice_number || ' was voided but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
        'commission_review', 'invoice', p_invoice_id
      FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
    UPDATE commissions SET status = 'cancelled', commission_amount = 0
      WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
    GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  END IF;
  -- >>>U8

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_voided', 'invoice', p_invoice_id, v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'paid_amount_cents', v_inv.paid_amount_cents, 'prepay_applied_cents', v_inv.prepay_applied_cents, 'write_off_cents', v_inv.write_off_cents),
    jsonb_build_object('status', 'voided', 'void_reason', p_void_reason, 'allocations_reversed_cents', v_total_allocations_reversed, 'prepay_restored_cents', v_total_prepay_restored, 'commissions_cancelled', v_commissions_cancelled),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0 THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.' ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0 THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.' ELSE '' END ||
      CASE WHEN v_commissions_cancelled > 0 THEN ' Cancelled ' || v_commissions_cancelled || ' pending commission(s).' ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);

  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 OR v_commissions_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.' ||
        CASE WHEN v_commissions_cancelled > 0 THEN ' ' || v_commissions_cancelled || ' pending commission(s) cancelled.' ELSE '' END,
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_invoice', jsonb_build_object(
      'success', true, 'invoice_id', p_invoice_id,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored,
      'commissions_cancelled', v_commissions_cancelled));
  END IF;
END;
$function$;

-- ============================================================================
-- 3. delete_invoices — group-aware job release (byte-identical except the one
--    job-release block; proven via reverse-apply md5 == f3eca9ffdc4bf5cc34888f89c55683d5)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_invoices(p_invoice_ids uuid[], p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv        record;
  v_count      integer := 0;
  v_actor      uuid;
  v_actor_role text;
  v_existing   jsonb;
BEGIN
  PERFORM require_admin();  -- admin-only: matches invoices_update/invoices_delete RLS (is_admin())
  PERFORM check_rate_limit(auth.uid(), 'delete_invoices', 5, 60);
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_invoices');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'deleted_count')::integer; END IF;
  END IF;

  IF array_length(p_invoice_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;

  FOR v_inv IN
    SELECT id, status, invoice_number, total_amount_cents, blend_ticket_id,
           invoice_type, job_id  -- U8 (Codex R3 P1): job-born invoice cleanup below
    FROM invoices
    WHERE id = ANY(p_invoice_ids) AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    -- Only draft / unposted / voided invoices are soft-deletable (matches the UI gates).
    IF v_inv.status NOT IN ('draft', 'unposted', 'voided') THEN CONTINUE; END IF;

    UPDATE invoices SET deleted_at = now() WHERE id = v_inv.id;

    -- Blend-ticket orphan guard (overnight bug-hunt MED, 20260620): a soft-delete sets
    -- deleted_at only, which does NOT fire the status-change reset trigger, so a deleted
    -- draft blend invoice would strand the ticket at 'billed' forever (un-rebillable).
    -- When this was the last live invoice for the ticket, reset it (same predicate the
    -- over-reset trigger uses; v_inv was just soft-deleted so it is excluded below).
    IF v_inv.blend_ticket_id IS NOT NULL THEN
      UPDATE blend_tickets SET payment_status = 'unbilled', updated_at = now()
      WHERE id = v_inv.blend_ticket_id AND payment_status = 'billed'
        AND NOT EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.blend_ticket_id = v_inv.blend_ticket_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND i.deleted_at IS NULL
        );
    END IF;

    -- U8<<< (Codex R3 P1): the same orphan class as the blend-ticket guard above,
    -- for the application channel. A job-born field_application invoice minted
    -- pending commissions at transfer time and owns its job's 'invoiced' status;
    -- a soft-delete fires no trigger, so without this block the commissions stay
    -- payable for a deleted invoice and the job strands at 'invoiced' forever
    -- (the exact #65 shape void_invoice fixes — mirrored here with the same guards:
    -- generation-precise commission cancel, and release the job only if it still
    -- owns THIS invoice). Deleting an already-voided job invoice no-ops both parts
    -- (void_invoice already cancelled the rows and released the job).
    IF v_inv.invoice_type = 'field_application' AND v_inv.job_id IS NOT NULL THEN
      -- Codex R6 P1: order-channel payout protections (batched-pending blocks the
      -- whole delete batch — transactional, nothing partially deleted; paid rows
      -- stay + admins notified).
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.job_id = v_inv.job_id AND c.invoice_id = v_inv.id
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: invoice % has pending commissions in an active payout batch — void that commission payment first', v_inv.invoice_number;
      END IF;
      IF EXISTS (
        SELECT 1 FROM commissions
        WHERE job_id = v_inv.job_id AND invoice_id = v_inv.id AND status = 'paid'
      ) THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Job invoice deleted — commissions already paid',
          'Invoice ' || v_inv.invoice_number || ' was deleted but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
          'commission_review', 'invoice', v_inv.id
        FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
      UPDATE commissions SET status = 'cancelled', commission_amount = 0
        WHERE job_id = v_inv.job_id AND invoice_id = v_inv.id AND status = 'pending';

      DECLARE
        v_job record;
      BEGIN
        SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
        IF FOUND AND v_job.status = 'invoiced' THEN
          -- U7 group-aware release: reopen the job only when the LAST live group member is
          -- gone. If THIS was the anchor but siblings remain, re-point the job + its
          -- application records to a surviving member (invoice_id is protected on a billed
          -- job -> admin_override). Deleting a non-anchor member is a no-op here.
          IF EXISTS (SELECT 1 FROM invoices o
                     WHERE o.job_id = v_inv.job_id AND o.id <> v_inv.id
                       AND o.invoice_type = 'field_application'
                       AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL) THEN
            IF v_job.invoice_id IS NOT DISTINCT FROM v_inv.id THEN
              UPDATE application_records SET invoice_id = (
                SELECT o.id FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> v_inv.id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
                 ORDER BY o.created_at, o.id LIMIT 1)
                WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = v_inv.id;
              SET LOCAL app.admin_override = 'true';
              UPDATE jobs SET invoice_id = (
                SELECT o.id FROM invoices o
                 WHERE o.job_id = v_inv.job_id AND o.id <> v_inv.id
                   AND o.invoice_type = 'field_application'
                   AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
                 ORDER BY o.created_at, o.id LIMIT 1)
                WHERE id = v_inv.job_id;
              RESET app.admin_override;
            END IF;
          ELSE
            UPDATE application_records SET invoice_id = NULL
              WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = v_inv.id;
            SET LOCAL app.admin_override = 'true';
            UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
            RESET app.admin_override;
          END IF;
        END IF;
      END;
    END IF;
    -- >>>U8

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      old_values, new_values, total_impact_cents, description
    ) VALUES (
      'invoice_deleted', 'invoice', v_inv.id, v_actor_role,
      jsonb_build_object(
        'status', v_inv.status,
        'invoice_number', v_inv.invoice_number,
        'total_amount_cents', v_inv.total_amount_cents
      ),
      jsonb_build_object('deleted_at', now()),
      0,
      'Soft-deleted invoice ' || v_inv.invoice_number || ' (status ' || v_inv.status || ')'
    );

    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_invoices', jsonb_build_object('deleted_count', v_count));
  END IF;

  RETURN v_count;
END;
$function$;

-- ============================================================================
-- 4. transfer_invoice_to_job — refuse member-by-member reverse of a group
--    (byte-identical except one inserted guard; proven via reverse-apply md5
--     == 1d1d42e953b3f2ee067109647e63d05f)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.transfer_invoice_to_job(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inv RECORD;
  v_job RECORD;
  v_existing jsonb;
  v_result jsonb;
  v_actor_role text;
  v_commissions_cancelled integer := 0;  -- U8 (#99)
BEGIN
  -- Role gate (active admin/sales_rep) on the authenticated user.
  SELECT role INTO v_actor_role FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  -- Strict actor: the recorded performer must be the authenticated user
  -- (mirrors transfer_job_to_invoice / complete_job / save_field_app_invoice).
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_invoice_to_job');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;

  IF v_inv.invoice_type IS DISTINCT FROM 'field_application' THEN
    RAISE EXCEPTION 'Only a field application invoice can be transferred back to a job';
  END IF;
  IF v_inv.job_id IS NULL THEN
    RAISE EXCEPTION 'This invoice was not created from a job, so it cannot be returned to scheduling';
  END IF;
  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Only a draft or unposted invoice can be returned to scheduling (status: %). Void the invoice first.', v_inv.status;
  END IF;

  -- Lock the source job and confirm it still owns this invoice (no race / double reverse).
  SELECT * INTO v_job FROM jobs WHERE id = v_inv.job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source job not found: %', v_inv.job_id; END IF;
  IF v_job.status <> 'invoiced' THEN
    RAISE EXCEPTION 'Source job % is no longer invoiced (status: %); cannot return this invoice to scheduling', v_job.job_number, v_job.status;
  END IF;
  IF v_job.invoice_id IS DISTINCT FROM p_invoice_id THEN
    RAISE EXCEPTION 'Source job % no longer points at this invoice; refusing to reverse', v_job.job_number;
  END IF;

  -- U7: a multi-owner split cannot be reversed member-by-member here (it would release the
  -- job while sibling owner-invoices stay live). Direct the office to void the owner
  -- invoices instead -- voiding the LAST live member reopens the job (group-aware void).
  IF v_inv.invoice_group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM invoices o
    WHERE o.job_id = v_inv.job_id AND o.id <> p_invoice_id
      AND o.invoice_type = 'field_application'
      AND o.status NOT IN ('voided', 'cancelled') AND o.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'JOB_BILLED_AS_GROUP: job % was invoiced as a multi-owner split; return it to scheduling by voiding each owner invoice (voiding the last one reopens the job).', v_job.job_number;
  END IF;

  -- Detach the as-applied legal records from this invoice (inverse of the forward
  -- UPDATE application_records SET invoice_id = v_invoice_id ...).
  UPDATE application_records SET invoice_id = NULL
    WHERE source_type = 'job' AND source_id = v_inv.job_id AND invoice_id = p_invoice_id;

  -- Tear down the invoice contents the forward transfer built.
  DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
  DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;

  -- Cancel the invoice (draft|unposted -> cancelled is an allowed transition; no override).
  -- total/paid/prepay are already 0 on a never-posted invoice; zero them defensively.
  -- total_cost_cents (the internal COGS header) is ALSO zeroed here (P3 remediation) so a
  -- cancelled, line-less invoice does not keep a stale forward cost total on its PDF.
  UPDATE invoices SET
    status = 'cancelled',
    void_reason = 'Returned to scheduling (job ' || v_job.job_number || ')',
    total_amount_cents = 0,
    paid_amount_cents = 0,
    prepay_applied_cents = 0,
    total_cost_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- U8<<< (#99): the forward transfer minted this invoice's pending commissions —
  -- reverse them with it (a re-transfer creates a fresh pending set). Codex R1 P1:
  -- scoped by commissions.invoice_id so only THIS invoice's generation is touched.
  -- Codex R6 P1: order-channel payout protections (batched-pending blocks; paid
  -- rows stay + admins notified).
  IF EXISTS (
    SELECT 1 FROM commissions c
    JOIN commission_payment_items cpi ON cpi.commission_id = c.id
    JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
    WHERE c.job_id = v_inv.job_id AND c.invoice_id = p_invoice_id
      AND c.status = 'pending' AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this job invoice''s pending commissions are in an active payout batch — void that commission payment first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commissions
    WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'paid'
  ) THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id, 'Job invoice returned to scheduling — commissions already paid',
      'Invoice ' || v_inv.invoice_number || ' was returned to scheduling but its commissions were already paid out. Manual review needed before the job is re-invoiced.',
      'commission_review', 'invoice', p_invoice_id
    FROM profiles p WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
  UPDATE commissions SET status = 'cancelled', commission_amount = 0
    WHERE job_id = v_inv.job_id AND invoice_id = p_invoice_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;
  -- >>>U8

  -- Return the job to 'completed' so it is editable / re-transferable. The reverse
  -- invoiced -> completed transition is only sanctioned via the admin-override GUC
  -- (SET LOCAL = transaction-scoped); RESET immediately after the single UPDATE.
  SET LOCAL app.admin_override = 'true';
  UPDATE jobs SET status = 'completed', invoice_id = NULL WHERE id = v_inv.job_id;
  RESET app.admin_override;

  -- Append-only money ledger: record the cancellation (mirrors void_invoice's
  -- draft/unposted -> cancelled audit row), with the source-job provenance.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_cancelled', 'invoice', p_invoice_id, auth.uid(), v_actor_role,
    jsonb_build_object('status', v_inv.status, 'total_cents', v_inv.total_amount_cents, 'job_id', v_inv.job_id),
    jsonb_build_object('status', 'cancelled', 'reason', 'transfer_to_scheduling', 'job_id', v_inv.job_id, 'commissions_cancelled', v_commissions_cancelled),
    -1 * COALESCE(v_inv.total_amount_cents, 0),
    'Invoice ' || v_inv.invoice_number || ' returned to scheduling (job ' || v_job.job_number || ')'
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_transferred_to_scheduling',
    'Invoice ' || v_inv.invoice_number || ' returned to scheduling — job ' || v_job.job_number || ' reopened',
    COALESCE(p_performed_by, auth.uid()), 'job', v_inv.job_id, v_inv.customer_id);

  v_result := jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'job_id', v_inv.job_id,
    'job_number', v_job.job_number,
    'invoice_status', 'cancelled',
    'job_status', 'completed',
    'commissions_cancelled', v_commissions_cancelled
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_invoice_to_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

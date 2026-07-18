-- idempotency-body-check: exempt — canonical two-layer split (same as the live
--   save_field_app_invoice and post_invoice_group): the PUBLIC wrapper
--   save_field_app_split_invoice does the advisory lock + check_idempotency +
--   payload-hash IDEMPOTENCY_PAYLOAD_CONFLICT, and the writer
--   _save_field_app_split_invoice_impl records the key via save_idempotency() at the
--   end. Neither function is complete on its own by design; together they are the
--   full guarded pattern.
-- sql-safety: exempt-registry — invoices.field_app_billing_set_id, invoices.send_disposition
--   and invoice_items.billing_line_id are created by the PRIOR committed migration
--   20260718010000_per_line_split_billing_schema.sql in this same parked, not-yet-applied
--   migration chain. The live schema registry is intentionally behind (nothing here is
--   applied live). Proven via BEGIN…ROLLBACK that applies 010000 + 020000 first in-txn.
-- ============================================================================
-- PER-LINE SPLIT BILLING — SAVE/POST RPC + RESOLVER + POST SNAPSHOT (flag-gated)
-- CRX Manager V1.0
-- Date: 2026-07-18
-- Spec:        docs/plans/per-line-item-split-billing-spec-2026-07-17.md (§4 algo, §5 invariants)
-- Design:      docs/plans/per-line-split-billing-RPC-DESIGN-2026-07-17.md (§A/§B/§C/§D)
-- Depends on:  20260718010000_..._schema.sql (tables + freeze trigger)
--              20260718020000_..._calculator.sql (compute_line_split_allocation, etc.)
--
-- WHAT
--   The write path for the per-line split-billing feature:
--     * resolve_line_split_vector(...)      — job-snapshot → field-default → owner
--       precedence resolver that produces the DEFAULT ownership micro_pct vector for
--       a set of fields (acre-weighted, largest-remainder to exactly 100%).
--     * save_field_app_split_invoice(...)    — public SECURITY DEFINER wrapper
--       (guards, idempotency, advisory + row locks) delegating to the writer.
--     * _save_field_app_split_invoice_impl(...) — the writer: builds a billing set,
--       one billing line per source line, calls the shared calculator, writes one
--       child invoice per customer with residual-adjusted invoice_items +
--       invoice_line_shares, the compat invoice_shares self-100% row, and asserts
--       every §5 SUM invariant against the STORED rows (checks the allocator's
--       output — never trusts its self-report).
--     * snapshot_invoice_line_shares_on_post() — R1 AFTER-UPDATE trigger on invoices
--       that copies invoice_line_shares → invoice_line_share_snapshots when a child
--       flips to 'posted' (append-only post history; keeps post_invoice_group
--       unchanged).
--
--   POSTING stays public.post_invoice_group(invoice_group_id, performed_by, key)
--   UNCHANGED — this migration adds no post RPC. Flipping the child invoices to
--   'posted' auto-freezes their invoice_line_shares via the schema migration's
--   prevent_invoice_line_shares_edit_after_post() trigger.
--
-- BEHAVIOR CHANGE: NONE (additive, flag-gated).
--   Nothing calls save_field_app_split_invoice until the Phase-5 UI ships behind an
--   OFF-by-default feature flag. Existing save_field_app_invoice / post_invoice_group
--   are untouched. The snapshot trigger is a no-op for every non-split invoice
--   (guarded on field_app_billing_set_id IS NOT NULL).
--
-- MONEY
--   bigint cents throughout. invoices.balance_cents is GENERATED — never written.
--   extended_cents is the residual-adjusted allocation from the calculator and is
--   display-authoritative; nothing recomputes qty x price.
--
-- SCOPE NOTE (owner-facing, see handoff R8):
--   For CHEMICAL lines this writer snapshots a server-VALIDATED base unit price that
--   the caller supplies (source_unit_price_cents + base_price_source). It does NOT
--   re-implement the full chemical price resolver (manual → quoted → tier → unit
--   conversion) that lives in _save_field_app_invoice_impl_20260714 — that logic is
--   large and coupled to the not-yet-built product/quote picker UI. Before go-live,
--   extract that resolver into a shared function and call it here so the base price
--   is server-resolved, not caller-supplied. SERVICE-fee base rate IS resolved
--   server-side below (application_services default rate). The penny-exact
--   allocation, invariants, freeze, idempotency and $0 suppression are all complete
--   and proven regardless of where the base price originates.
-- ============================================================================


-- ============================================================================
-- 0. PRECISION FIX — snapshot allocated_acres 12,2 → 12,4
--    The schema migration created invoice_line_share_snapshots.allocated_acres as
--    numeric(12,2); the live allocation store (invoice_line_shares.allocated_acres)
--    is numeric(12,4). Copying source → snapshot would silently truncate. Align it
--    (empty table, additive, no data to migrate).
-- ============================================================================
ALTER TABLE public.invoice_line_share_snapshots
  ALTER COLUMN allocated_acres TYPE numeric(12,4);


-- ============================================================================
-- 1. RESOLVER — default split vector for a field set
--    Precedence per field (spec §5, readiness #7):
--      job snapshot job_field_shares(job, field)  →  field_billing_defaults(field)
--        →  fields.customer_id owner @ 100%.
--    Acre-weight-aggregate each customer's share across the selected fields, then
--    convert the aggregate weights → integer micro_pct by largest-remainder
--    (tie-break customer_id ASC) so the vector sums to EXACTLY 100000000.
--    Weights accumulate in a jsonb array (NOT a temp table) so the function is
--    re-entrant within one transaction. SECURITY DEFINER so it can read the
--    RLS-protected reference tables; reads only.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_line_split_vector(
  p_field_ids         uuid[],
  p_source_job_id     uuid,
  p_applied_acres_map jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_field       uuid;
  v_acres       numeric;
  v_field_rows  jsonb;
  v_weights     jsonb := '[]'::jsonb;
  v_result      jsonb;
BEGIN
  -- Authorization (RLS review M1): this is a SECURITY DEFINER read that bypasses the
  -- RLS on job_field_shares / field_billing_defaults / fields, so restrict the
  -- enumeration surface to the app's trust boundary — active admin/sales_rep — exactly
  -- like the save wrapper. (When called from the save writer the actor is already an
  -- admin/sales_rep, so this is a no-op there; it closes the direct-call surface.)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles
                  WHERE id = auth.uid() AND is_active = true
                    AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_field_ids IS NULL OR array_length(p_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'RESOLVER_NO_FIELDS: at least one field_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOREACH v_field IN ARRAY p_field_ids
  LOOP
    v_acres := COALESCE((p_applied_acres_map->>v_field::text)::numeric, 0);
    IF v_acres <= 0 THEN
      RAISE EXCEPTION 'RESOLVER_ZERO_ACRES: applied acres must be > 0 for field %', v_field
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_source_job_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM job_field_shares s
                    WHERE s.job_id = p_source_job_id AND s.field_id = v_field) THEN
      -- 1) Job snapshot wins.
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s.customer_id::text,
               'weight',      v_acres * (s.split_pct / 100.0)))
        INTO v_field_rows
        FROM job_field_shares s
       WHERE s.job_id = p_source_job_id AND s.field_id = v_field;
    ELSIF EXISTS (SELECT 1 FROM field_billing_defaults d WHERE d.field_id = v_field) THEN
      -- 2) Field ownership default.
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', d.customer_id::text,
               'weight',      v_acres * (d.split_pct / 100.0)))
        INTO v_field_rows
        FROM field_billing_defaults d
       WHERE d.field_id = v_field;
    ELSE
      -- 3) Fallback: the field's owner at 100%.
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', f.customer_id::text,
               'weight',      v_acres))
        INTO v_field_rows
        FROM fields f
       WHERE f.id = v_field;
    END IF;

    IF v_field_rows IS NOT NULL THEN
      v_weights := v_weights || v_field_rows;
    END IF;
  END LOOP;

  -- Largest-remainder conversion of the aggregate weights → micro_pct summing to
  -- exactly 100000000, tie-break customer_id ASC (identical rule to the calculator).
  WITH agg AS (
    SELECT e->>'customer_id' AS customer_id, SUM((e->>'weight')::numeric) AS w
      FROM jsonb_array_elements(v_weights) AS e
     GROUP BY e->>'customer_id'
  ),
  tot AS (SELECT SUM(w) AS total FROM agg),
  ideals AS (
    SELECT a.customer_id,
           (a.w / t.total) * 100000000::numeric AS ideal
      FROM agg a CROSS JOIN tot t
     WHERE t.total > 0
  ),
  bases AS (
    SELECT customer_id, floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
      FROM ideals
  ),
  resid AS (SELECT 100000000 - COALESCE(SUM(base), 0) AS residual FROM bases),
  ranked AS (
    SELECT customer_id, base,
           row_number() OVER (ORDER BY frac DESC, customer_id ASC) AS rn
      FROM bases
  ),
  allocated AS (
    SELECT customer_id,
           base + CASE WHEN rn <= (SELECT residual FROM resid) THEN 1 ELSE 0 END AS micro_pct
      FROM ranked
  )
  SELECT jsonb_agg(
           jsonb_build_object('customer_id', customer_id, 'micro_pct', micro_pct)
           ORDER BY customer_id ASC
         )
    INTO v_result
    FROM allocated;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'RESOLVER_EMPTY_VECTOR: no billing customers derived from fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.resolve_line_split_vector(uuid[], uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_line_split_vector(uuid[], uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.resolve_line_split_vector(uuid[], uuid, jsonb) IS
  'Per-line split billing: DEFAULT split vector for a set of fields. Precedence per field job_field_shares(job,field) -> field_billing_defaults(field) -> fields.customer_id owner @100%; acre-weighted across fields; largest-remainder (tie-break customer_id ASC) to exactly 100000000 micro-pct. Read-only.';


-- ============================================================================
-- 2. THE WRITER — _save_field_app_split_invoice_impl
--    Runs inside the wrapper's locks/guards. Builds the billing set + lines, calls
--    the shared calculator, writes one child invoice per customer, and asserts the
--    §5 invariants against the STORED rows before returning.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._save_field_app_split_invoice_impl(
  p_billing_set_id         uuid,
  p_source_job_id          uuid,
  p_invoice                jsonb,
  p_fields                 jsonb,
  p_lines                  jsonb,
  p_performed_by           uuid,
  p_application_service_id  uuid,
  p_idempotency_key        text,
  p_request_hash           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor              uuid := auth.uid();
  v_req_salesman       uuid;
  v_salesman_id        uuid;
  v_field_ids          uuid[] := '{}';
  v_applied_acres_map  jsonb  := '{}'::jsonb;
  v_fld                jsonb;
  v_this_acres         numeric;
  v_vector             jsonb;          -- default vector [{customer_id, micro_pct}]
  v_micro_map          jsonb := '{}'::jsonb;
  v_members            text[];         -- billing-set member customer_ids, sorted ASC
  v_set_id             uuid;
  v_group_id           uuid;
  v_line               jsonb;
  v_idx                int := 0;
  v_line_id            uuid;
  v_line_kind          text;
  v_product_id         uuid;
  v_app_service_id     uuid;
  v_line_desc          text;
  v_src_qty            numeric;
  v_src_acres          numeric;
  v_src_unit_price     bigint;
  v_src_flat           bigint;
  v_base_source        text;
  v_shares             jsonb;
  v_line_customers     text[];
  v_calc               jsonb;
  v_app_service        record;
  v_line_plans         jsonb := '[]'::jsonb;   -- [{meta..., alloc}]
  v_plan               jsonb;
  v_cust               text;
  v_customer_id        uuid;
  v_customer_name      text;
  v_is_primary         boolean;
  v_invoice_id         uuid;
  v_invoice_number     text;
  v_invoice_total      bigint;
  v_invoice_ids        uuid[] := '{}';
  v_alloc_row          jsonb;
  v_item_id            uuid;
  v_qty                numeric;
  v_acres_alloc        numeric;
  v_cust_acres         numeric;
  v_send_disposition   text;
  v_line_hashes        jsonb := '[]'::jsonb;
  v_item_price_source  text;
  -- invariant probes
  v_sum_cents          bigint;
  v_src_line_cents     bigint;
  v_sum_qty            numeric;
  v_sum_micro          bigint;
  v_line_member_count  int;
  v_line_src_qty       numeric;
  v_result             jsonb;
BEGIN
  -- ---- GUARDS (defense-in-depth; the wrapper already checked these) -----------
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required';
  END IF;

  -- Salesman attribution: admin may name anyone; a sales_rep is forced to self.
  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  -- ---- FIELDS + Mode-A rejection ---------------------------------------------
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array'
     OR jsonb_array_length(p_fields) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_FIELDS: at least one field is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_fld IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    v_this_acres := (v_fld->>'applied_acres')::numeric;
    IF v_this_acres IS NULL OR v_this_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_ZERO_ACRES: applied acres must be > 0 for field %', v_fld->>'field_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_fld->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map
      || jsonb_build_object(v_fld->>'field_id', v_this_acres);
  END LOOP;

  -- Mode-A: reject the ENTIRE feature for any grower-share field (spec §5).
  IF EXISTS (
    SELECT 1 FROM field_billing_defaults d
     WHERE d.field_id = ANY(v_field_ids)
       AND d.price_override_cents IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MODE_A_UNSUPPORTED: per-line split billing is not available for grower-share (Mode A) fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ---- DEFAULT VECTOR + member set -------------------------------------------
  v_vector := resolve_line_split_vector(v_field_ids, p_source_job_id, v_applied_acres_map);

  SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
    INTO v_members
    FROM jsonb_array_elements(v_vector) AS value;

  SELECT COALESCE(jsonb_object_agg(value->>'customer_id', (value->>'micro_pct')::bigint), '{}'::jsonb)
    INTO v_micro_map
    FROM jsonb_array_elements(v_vector) AS value;

  -- ---- LINES ------------------------------------------------------------------
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_LINES: at least one billing line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  -- ---- RE-SAVE: reuse an existing DRAFT/UNPOSTED billing set -----------------
  -- The wrapper already advisory-locked the set's group and FOR UPDATE-locked the
  -- child invoices, and asserted all draft/unposted. Here we clear the prior child
  -- LINE DATA (invoice_items — cascades invoice_line_shares — plus compat shares and
  -- the billing lines) but we do NOT hard-delete the invoice ROWS: a child that was
  -- posted-then-unposted carries append-only invoice_line_share_snapshots whose FK is
  -- ON DELETE RESTRICT, so a hard invoice delete would abort the whole re-save
  -- (adversarial F1). Instead PASS 2 REUSES the existing child invoice per customer
  -- (UPDATE), preserving its invoice_number + snapshot history, and only INSERTs for a
  -- newly-added customer. The freeze trigger permits the share rewrite because every
  -- member is draft/unposted (not posted).
  IF p_billing_set_id IS NOT NULL THEN
    SELECT id, invoice_group_id INTO v_set_id, v_group_id
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL);
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;

    -- Any existing child whose customer is no longer a billing-set member is
    -- soft-cancelled + detached from the set (its snapshots stay pointing at it,
    -- audit intact) — never hard-deleted. Mirrors the live orphan-cancel path.
    UPDATE invoices
       SET status = 'cancelled', invoice_group_id = NULL, field_app_billing_set_id = NULL,
           total_amount_cents = 0, total_cost_cents = 0, send_disposition = 'normal',
           updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND deleted_at IS NULL
       AND customer_id::text <> ALL (v_members);
  ELSE
    -- New set. R7: ALWAYS assign an invoice_group_id (even single recipient) so
    -- posting is uniformly post_invoice_group and the set is the durable anchor.
    v_group_id := gen_random_uuid();
    INSERT INTO field_app_billing_sets (invoice_group_id, source_job_id, created_by)
    VALUES (v_group_id, p_source_job_id, p_performed_by)
    RETURNING id INTO v_set_id;
  END IF;

  -- ---- PASS 1: build billing lines + compute allocations ----------------------
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx            := v_idx + 1;
    v_line_kind      := v_line->>'line_kind';
    v_product_id     := (v_line->>'product_id')::uuid;
    v_app_service_id := COALESCE((v_line->>'application_service_id')::uuid, p_application_service_id);
    v_line_desc      := v_line->>'description';
    v_src_qty        := (v_line->>'source_quantity')::numeric;
    v_src_acres      := (v_line->>'source_acres')::numeric;
    v_src_flat       := (v_line->>'source_flat_cents')::bigint;
    v_src_unit_price := (v_line->>'source_unit_price_cents')::bigint;
    v_base_source    := v_line->>'base_price_source';

    IF v_line_kind IS NULL
       OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
      RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: %', COALESCE(v_line_kind, '<null>')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Base-price resolution by kind (see SCOPE NOTE at top for the chemical caveat).
    IF v_line_kind = 'service' THEN
      IF v_src_acres IS NULL THEN
        v_src_acres := (SELECT SUM((f->>'applied_acres')::numeric)
                          FROM jsonb_array_elements(p_fields) AS f);
      END IF;
      IF v_src_unit_price IS NULL THEN
        v_src_unit_price := COALESCE(v_app_service.default_rate_per_acre_cents, 0);
        v_base_source    := COALESCE(v_base_source, 'service_default');
      ELSE
        v_base_source    := COALESCE(v_base_source, 'service_rate');
      END IF;
    ELSIF v_line_kind = 'chemical' THEN
      IF v_src_unit_price IS NULL THEN
        RAISE EXCEPTION 'SPLIT_CHEMICAL_PRICE_REQUIRED: source_unit_price_cents required for chemical line %', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_base_source := COALESCE(v_base_source, 'manual');
    ELSE
      -- flat_fee / fuel_surcharge: bill from source_flat_cents; unit price is 0.
      IF v_src_flat IS NULL THEN
        RAISE EXCEPTION 'SPLIT_FLAT_CENTS_REQUIRED: source_flat_cents required for % line %', v_line_kind, v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_src_unit_price := COALESCE(v_src_unit_price, 0);
      v_base_source    := 'flat';
    END IF;

    INSERT INTO field_app_billing_lines (
      billing_set_id, line_kind, product_id, application_service_id, description,
      source_quantity, source_unit_price_cents, sort_order
    ) VALUES (
      v_set_id, v_line_kind, v_product_id, v_app_service_id, v_line_desc,
      v_src_qty, v_src_unit_price, v_idx
    ) RETURNING id INTO v_line_id;

    -- Build the calculator share vector. If the caller omitted 'shares' the line
    -- uses the default vector; otherwise each share may override micro_pct/price
    -- (a null micro_pct on a field_default share is filled from the default map).
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array'
       AND jsonb_array_length(v_line->'shares') > 0 THEN
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s->>'customer_id',
               'micro_pct',
                 CASE WHEN s->'micro_pct' IS NOT NULL AND jsonb_typeof(s->'micro_pct') <> 'null'
                      THEN (s->>'micro_pct')::bigint
                      ELSE (v_micro_map->>(s->>'customer_id'))::bigint END,
               'split_mode', COALESCE(s->>'split_mode', 'field_default'),
               'price_mode', COALESCE(s->>'price_mode', 'default'),
               'override_unit_price_cents', s->'override_unit_price_cents'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', v->>'customer_id',
               'micro_pct',   (v->>'micro_pct')::bigint,
               'split_mode',  'field_default',
               'price_mode',  'default'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_vector) AS v;
    END IF;

    -- Every line's customer set must EXACTLY equal the billing-set members (spec §3).
    SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
      INTO v_line_customers
      FROM jsonb_array_elements(v_shares) AS value;
    IF v_line_customers IS DISTINCT FROM v_members THEN
      RAISE EXCEPTION 'SPLIT_LINE_MEMBER_MISMATCH: line % customers do not equal the billing-set members', v_idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The single shared engine — preview and save both call this exact function.
    v_calc := compute_line_split_allocation(jsonb_build_object(
      'billing_line_id',         v_line_id::text,
      'line_kind',               v_line_kind,
      'source_quantity',         v_src_qty,
      'source_acres',            v_src_acres,
      'source_unit_price_cents', v_src_unit_price,
      'source_flat_cents',       v_src_flat,
      'base_price_source',       v_base_source,
      'shares',                  v_shares
    ));

    -- Persist the canonical source-line total for the invariant check.
    UPDATE field_app_billing_lines
       SET source_line_cents = (v_calc->>'source_line_cents')::bigint
     WHERE id = v_line_id;

    v_line_plans := v_line_plans || jsonb_build_array(jsonb_build_object(
      'billing_line_id', v_line_id::text,
      'line_kind',       v_line_kind,
      'product_id',      v_product_id,
      'description',     v_line_desc,
      'rate_unit',       v_line->>'rate_unit',
      'sort_order',      v_idx,
      'alloc',           v_calc
    ));
    v_line_hashes := v_line_hashes || jsonb_build_array(v_calc->>'vector_hash');
  END LOOP;

  -- ---- PASS 2: one child invoice per customer --------------------------------
  FOREACH v_cust IN ARRAY v_members
  LOOP
    v_customer_id := v_cust::uuid;
    SELECT farm_name INTO v_customer_name FROM customers WHERE id = v_customer_id;
    -- Display-only "primary grower" flag on the compat share row.
    v_is_primary := EXISTS (
      SELECT 1 FROM field_billing_defaults d
       WHERE d.field_id = ANY(v_field_ids)
         AND d.customer_id = v_customer_id
         AND d.is_primary);

    -- sql-safety: exempt-registry — invoices.field_app_billing_set_id / send_disposition
    -- are created by the prior parked migration 20260718010000 (see file header).
    -- Reuse an existing child for this customer on re-save (preserves invoice_number
    -- + append-only snapshot history — adversarial F1 fix); INSERT only for a new customer.
    v_invoice_id := NULL;
    IF p_billing_set_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE field_app_billing_set_id = v_set_id
         AND customer_id = v_customer_id
         AND deleted_at IS NULL
       LIMIT 1;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number('field_application');
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id, season,
        field_app_billing_set_id
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        v_salesman_id, p_invoice->>'header_notes', p_performed_by,
        0, 0,
        v_group_id, p_application_service_id, current_season(),
        v_set_id
      ) RETURNING id INTO v_invoice_id;
    ELSE
      -- Keep status as-is (draft or unposted); a non-admin cannot reassign salesman.
      UPDATE invoices SET
        invoice_date           = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id            = CASE WHEN is_admin() THEN v_salesman_id ELSE salesman_id END,
        header_notes           = p_invoice->>'header_notes',
        application_service_id  = p_application_service_id,
        invoice_group_id       = v_group_id,
        total_amount_cents     = 0,
        total_cost_cents       = 0,
        send_disposition       = 'normal',
        updated_at             = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_total := 0;
    v_cust_acres    := 0;

    FOR v_plan IN SELECT * FROM jsonb_array_elements(v_line_plans)
    LOOP
      v_line_kind := v_plan->>'line_kind';
      -- this customer's allocation row for this line
      SELECT a INTO v_alloc_row
        FROM jsonb_array_elements(v_plan->'alloc'->'allocations') AS a
       WHERE a->>'customer_id' = v_cust;
      IF v_alloc_row IS NULL THEN
        RAISE EXCEPTION 'SPLIT_MISSING_ALLOCATION: customer % missing on line %', v_cust, v_plan->>'billing_line_id'
          USING ERRCODE = 'internal_error';
      END IF;

      v_qty         := (v_alloc_row->>'allocated_quantity')::numeric;
      v_acres_alloc := (v_alloc_row->>'allocated_acres')::numeric;

      -- Map the precise base_price_source onto the invoice_items.price_source
      -- convention set ('manual'|'quoted'|'tier'); the exact source is preserved
      -- on invoice_line_shares.base_price_source.
      v_item_price_source := CASE (v_alloc_row->>'base_price_source')
        WHEN 'quoted' THEN 'quoted'
        WHEN 'tier'   THEN 'tier'
        WHEN 'service_rate'    THEN 'tier'
        WHEN 'service_default' THEN 'tier'
        ELSE 'manual' END;

      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        is_application_fee, price_source, billing_line_id
      ) VALUES (
        v_invoice_id, (v_plan->>'product_id')::uuid,
        COALESCE(NULLIF(v_plan->>'description', ''),
                 (SELECT product_name FROM products WHERE id = (v_plan->>'product_id')::uuid),
                 initcap(v_line_kind)),
        CASE WHEN v_line_kind = 'service' THEN COALESCE(v_acres_alloc, 0)
             WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0)
             ELSE 1 END,
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,     -- extended = authoritative allocation
        0,
        (v_plan->>'sort_order')::int,
        v_acres_alloc,
        CASE WHEN v_line_kind = 'service' THEN 'acre' ELSE v_plan->>'rate_unit' END,
        (v_line_kind = 'service'),
        v_item_price_source,
        (v_plan->>'billing_line_id')::uuid
      ) RETURNING id INTO v_item_id;

      INSERT INTO invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id,
        split_mode, split_micro_pct, allocated_quantity, allocated_acres,
        base_unit_price_cents, base_price_source, price_mode,
        unit_price_cents, amount_cents,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        (v_plan->>'billing_line_id')::uuid, v_item_id, v_customer_id,
        v_alloc_row->>'split_mode', (v_alloc_row->>'micro_pct')::bigint,
        v_qty, v_acres_alloc,
        (v_alloc_row->>'base_unit_price_cents')::bigint,
        v_alloc_row->>'base_price_source',
        v_alloc_row->>'price_mode',
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,
        v_alloc_row->>'calculation_hash',
        v_plan->'alloc'->>'vector_hash',
        p_performed_by
      );

      v_invoice_total := v_invoice_total + (v_alloc_row->>'amount_cents')::bigint;
      v_cust_acres    := v_cust_acres + COALESCE(v_acres_alloc, 0);
    END LOOP;

    v_send_disposition := CASE WHEN v_invoice_total = 0 THEN 'suppressed_zero_total' ELSE 'normal' END;

    UPDATE invoices
       SET total_amount_cents = v_invoice_total,
           send_disposition   = v_send_disposition,
           updated_at         = now()
     WHERE id = v_invoice_id;

    -- R2: keep the compatibility invoice_shares self-100% row (statements/year-end
    -- read invoice_shares.amount_cents). Do NOT drop as "redundant".
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order, price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_cust_acres, v_invoice_total,
      v_is_primary, 0, NULL, NULL
    );

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_created', 'invoice', v_invoice_id,
      (SELECT role FROM profiles WHERE id = v_actor),
      jsonb_build_object('invoice_number', v_invoice_number,
                         'customer_id', v_customer_id,
                         'total_cents', v_invoice_total,
                         'send_disposition', v_send_disposition),
      v_invoice_total,
      'Per-line split field application invoice created'
    );

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
  END LOOP;

  -- ---- §5 INVARIANTS — check the STORED rows, never the allocator's self-report -
  FOR v_line_id, v_src_line_cents, v_line_src_qty IN
    SELECT id, source_line_cents, source_quantity
      FROM field_app_billing_lines WHERE billing_set_id = v_set_id
  LOOP
    SELECT COALESCE(SUM(amount_cents), 0),
           COALESCE(SUM(split_micro_pct), 0),
           count(DISTINCT customer_id),
           SUM(allocated_quantity)
      INTO v_sum_cents, v_sum_micro, v_line_member_count, v_sum_qty
      FROM invoice_line_shares WHERE billing_line_id = v_line_id;

    IF v_sum_cents IS DISTINCT FROM v_src_line_cents THEN
      RAISE EXCEPTION 'INVARIANT_CENTS: line % stored cents % <> source_line_cents %',
        v_line_id, v_sum_cents, v_src_line_cents USING ERRCODE = 'internal_error';
    END IF;
    IF v_sum_micro <> 100000000 THEN
      RAISE EXCEPTION 'INVARIANT_MICRO: line % micro_pct sum % <> 100000000', v_line_id, v_sum_micro
        USING ERRCODE = 'internal_error';
    END IF;
    IF v_line_member_count <> array_length(v_members, 1) THEN
      RAISE EXCEPTION 'INVARIANT_MEMBERS: line % has % customers, expected %',
        v_line_id, v_line_member_count, array_length(v_members, 1) USING ERRCODE = 'internal_error';
    END IF;
    -- quantity ties to source at 4dp when a source quantity was provided
    IF v_line_src_qty IS NOT NULL
       AND round(COALESCE(v_sum_qty, 0), 4) IS DISTINCT FROM round(v_line_src_qty, 4) THEN
      RAISE EXCEPTION 'INVARIANT_QTY: line % qty sum % <> source_quantity %',
        v_line_id, v_sum_qty, v_line_src_qty USING ERRCODE = 'internal_error';
    END IF;
  END LOOP;

  -- ---- RESULT + idempotency ---------------------------------------------------
  v_result := jsonb_build_object(
    'billing_set_id',     v_set_id,
    'invoice_group_id',   v_group_id,
    'invoice_ids',        to_jsonb(v_invoice_ids),
    'line_vector_hashes', v_line_hashes,
    'request_hash',       p_request_hash
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_app_split_invoice_saved',
    'Per-line split field app billing set saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  -- Record the idempotency key (paired with the wrapper's check_idempotency; see the
  -- idempotency-body-check exemption note at the top — canonical wrapper/impl split).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_app_split_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public._save_field_app_split_invoice_impl(uuid, uuid, jsonb, jsonb, jsonb, uuid, uuid, text, text) FROM public, anon, authenticated;


-- ============================================================================
-- 3. THE PUBLIC WRAPPER — save_field_app_split_invoice
--    Guards + idempotency (advisory lock + payload-hash conflict) + re-save row
--    locks, then delegates. Mirrors the live save_field_app_invoice wrapper shape.
--    NOTE: p_performed_by precedes the defaulted params (Postgres requires all
--    params after the first default to also have defaults) — a deliberate reorder
--    of the RPC-DESIGN §A signature, which listed p_performed_by after a defaulted
--    p_application_service_id (would not compile).
--    Idempotency: this wrapper does check_idempotency + payload-hash conflict; the
--    _impl records via save_idempotency (see the exemption note at the top).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_field_app_split_invoice(
  p_billing_set_id         uuid,
  p_source_job_id          uuid,
  p_invoice                jsonb,
  p_fields                 jsonb,
  p_lines                  jsonb,
  p_performed_by           uuid,
  p_application_service_id  uuid DEFAULT NULL,
  p_idempotency_key        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor        uuid := auth.uid();
  v_request_hash text;
  v_cached       jsonb;
  v_set_group    uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required to save field application invoices';
  END IF;

  -- Deterministic fingerprint of the request payload — a same-key retry with a
  -- CHANGED payload must be rejected, not silently replayed (mirrors
  -- post_invoice_group's IDEMPOTENCY_PAYLOAD_CONFLICT check).
  v_request_hash := md5(
    coalesce(p_billing_set_id::text, '') || '|' ||
    coalesce(p_source_job_id::text, '')  || '|' ||
    coalesce(p_invoice::text, '')        || '|' ||
    coalesce(p_fields::text, '')         || '|' ||
    coalesce(p_lines::text, '')          || '|' ||
    coalesce(p_application_service_id::text, '')
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('save_field_app_split_invoice:' || p_idempotency_key, 0));
    v_cached := check_idempotency(p_idempotency_key, 'save_field_app_split_invoice');
    IF v_cached IS NOT NULL THEN
      IF v_cached->>'request_hash' IS DISTINCT FROM v_request_hash THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      RETURN v_cached;
    END IF;
  END IF;

  -- Re-save: serialize on the set's immutable group id, then anchor-then-full-set
  -- FOR UPDATE the child invoices and assert none is posted/voided (same order as
  -- the live save/post wrappers).
  IF p_billing_set_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_set_group
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(v_set_group, p_billing_set_id)::text, 0));

    PERFORM 1 FROM invoices
      WHERE field_app_billing_set_id = p_billing_set_id AND deleted_at IS NULL
      ORDER BY id LIMIT 1 FOR UPDATE;

    PERFORM 1 FROM invoices
      WHERE field_app_billing_set_id = p_billing_set_id AND deleted_at IS NULL
      ORDER BY id FOR UPDATE;

    IF EXISTS (SELECT 1 FROM invoices
                WHERE field_app_billing_set_id = p_billing_set_id
                  AND deleted_at IS NULL
                  AND status NOT IN ('draft', 'unposted')) THEN
      RAISE EXCEPTION 'Cannot edit split billing set — a member invoice is already posted or voided';
    END IF;
  END IF;

  RETURN public._save_field_app_split_invoice_impl(
    p_billing_set_id, p_source_job_id, p_invoice, p_fields, p_lines,
    p_performed_by, p_application_service_id, p_idempotency_key, v_request_hash
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.save_field_app_split_invoice(uuid, uuid, jsonb, jsonb, jsonb, uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_field_app_split_invoice(uuid, uuid, jsonb, jsonb, jsonb, uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.save_field_app_split_invoice(uuid, uuid, jsonb, jsonb, jsonb, uuid, uuid, text) IS
  'Per-line split billing: SECURITY DEFINER save path. Builds a field_app_billing_set + lines, calls the shared compute_line_split_allocation engine, writes one draft child invoice per customer (invoice_items + invoice_line_shares + compat invoice_shares self-100% row), suppresses $0 children (send_disposition), and asserts the spec-5 SUM invariants. Posting stays post_invoice_group. Flag-gated, no caller until the Phase-5 UI ships OFF by default.';


-- ============================================================================
-- 4. R1 POST SNAPSHOT — copy invoice_line_shares → snapshots on post
--    AFTER UPDATE OF status on invoices: when a split child flips to 'posted',
--    append its current line shares to the append-only history table. Keeps
--    post_invoice_group unchanged (smallest blast radius). No-op for every
--    non-split invoice (guarded on field_app_billing_set_id).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.snapshot_invoice_line_shares_on_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'posted'
     AND OLD.status IS DISTINCT FROM 'posted'
     AND NEW.field_app_billing_set_id IS NOT NULL THEN
    INSERT INTO invoice_line_share_snapshots (
      invoice_id, billing_line_id, customer_id, split_micro_pct,
      allocated_quantity, allocated_acres, unit_price_cents, amount_cents, snapshot_reason
    )
    SELECT NEW.id, ils.billing_line_id, ils.customer_id, ils.split_micro_pct,
           ils.allocated_quantity, ils.allocated_acres, ils.unit_price_cents,
           ils.amount_cents, 'post'
      FROM invoice_line_shares ils
      JOIN invoice_items ii ON ii.id = ils.invoice_item_id
     WHERE ii.invoice_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_snapshot_line_shares_on_post ON public.invoices;
CREATE TRIGGER trg_snapshot_line_shares_on_post
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_invoice_line_shares_on_post();

COMMENT ON FUNCTION public.snapshot_invoice_line_shares_on_post() IS
  'Per-line split billing R1: on a split child invoice flipping to posted, appends its invoice_line_shares to invoice_line_share_snapshots (append-only post history across unpost/edit/re-post). No-op for non-split invoices. Keeps post_invoice_group unchanged.';

-- ============================================================================
-- DONE — additive, flag-gated. Posting reuses post_invoice_group unchanged.
-- ============================================================================

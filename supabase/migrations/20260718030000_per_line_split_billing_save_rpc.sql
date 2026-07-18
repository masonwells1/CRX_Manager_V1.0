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
-- SCOPE NOTE (owner-facing — R8 DONE 2026-07-18):
--   For CHEMICAL lines the base unit price is now RESOLVED SERVER-SIDE by
--   resolve_field_app_chemical_price() below (manual override → customer quote for the
--   field → product tier list price), mirroring the LIVE _save_field_app_invoice_impl_20260714
--   precedence, and the applied quantity is converted from the rate unit into the
--   product's sold (inventory) unit via the live field_app_priced_quantity() before the
--   calculator multiplies price x quantity (so a $/gal price never multiplies a rate in
--   oz — the 128x guard the live path enforces). A caller-supplied price is honored ONLY
--   as an EXPLICIT manual override (line.manual_override = true). base_price_source is
--   server-determined, never trusted from the caller.
--   PRICING RULE (Option B — settled by Mason 2026-07-18): each co-owner's share is
--   priced at THAT customer's OWN assigned_tier, mirroring the live per-child field-app
--   save (no customer's price changes vs today; honors the spec's "don't flatten the
--   existing per-customer tier pricing"). A manual override or a field quote is tier-
--   independent, so it applies to EVERY co-owner (one shared price); only the tier
--   fallback varies per customer. Implemented by building a per-customer price map and
--   writing each member's own price into the calculator's per-person price slot (the
--   calculator collapses to source_lr when all prices are equal, else per_person — both
--   penny-exact). The representative line base (field_app_billing_lines.source_unit_price_cents
--   + invoice_line_shares.base_unit_price_cents) is the largest-share owner's price for
--   DISPLAY only; the money is the per-customer unit_price_cents/amount_cents. is_primary
--   stays display-only. SERVICE-fee base rate is resolved server-side (application_services
--   default rate) as before.
--   MAINTENANCE: resolve_field_app_chemical_price() is a PARALLEL copy of the live
--   writer's precedence, kept separate to avoid refactoring the live money function
--   overnight. If the live chemical precedence changes, update BOTH (documented
--   future-unify: extract one shared resolver the live writer also calls). The
--   penny-exact allocation, invariants, freeze, idempotency and $0 suppression are
--   complete and proven regardless of where the base price originates.
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
-- 1b. CHEMICAL BASE-PRICE RESOLVER (R8) — server-side, INTERNAL-ONLY
--    Resolves ONE chemical line's base unit price (per the product's SOLD/inventory
--    unit) in the SAME precedence the live save uses:
--      1) manual override (p_manual_price_cents given)  ->  'manual'
--      2) customer quote for one of the fields
--           quote_items JOIN quote_sections ON section_id, product match,
--           qs.field_id = ANY(p_field_ids), lowest qi.id  ->  'quoted'
--      3) product tier list price for p_tier (fallback tier1)  ->  'tier'
--      4) nothing resolves  ->  0 / 'tier'
--    Prices are stored numeric DOLLARS in products/quote_items; convert to cents with
--    round(x*100) exactly like the live writer. This is a PARALLEL copy of the live
--    _save_field_app_invoice_impl_20260714 chemical precedence (see the MAINTENANCE
--    note in the file header) — keep the two in sync.
--    SECURITY DEFINER so it can read the RLS-protected quote/product tables; EXECUTE is
--    REVOKED from public/anon/authenticated so ONLY the (already fully guarded, same-
--    owner) split writer can call it — no external RLS-bypass surface. Read-only.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_field_app_chemical_price(
  p_product_id         uuid,
  p_field_ids          uuid[],
  p_tier               integer,
  p_manual_price_cents bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_unit_price bigint;
  v_qi_price   numeric;
BEGIN
  -- 1) Manual override wins (caller must have explicitly flagged it upstream).
  IF p_manual_price_cents IS NOT NULL THEN
    RETURN jsonb_build_object('unit_price_cents', p_manual_price_cents, 'price_source', 'manual');
  END IF;

  -- A manual line with no product can only be manually priced; 0 otherwise.
  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object('unit_price_cents', 0, 'price_source', 'manual');
  END IF;

  -- 2) Customer quote for one of these fields (dollars -> cents).
  SELECT qi.price_per_unit
    INTO v_qi_price
    FROM quote_items qi
    JOIN quote_sections qs ON qs.id = qi.section_id
   WHERE qi.product_id = p_product_id
     AND qs.field_id = ANY(p_field_ids)
   ORDER BY qi.id
   LIMIT 1;
  IF v_qi_price IS NOT NULL THEN
    RETURN jsonb_build_object('unit_price_cents', round(v_qi_price * 100)::bigint,
                              'price_source', 'quoted');
  END IF;

  -- 3) Product tier list price (fallback to tier1 when the tier price is null).
  SELECT CASE COALESCE(p_tier, 1)
           WHEN 2 THEN COALESCE(round(p.tier2_price * 100), round(p.tier1_price * 100), 0)
           WHEN 3 THEN COALESCE(round(p.tier3_price * 100), round(p.tier1_price * 100), 0)
           ELSE      COALESCE(round(p.tier1_price * 100), 0)
         END
    INTO v_unit_price
    FROM products p
   WHERE p.id = p_product_id;

  RETURN jsonb_build_object('unit_price_cents', COALESCE(v_unit_price, 0), 'price_source', 'tier');
END;
$fn$;

REVOKE ALL ON FUNCTION public.resolve_field_app_chemical_price(uuid, uuid[], integer, bigint)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.resolve_field_app_chemical_price(uuid, uuid[], integer, bigint) IS
  'Per-line split billing R8: resolves a chemical line base unit price (per the product sold unit) via manual->quoted(quote_items/quote_sections by field)->tier(products.tierN_price, fallback tier1). Parallel copy of the live _save_field_app_invoice_impl_20260714 precedence; keep in sync. Internal-only (EXECUTE revoked from authenticated); called only by the guarded split writer. Read-only.';


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
  v_eff_rate_unit      text;           -- display unit for the line (pricing unit after chemical conversion)
  v_chem_price_map     jsonb;          -- chemical Option B: customer_id -> that customer's own resolved unit price
  v_svc_price_map      jsonb;          -- service Option B: customer_id -> that customer's own per-acre service rate
  v_uniform_price      bigint;         -- chemical/service: the single price when ALL co-owners match (routes round-once)
  v_line_unit_cost     bigint;         -- per-unit COGS for the current line (Codex P1 #3)
  v_invoice_cost       bigint;         -- per-child accumulated total_cost_cents (Codex P1 #3)
  v_is_new_invoice     boolean;        -- true only when a child invoice row is freshly INSERTed (Codex P1 #8)
  v_total_applied_acres numeric := 0;  -- SUM(applied_acres) across p_fields (Codex P2 #9 acre derivation)
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
  v_item_cost_cents    bigint;   -- per-item cost_cents (per-unit for chemical, EXTENDED for fee) — Codex r2 #F
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

  -- ---- CUSTOMER-SCOPE SECURITY (Codex P1 #4, 2026-07-18) ---------------------
  -- This SECURITY DEFINER writer bypasses RLS. Mirror the customers RLS / save_customer
  -- ownership model: a non-admin sales_rep may bill ONLY customers assigned to them.
  -- The billing members are DERIVED from field ownership, so an actor could otherwise
  -- name another rep's fields and create/replace their customers' invoice lines. Verify
  -- every derived member is assigned to the actor. (Existing children on re-save are
  -- checked in the re-save block below, before any delete.)
  IF NOT is_admin() THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_members) AS m(cust)
      LEFT JOIN customers c ON c.id = m.cust::uuid
      WHERE c.id IS NULL OR c.assigned_sales_rep IS DISTINCT FROM v_actor
    ) THEN
      RAISE EXCEPTION 'SPLIT_CUSTOMER_NOT_ASSIGNED: not authorized to bill one or more of these customers'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Total applied acres across the fields — the acre basis for the per-customer compat
  -- share row (Codex P2 #9), derived ONCE here, independent of the billing lines.
  SELECT COALESCE(SUM((f->>'applied_acres')::numeric), 0) INTO v_total_applied_acres
    FROM jsonb_array_elements(p_fields) AS f;

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

    -- Ownership on re-save (Codex P1 #4): a non-admin may only modify a set whose EXISTING
    -- children all belong to customers assigned to the actor (before any delete/insert).
    IF NOT is_admin() AND EXISTS (
      SELECT 1 FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.field_app_billing_set_id = v_set_id AND i.deleted_at IS NULL
        AND c.assigned_sales_rep IS DISTINCT FROM v_actor
    ) THEN
      RAISE EXCEPTION 'SPLIT_SET_NOT_OWNED: not authorized to modify this billing set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL);
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;
    -- Clear the prior group's field snapshots; PASS 3 re-creates them from p_fields (Codex P1 #7).
    DELETE FROM field_app_locations WHERE invoice_group_id = v_group_id;

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
    v_eff_rate_unit  := v_line->>'rate_unit';   -- default; chemical overrides to the pricing unit below
    v_chem_price_map := NULL;                    -- chemical-only; NULL keeps non-chemical lines untouched
    v_svc_price_map  := NULL;                    -- service-only; NULL keeps non-service lines untouched
    v_line_unit_cost := 0;                       -- per-unit COGS for this line (Codex P1 #3)

    IF v_line_kind IS NULL
       OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
      RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: %', COALESCE(v_line_kind, '<null>')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Base-price resolution by kind (see SCOPE NOTE at top for the chemical caveat).
    IF v_line_kind = 'service' THEN
      -- Per-line service record (Codex P1 #1): the editor sends the service id on the LINE
      -- (line.application_service_id); the old code only loaded v_app_service from the always-null
      -- top-level p_application_service_id, so v_app_service was never assigned. Load it per line.
      IF v_app_service_id IS NULL THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_NO_SERVICE: service line % requires an application service', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT * INTO v_app_service FROM application_services WHERE id = v_app_service_id;
      IF NOT FOUND OR NOT v_app_service.is_active THEN
        RAISE EXCEPTION 'Application service not found or inactive: %', v_app_service_id;
      END IF;

      IF v_src_acres IS NULL THEN
        v_src_acres := v_total_applied_acres;
      END IF;

      -- Service COGS: per-acre cost from the service record (mirrors the live field-app path,
      -- which uses application_services.cost_per_acre_cents). Codex P1 #3.
      v_line_unit_cost := COALESCE(v_app_service.cost_per_acre_cents, 0);

      IF COALESCE((v_line->>'manual_override')::boolean, false) AND v_src_unit_price IS NOT NULL THEN
        -- Explicit single negotiated per-acre rate for the whole line (applies to everyone).
        v_base_source := COALESCE(v_base_source, 'service_rate');
      ELSE
        -- Per-customer service rate (Codex P1 #2 — Option B for service): each co-owner at
        -- their OWN customer_application_rates(service, current season) → service default,
        -- exactly like the live per-child field-app save. Injected as per-person overrides below.
        SELECT COALESCE(jsonb_object_agg(m.cust, COALESCE(
                 (SELECT car.rate_per_acre_cents FROM customer_application_rates car
                   WHERE car.customer_id            = m.cust::uuid
                     AND car.application_service_id = v_app_service_id
                     AND car.season                 = current_season()
                   LIMIT 1),
                 v_app_service.default_rate_per_acre_cents, 0)), '{}'::jsonb)
          INTO v_svc_price_map
          FROM unnest(v_members) AS m(cust);
        -- Representative (display + the calculator's default price): the largest-share owner's rate.
        v_src_unit_price := COALESCE((v_svc_price_map->>(
            SELECT (value->>'customer_id') FROM jsonb_array_elements(v_vector) AS value
             ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC LIMIT 1))::bigint, 0);
        v_base_source := COALESCE(v_base_source, 'service_default');
      END IF;
    ELSIF v_line_kind = 'chemical' THEN
      -- R8 (Option B — Mason 2026-07-18): resolve the price SERVER-SIDE and price EACH
      -- co-owner's share at THAT customer's OWN tier (manual override → field quote apply to
      -- everyone; only the tier fallback differs per customer — exactly like the live per-child
      -- field-app save). Also convert the applied quantity rate-unit → product sold unit.
      DECLARE
        v_chem_manual bigint  := NULL;
        v_rep_tier    integer;
        v_inv_unit    text;
        v_form        text;
        v_priced_qty  numeric;
        v_price_res   jsonb;
        v_rate_unit   text := NULLIF(btrim(coalesce(v_line->>'rate_unit', '')), '');
      BEGIN
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_PRODUCT: chemical line % requires product_id', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_src_qty IS NULL OR v_src_qty <= 0 THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_QUANTITY: chemical line % requires source_quantity > 0', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Honor a caller price ONLY as an explicit manual override (a single negotiated price
        -- for the whole line — applies to every co-owner).
        IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
          IF v_src_unit_price IS NULL THEN
            RAISE EXCEPTION 'SPLIT_CHEMICAL_OVERRIDE_PRICE_REQUIRED: manual_override set but no source_unit_price_cents on chemical line %', v_idx
              USING ERRCODE = 'invalid_parameter_value';
          END IF;
          v_chem_manual := v_src_unit_price;
        END IF;

        -- Product units for the rate -> pricing-unit conversion, plus the server-resolved
        -- unit COST (Codex P1 #3). current_cost is dollars per the product's inventory (sold)
        -- unit — the SAME unit as the priced quantity below — so per-unit cents = round(*100),
        -- exactly like _snapshot_order_item_cost and the parked save_invoice.
        SELECT p.inventory_unit, p.product_form,
               COALESCE(round(p.current_cost * 100)::bigint, 0)
          INTO v_inv_unit, v_form, v_line_unit_cost
          FROM products p WHERE p.id = v_product_id;

        -- Per-customer price map (Option B): each billing-set member priced at their OWN
        -- assigned_tier. resolve_field_app_chemical_price() naturally makes manual/quote shared
        -- (tier-independent) and only the tier fallback per-customer, so a manual/quote line
        -- yields identical prices for everyone (calculator collapses to source_lr) while a
        -- pure-tier line prices each co-owner at their own tier (calculator per_person).
        SELECT COALESCE(jsonb_object_agg(
                 m.cust,
                 (resolve_field_app_chemical_price(
                    v_product_id, v_field_ids,
                    COALESCE((SELECT c.assigned_tier FROM customers c WHERE c.id = m.cust::uuid), 1),
                    v_chem_manual)->>'unit_price_cents')::bigint), '{}'::jsonb)
          INTO v_chem_price_map
          FROM unnest(v_members) AS m(cust);

        -- Representative line base (display + the calculator's default price): the largest-share
        -- owner's price. The MONEY comes from the per-customer overrides injected below, not this.
        SELECT c.assigned_tier INTO v_rep_tier
          FROM customers c
         WHERE c.id = (
           SELECT (value->>'customer_id')::uuid
             FROM jsonb_array_elements(v_vector) AS value
            ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC
            LIMIT 1);
        v_price_res      := resolve_field_app_chemical_price(
                              v_product_id, v_field_ids, COALESCE(v_rep_tier, 1), v_chem_manual);
        v_src_unit_price := (v_price_res->>'unit_price_cents')::bigint;
        v_base_source    := v_price_res->>'price_source';

        -- Convert applied qty (rate unit) -> product sold unit so price x qty is per the
        -- SAME unit (the live 128x guard). No inventory_unit -> identity (price as entered).
        v_priced_qty := field_app_priced_quantity(
                          v_src_qty, v_rate_unit, COALESCE(v_inv_unit, v_rate_unit), v_form);
        IF v_priced_qty IS NULL THEN
          RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: chemical line % — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing.',
            v_idx, coalesce(v_rate_unit, '<none>'), COALESCE(v_inv_unit, v_rate_unit, '<none>')
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_src_qty := round(v_priced_qty, 4);
        -- Quantity is now in the pricing (sold) unit; show that unit on the invoice line
        -- so the displayed quantity and its unit label agree.
        v_eff_rate_unit := COALESCE(v_inv_unit, v_rate_unit);
      END;
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

    -- Option B (chemical): price each share at that customer's OWN resolved price from the map,
    -- UNLESS the caller already set an explicit per-person override (a manual draft adjustment,
    -- which wins). The override slot is how per-person prices reach the calculator. Uniform-price
    -- lines are then routed round-once via the penny guard below (source_lr); genuinely mixed
    -- per-customer prices use the calculator's per_person path (exact to its own SUM).
    IF COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL THEN
      SELECT jsonb_agg(
               CASE
                 WHEN s->>'price_mode' = 'override'
                      AND s->'override_unit_price_cents' IS NOT NULL
                      AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
                 THEN s
                 ELSE jsonb_set(
                        jsonb_set(s, '{price_mode}', '"override"'::jsonb),
                        '{override_unit_price_cents}',
                        to_jsonb((COALESCE(v_chem_price_map, v_svc_price_map)->>(s->>'customer_id'))::bigint))
               END)
        INTO v_shares
        FROM jsonb_array_elements(v_shares) AS s;

      -- Penny guard: when EVERY co-owner ends up at the SAME effective price (a manual/quote
      -- line, all-same-tier, OR a uniform manual per-person adjustment that differs from the
      -- representative), align the calculator's source price to that shared value so it routes
      -- through the round-once source_lr path (penny-exact to a single parent total) instead of
      -- per_person (which can differ by up to n-1 cents on the group total). Mixed prices keep
      -- per_person. Adversarial LOW, 2026-07-18.
      SELECT CASE WHEN count(DISTINCT (s->>'override_unit_price_cents')::bigint) = 1
                  THEN max((s->>'override_unit_price_cents')::bigint) END
        INTO v_uniform_price
        FROM jsonb_array_elements(v_shares) AS s
       WHERE s->>'override_unit_price_cents' IS NOT NULL;
      IF v_uniform_price IS NOT NULL THEN
        v_src_unit_price := v_uniform_price;
      END IF;
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
      'rate_unit',       v_eff_rate_unit,
      'sort_order',      v_idx,
      'unit_cost_cents', v_line_unit_cost,   -- per-unit COGS (Codex P1 #3)
      'service_name',    CASE WHEN v_line_kind = 'service' THEN v_app_service.name ELSE NULL END, -- Codex r2 #N
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
      v_is_new_invoice := true;
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
      v_is_new_invoice := false;
      -- Load the existing invoice_number so it is never stale/null on a re-save (Codex P1 #8).
      SELECT invoice_number INTO v_invoice_number FROM invoices WHERE id = v_invoice_id;
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
    v_invoice_cost  := 0;
    -- Compat share acres derived ONCE from the ownership vector × total applied acres
    -- (Codex P2 #9), independent of the billing lines — so it neither zeroes out on a
    -- no-service set nor double-counts across multiple service lines.
    v_cust_acres    := round(v_total_applied_acres
                             * COALESCE((v_micro_map->>v_cust)::numeric, 0) / 100000000.0, 2);

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

      -- Item cost convention (Codex r2 #F): existing invoice code (PDF/detail) reads a FEE
      -- (service) item's cost_cents as ALREADY EXTENDED — the live _save_field_app_invoice_impl
      -- stores cost_per_acre × acres on the fee item — while chemical items carry per-unit cost.
      -- Match that so the item detail and the header total_cost reconcile.
      v_item_cost_cents := CASE
        WHEN v_line_kind = 'service'  THEN safe_cents_qty((v_plan->>'unit_cost_cents')::bigint, COALESCE(v_acres_alloc, 0))
        WHEN v_line_kind = 'chemical' THEN (v_plan->>'unit_cost_cents')::bigint
        ELSE 0 END;

      -- sql-safety: exempt-registry — invoice_items.billing_line_id is created by the prior
      -- parked migration 20260718010000 (not yet in the schema-registry); see file header.
      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        is_application_fee, price_source, billing_line_id
      ) VALUES (
        v_invoice_id, (v_plan->>'product_id')::uuid,
        COALESCE(NULLIF(v_plan->>'description', ''),
                 (SELECT product_name FROM products WHERE id = (v_plan->>'product_id')::uuid),
                 NULLIF(v_plan->>'service_name', ''),      -- Codex r2 #N: real service name, not literal 'Service'
                 initcap(v_line_kind)),
        CASE WHEN v_line_kind = 'service' THEN COALESCE(v_acres_alloc, 0)
             WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0)
             ELSE 1 END,
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,     -- extended = authoritative allocation
        v_item_cost_cents,                          -- per-unit (chemical) / EXTENDED (fee) COGS
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
      -- Accumulate extended COGS: the fee item already stores its EXTENDED cost; a chemical item
      -- stores per-unit cost, so extend it by this customer's billed quantity. Codex P1 #3 / r2 #F.
      v_invoice_cost  := v_invoice_cost + CASE
        WHEN v_line_kind = 'service'  THEN v_item_cost_cents
        WHEN v_line_kind = 'chemical' THEN safe_cents_qty(v_item_cost_cents, COALESCE(v_qty, 0))
        ELSE 0 END;
    END LOOP;

    v_send_disposition := CASE WHEN v_invoice_total = 0 THEN 'suppressed_zero_total' ELSE 'normal' END;

    UPDATE invoices
       SET total_amount_cents = v_invoice_total,
           total_cost_cents   = v_invoice_cost,
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

    -- Append-only ledger: emit the 'invoice_created' row ONLY when this child was freshly
    -- INSERTed (Codex P1 #8). On a re-save we reuse the existing child, so a creation row
    -- here would duplicate the invoice's financial impact and (previously) carry a stale/null
    -- invoice_number. A re-save changes draft line detail only; no creation event is due.
    IF v_is_new_invoice THEN
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
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
  END LOOP;

  -- ---- PASS 3: field snapshots for the group (Codex P1 #7) -------------------
  -- Grouped (multi-customer) field-app invoices carry their field/crop/acre snapshot at the
  -- GROUP level (invoice_id NULL, invoice_group_id set) — exactly how the live field-app save
  -- and the invoice-list panels read them. Without these, lists and PDFs show blank fields,
  -- crops, and zero acres. job_id carries source-job provenance AND satisfies fal_requires_parent
  -- when no invoice_id is present. The prior group's rows were cleared in the re-save block.
  INSERT INTO field_app_locations (
    invoice_group_id, job_id, field_id, applied_acres, total_acres, crop_type, sort_order
  )
  SELECT v_group_id, p_source_job_id, (t.fld->>'field_id')::uuid,
         (t.fld->>'applied_acres')::numeric,
         fl.total_acres, fl.crop_type, (t.ord - 1)::int
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

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

  -- Feature-flag gate (Codex round-2 P1, 2026-07-18): this money RPC is granted to
  -- `authenticated`, so while the migrations are applied but the flag is OFF a direct
  -- PostgREST call could still create split invoices even though the page/nav are hidden.
  -- Refuse unless per_line_split_billing_enabled is explicitly 'true' in app_settings.
  IF COALESCE((SELECT setting_value FROM app_settings
                WHERE setting_key = 'per_line_split_billing_enabled'), 'false') <> 'true' THEN
    RAISE EXCEPTION 'SPLIT_BILLING_DISABLED: per-line split billing is not enabled'
      USING ERRCODE = 'insufficient_privilege';
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

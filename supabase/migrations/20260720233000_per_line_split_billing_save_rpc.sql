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

  -- Codex round-12 P1: this SECURITY DEFINER read bypasses RLS on field_billing_defaults /
  -- job_field_shares / fields, so a sales_rep could pass an ARBITRARY field/job UUID and read the
  -- ownership split of customers not assigned to them. On a DIRECT call, enforce the same ownership
  -- boundary the save ultimately requires — a non-admin may only resolve a vector whose EVERY customer
  -- is assigned to them — and raise WITHOUT echoing the protected data. The internal save writer
  -- (crx.split_writer='on', set before its resolver call) runs its own ownership guards, so it is
  -- exempt here (this changes only the direct-call surface, not the save path).
  IF NOT is_admin()
     AND COALESCE(current_setting('crx.split_writer', true), 'off') <> 'on'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_result) AS e
        WHERE NOT EXISTS (
          SELECT 1 FROM customers c
           WHERE c.id = (e->>'customer_id')::uuid
             AND c.assigned_sales_rep = auth.uid())
     ) THEN
    RAISE EXCEPTION 'RESOLVER_NOT_AUTHORIZED: not authorized to resolve a split for one or more of these fields/jobs'
      USING ERRCODE = 'insufficient_privilege';
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
  v_repr_base_price    bigint;         -- resolved representative base BEFORE the uniform-override penny guard (Codex r7 P2 audit base)
  v_inv_field_names    text[];         -- denormalized field names for the child invoice row (Codex r7 P2)
  v_inv_crop_type      text;           -- denormalized representative crop for the child invoice row (Codex r7 P2)
  v_inv_applicator_name text;          -- source-job applicator, denormalized onto the child (Codex r8 P2)
  v_inv_vehicle_name   text;           -- source-job vehicle, denormalized onto the child (Codex r8 P2)
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
  -- #E source-job double-bill guard (Codex round-2 P1) + round-3 season/freeze
  v_job                record;
  v_other_set          uuid;
  v_set_child_ids      uuid[];    -- this set's child invoice ids captured BEFORE orphan-cancel (round-5 B1)
  v_set_source_job     uuid;     -- the set's frozen source_job_id on re-save (round-3 P1)
  v_season             integer;  -- job/invoice season for pricing + stamping (round-3 P1)
  v_job_app_date       date;     -- source job's application/scheduled date for child invoices (round-3 P2)
  -- Commissions on the split (Codex round-4 P1): mirror transfer_job_to_invoice per child
  v_commission_split   jsonb;
  v_child_id           uuid;
  v_child_customer     uuid;
  v_child_profit       numeric;
  -- Codex round-5 P1: per-child CHEMICAL profit using the LR-allocated COGS (not a re-rounded
  -- cost*qty), so commissions tie to the penny-exact allocation already in the header.
  v_invoice_chem_profit  bigint;
  v_chem_profit_by_child jsonb := '{}'::jsonb;   -- child invoice_id::text -> chemical profit cents
  -- #G canonical line COGS + its largest-remainder split (Codex round-2 P1)
  v_line_cogs          bigint;
  v_cogs_weights       jsonb;
  v_cogs_map           jsonb;
  -- #M audited-base + #L reason capture (Codex round-2 P2)
  v_caller_override    text[];   -- customers the caller priced as a genuine manual override
  v_svc_source_map     jsonb;    -- service: customer_id -> 'service_rate' | 'service_default'
  v_reasons_map        jsonb;    -- customer_id -> {split_reason, price_reason}
  v_share_base_price   bigint;
  v_share_base_source  text;
  v_share_price_mode   text;
  v_split_reason       text;
  v_price_reason       text;
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
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required';
  END IF;

  -- Codex round-4 P1 (posting-boundary integrity): mark THIS transaction as the legitimate
  -- split writer. The trg_guard_split_invoice_items trigger (below) blocks any other path —
  -- notably the generic save_invoice, whose FIELD_INVOICE_SPLIT_LOCKED guard does NOT fire for
  -- our single-compat-share children — from deleting a split child's invoice_items and
  -- cascading away its invoice_line_shares. is_local = true: auto-resets at txn end.
  PERFORM set_config('crx.split_writer', 'on', true);

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

  -- Codex round-4 P1: reject a field id appearing more than once. A duplicate would
  -- double-count its acres into the ownership vector / compat share AND write a duplicate
  -- field_app_locations snapshot for the group. (v_applied_acres_map would silently collapse
  -- dupes to one key, so the acres map and the raw field array could disagree.)
  IF (SELECT count(*) FROM unnest(v_field_ids)) <>
     (SELECT count(DISTINCT x) FROM unnest(v_field_ids) AS x) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_FIELD: a field id appears more than once in p_fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

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

  -- Codex round-7 P2: denormalized field context for the child invoice ROW. FieldInvoicesListPanel +
  -- buildInvoicePdfDataFromRow read invoices.field_names/crop_type/total_acres directly (the dedicated
  -- Drafts/Posted panels hydrate field_app_locations, but the COMBINED list + its PDFs use the row) —
  -- without these each split child shows blank acreage/fields/crop in the combined list and exports.
  SELECT array_agg(fl.field_name ORDER BY t.ord),
         (array_agg(fl.crop_type ORDER BY t.ord) FILTER (WHERE fl.crop_type IS NOT NULL))[1]
    INTO v_inv_field_names, v_inv_crop_type
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- LINES ------------------------------------------------------------------
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_LINES: at least one billing line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Codex round-7 P1 (RUP under-reporting): reject the SAME chemical product on more than one line.
  -- Two chemical lines with the same product create two invoice_items with the same
  -- (invoice_id, product_id); generate_rup_sales_records de-dups by (invoice_id, product_id) and
  -- inserts only the FIRST, silently under-reporting the regulated quantity + amount of the second.
  -- The operator must combine them into one line (mirrors the SPLIT_DUPLICATE_FIELD guard).
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS l
     WHERE l->>'line_kind' = 'chemical' AND NULLIF(l->>'product_id', '') IS NOT NULL
     GROUP BY l->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_PRODUCT: the same chemical product appears on more than one line — combine them into a single line'
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
    SELECT id, invoice_group_id, source_job_id INTO v_set_id, v_group_id, v_set_source_job
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    -- Freeze the source job on re-save (Codex round-3 P1): the set's source_job_id is set
    -- once at first Save and drives the #E consume/guard below. Allowing it to change would
    -- let one billing set consume TWO jobs (the new one gets marked invoiced while the old
    -- stays invoiced and linked). Reject any change; the operator must start a new set.
    IF p_source_job_id IS DISTINCT FROM v_set_source_job THEN
      RAISE EXCEPTION 'SPLIT_JOB_IMMUTABLE: the source job cannot be changed on a saved split set (was %, got %)',
        v_set_source_job, p_source_job_id USING ERRCODE = 'invalid_parameter_value';
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

    -- Only EDITABLE children are cleared for the rebuild. A voided/cancelled child keeps its
    -- invoice_items/invoice_shares as the printed audit record of what was billed then reversed
    -- (RLS review M1) — its billing-line links are NULLed below so the line DELETE stays FK-safe.
    -- Posted/paid children can't reach here (the wrapper's already-posted block rejects the set).
    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    -- Fable-adversarial BLOCKER: a SOFT-deleted child (via the live delete_invoices) is NOT in the
    -- delete above (deleted_at IS NOT NULL), but its invoice_items still reference this set's
    -- field_app_billing_lines (invoice_items.billing_line_id FK, NO ACTION) — so the DELETE below
    -- would 23503-abort and BRICK every future re-save. NULL those dangling refs first (the soft-
    -- deleted invoice keeps its items as history; only the now-meaningless billing-line link is
    -- cleared). PASS 2 then re-creates a child for that customer if they are still a member.
    UPDATE invoice_items SET billing_line_id = NULL
      WHERE billing_line_id IN (SELECT id FROM field_app_billing_lines WHERE billing_set_id = v_set_id);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;
    -- Clear the prior group's field snapshots; PASS 3 re-creates them from p_fields (Codex P1 #7).
    DELETE FROM field_app_locations WHERE invoice_group_id = v_group_id;

    -- Round-5 B1: snapshot this set's current child ids BEFORE the orphan-cancel below detaches any
    -- dropped member (it nulls field_app_billing_set_id). The #E already-invoiced guard uses this so a
    -- re-save that drops the member currently stored in jobs.invoice_id still recognizes that anchor as
    -- OURS — otherwise the just-detached anchor looks like a foreign invoice and trips a false
    -- SPLIT_JOB_ALREADY_INVOICED, blocking the drop-member re-save entirely.
    SELECT array_agg(id) INTO v_set_child_ids
      FROM invoices WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL;

    -- Any existing EDITABLE child whose customer is no longer a billing-set member is
    -- soft-cancelled + detached from the set (its snapshots stay pointing at it,
    -- audit intact) — never hard-deleted. Mirrors the live orphan-cancel path.
    -- Fable-adversarial: only draft/unposted children — a child already voided/cancelled via the
    -- live void_invoice must be skipped, since draft->cancelled is fine but voided->cancelled is a
    -- forbidden status transition that would abort the whole re-save.
    UPDATE invoices
       SET status = 'cancelled', invoice_group_id = NULL, field_app_billing_set_id = NULL,
           total_amount_cents = 0, total_cost_cents = 0, send_disposition = 'normal',
           updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND deleted_at IS NULL
       AND status IN ('draft', 'unposted')
       AND customer_id::text <> ALL (v_members);

    -- Codex round-6 P1: a child VOIDED/CANCELLED (or soft-deleted) via the live void/cancel/delete
    -- path stays attached to this set's invoice_group_id. PASS 2 skips it (reuse is draft/unposted +
    -- not-deleted only) and mints a fresh replacement, BUT post_invoice_group loops EVERY non-filtered
    -- member of the group and RAISES on any status not in (draft,unposted) — so leaving the terminal/
    -- deleted child in the group makes the rebuilt group permanently UNPOSTABLE. Detach such children
    -- from the group (invoice_group_id = NULL) so only active draft/unposted children remain postable;
    -- they keep field_app_billing_set_id as set/audit history and the replacement carries the group.
    UPDATE invoices
       SET invoice_group_id = NULL, updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND invoice_group_id IS NOT NULL
       AND (deleted_at IS NOT NULL OR status IN ('voided', 'cancelled'));
  ELSE
    -- New set. R7: ALWAYS assign an invoice_group_id (even single recipient) so
    -- posting is uniformly post_invoice_group and the set is the durable anchor.
    v_group_id := gen_random_uuid();
    INSERT INTO field_app_billing_sets (invoice_group_id, source_job_id, created_by)
    VALUES (v_group_id, p_source_job_id, p_performed_by)
    RETURNING id INTO v_set_id;
  END IF;

  -- ---- #E SOURCE-JOB DOUBLE-BILL GUARD (Codex round-2 P1, 2026-07-18) ---------
  -- source_job_id was recorded as provenance only, so the SAME job could be billed
  -- here AND again through the normal transfer_job_to_invoice flow (double-bill).
  -- Lock the job, refuse it if it was already billed elsewhere, and (after the child
  -- invoices exist) consume it exactly like transfer_job_to_invoice does — flipping
  -- jobs.status to 'invoiced' so that path's own "Job already invoiced" guard fires.
  -- All checks are re-save-safe: this set's own already-consumed job passes.
  IF p_source_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_source_job_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_FOUND: source job % not found', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- This SECURITY DEFINER writer bypasses RLS and now MUTATES jobs, so a non-admin may
    -- consume only a job whose customer is assigned to them (mirrors the member-scope check).
    -- No IS NOT NULL short-circuit (RLS review M1): a job with a NULL customer_id must be
    -- REFUSED for a non-admin, not skipped — NOT EXISTS is true when customer_id is null.
    IF NOT is_admin()
       AND NOT EXISTS (SELECT 1 FROM customers c
                        WHERE c.id = v_job.customer_id AND c.assigned_sales_rep = v_actor) THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_ASSIGNED: not authorized to bill source job %', p_source_job_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Already tied to a DIFFERENT split billing set?
    SELECT id INTO v_other_set FROM field_app_billing_sets
      WHERE source_job_id = p_source_job_id AND id IS DISTINCT FROM v_set_id
      LIMIT 1;
    IF v_other_set IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_BILLED: source job % is already on split billing set %',
        p_source_job_id, v_other_set USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Already invoiced by the normal flow (linked to an invoice that is NOT one of THIS set's children)?
    -- Round-5 B1: accept the anchor if it is STILL attached to this set OR was one of this set's
    -- children before the orphan-cancel above detached it (a drop-anchor re-save) — v_set_child_ids is
    -- the pre-cancel snapshot; NULL on a first save (COALESCE to empty, so the EXISTS still governs).
    IF v_job.status = 'invoiced' AND v_job.invoice_id IS NOT NULL
       AND NOT (v_job.invoice_id = ANY (COALESCE(v_set_child_ids, ARRAY[]::uuid[])))
       AND NOT EXISTS (SELECT 1 FROM invoices i
                        WHERE i.id = v_job.invoice_id AND i.field_app_billing_set_id = v_set_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_INVOICED: source job % was already invoiced (invoice %)',
        p_source_job_id, v_job.invoice_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Must be completed (or already this set's) to bill — mirrors transfer_job_to_invoice.
    IF v_job.status NOT IN ('completed', 'invoiced') THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_COMPLETED: source job % must be completed to bill (status: %)',
        p_source_job_id, v_job.status USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Codex round-4 P1 + round-5 P1: the billed fields must EXACTLY EQUAL the job's job_fields.
    -- Consuming the job marks the WHOLE job 'invoiced', so billing only a subset (or unrelated
    -- fields) would silently orphan the job's other fields — normal transfer then refuses the
    -- now-invoiced job, so that work can never be billed. Enforce set equality (⊆ AND ⊇), exactly
    -- like transfer_job_to_invoice which always bills every job_field. (a) no billed field outside
    -- the job:
    IF EXISTS (
      SELECT 1 FROM unnest(v_field_ids) AS fid
       WHERE NOT EXISTS (SELECT 1 FROM job_fields jf
                          WHERE jf.job_id = p_source_job_id AND jf.field_id = fid)
    ) THEN
      RAISE EXCEPTION 'SPLIT_FIELD_NOT_ON_JOB: one or more billed fields do not belong to source job %', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- (b) no job field left unbilled:
    IF EXISTS (
      SELECT 1 FROM job_fields jf
       WHERE jf.job_id = p_source_job_id
         AND NOT (jf.field_id = ANY (v_field_ids))
    ) THEN
      RAISE EXCEPTION 'SPLIT_JOB_FIELDS_INCOMPLETE: billing a source job must include ALL of its fields (the whole job is consumed as invoiced); job % has fields not in this split', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_job_app_date := v_job.job_date;          -- carried onto each child (round-3 P2); the LIVE
                                               -- jobs table has job_date (no scheduled_date), and
                                               -- live transfer_job_to_invoice uses job_date too.
    v_season       := v_job.season;            -- capture here (v_job is a bare record, only assigned
                                               -- inside this guard; referencing v_job.season outside
                                               -- it — even in a not-taken CASE branch — raises 55000).
    -- Codex round-8 P2: denormalize the job's applicator + vehicle onto each child (like
    -- transfer_job_to_invoice) — field-invoice lists and PDFs read these invoice columns, so without
    -- them a split child loses who applied it and with what equipment. Job-less splits stay NULL.
    IF v_job.applicator_id IS NOT NULL THEN
      SELECT full_name INTO v_inv_applicator_name FROM profiles WHERE id = v_job.applicator_id;
    END IF;
    IF v_job.vehicle_id IS NOT NULL THEN
      SELECT vehicle_name INTO v_inv_vehicle_name FROM vehicles WHERE id = v_job.vehicle_id;
    END IF;
  END IF;

  -- Season for per-customer service-rate lookups AND the child invoice stamp (Codex round-3 P1):
  -- the SOURCE JOB's season if billing a job (captured above), else the invoice DATE's season, else
  -- current. current_season() alone mis-priced a backdated/prior-season job and filed the wrong year.
  v_season := COALESCE(
    v_season,
    compute_season(COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE)),
    current_season());

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
    v_svc_source_map := NULL;                    -- service-only: customer_id -> resolved source (#M)
    v_line_unit_cost := 0;                       -- per-unit COGS for this line (Codex P1 #3)

    -- #M: customers the CALLER explicitly priced as a genuine manual per-person override
    -- (those stay audited as an 'override'; every other co-owner's resolved per-customer
    -- price is stored as their BASE, not an override vs the largest-share owner). #L: the
    -- operator's reason for a customized split / price, captured per co-owner.
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array' THEN
      -- Codex round-4 P1 (server defense-in-depth for the editor's per-share guard): a
      -- per-PERSON price override must be a POSITIVE amount. Below, a share flagged
      -- price_mode='override' with a non-null override_unit_price_cents is treated as a genuine
      -- caller override and billed at that price — so a 0 / negative value (e.g. the editor's
      -- "1e5" → 0 path, or a direct RPC call) would bill $0 and give product away. Reject it.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_line->'shares') AS s
         WHERE s->>'price_mode' = 'override'
           AND s->'override_unit_price_cents' IS NOT NULL
           AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
           AND (s->>'override_unit_price_cents')::bigint <= 0
      ) THEN
        RAISE EXCEPTION 'SPLIT_SHARE_OVERRIDE_INVALID: a per-person price override on line % must be a positive amount', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT array_agg(s->>'customer_id')
        INTO v_caller_override
        FROM jsonb_array_elements(v_line->'shares') AS s
       WHERE s->>'price_mode' = 'override'
         AND s->'override_unit_price_cents' IS NOT NULL
         AND jsonb_typeof(s->'override_unit_price_cents') <> 'null';
      SELECT jsonb_object_agg(s->>'customer_id', jsonb_build_object(
               'split_reason', NULLIF(btrim(COALESCE(s->>'split_override_reason', '')), ''),
               'price_reason', NULLIF(btrim(COALESCE(s->>'price_override_reason', '')), '')))
        INTO v_reasons_map
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      v_caller_override := NULL;
      v_reasons_map     := '{}'::jsonb;
    END IF;

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
      -- Fable-adversarial HIGH: service source_acres is the billable basis and was the one billable
      -- input with no positivity guard (round-5 covered chemical qty, service RATE, flat cents, per-
      -- share override). A direct/modified RPC call with a negative or zero value would mint a NEGATIVE
      -- (credit) invoice that reduces AR and passes every §5 invariant (signed LR; total<>0 so not $0-
      -- suppressed). The editor only sends positive acres; enforce it server-side.
      IF v_src_acres <= 0 THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_ACRES_NONPOSITIVE: service line % requires source_acres > 0', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- Service COGS: per-acre cost from the service record (mirrors the live field-app path,
      -- which uses application_services.cost_per_acre_cents). Codex P1 #3.
      v_line_unit_cost := COALESCE(v_app_service.cost_per_acre_cents, 0);

      IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
        -- Explicit single negotiated per-acre rate for the whole line (applies to everyone).
        -- Codex round-5 P1: enforce a POSITIVE amount server-side (the editor rejects <=0, but a
        -- direct/modified RPC call could otherwise create a free or negative service line).
        IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
          RAISE EXCEPTION 'SPLIT_SERVICE_RATE_NONPOSITIVE: a manual service rate must be a positive amount on line %', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_base_source := COALESCE(v_base_source, 'service_rate');
      ELSE
        -- Per-customer service rate (Codex P1 #2 — Option B for service): each co-owner at
        -- their OWN customer_application_rates(service, INVOICE/JOB season) → service default,
        -- exactly like the live per-child field-app save. v_season (round-3 P1) ensures a
        -- backdated/prior-season job uses that season's historical rate, not current_season().
        SELECT COALESCE(jsonb_object_agg(m.cust, COALESCE(
                 (SELECT car.rate_per_acre_cents FROM customer_application_rates car
                   WHERE car.customer_id            = m.cust::uuid
                     AND car.application_service_id = v_app_service_id
                     AND car.season                 = v_season
                   LIMIT 1),
                 v_app_service.default_rate_per_acre_cents, 0)), '{}'::jsonb)
          INTO v_svc_price_map
          FROM unnest(v_members) AS m(cust);
        -- #M: the precise per-customer source (a custom customer_application_rates row =>
        -- 'service_rate', otherwise the service default => 'service_default'), so each
        -- co-owner's audited base_price_source is their OWN resolved source. Same season (round-3).
        SELECT jsonb_object_agg(m.cust, CASE WHEN EXISTS (
                 SELECT 1 FROM customer_application_rates car
                  WHERE car.customer_id            = m.cust::uuid
                    AND car.application_service_id = v_app_service_id
                    AND car.season                 = v_season)
               THEN 'service_rate' ELSE 'service_default' END)
          INTO v_svc_source_map
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
          -- Codex round-5 P1: require a POSITIVE manual price server-side (the editor rejects
          -- <=0 / sci-notation, but a direct or modified-client RPC call could otherwise create a
          -- free or negative chemical line despite the UI invariant).
          IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
            RAISE EXCEPTION 'SPLIT_CHEMICAL_OVERRIDE_PRICE_REQUIRED: manual_override set but source_unit_price_cents is missing or not positive on chemical line %', v_idx
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

        -- Codex round-11 P1: reject an UNRESOLVED chemical price. Without a manual override, if any
        -- co-owner's resolved price (field quote → their assigned tier) is NULL or <= 0, the line would
        -- bill $0, be flagged suppressed_zero_total, and STILL post — consuming inventory + RUP records
        -- with NO receivable and no operator signal. Require a real positive price for EVERY member. A
        -- manual override (already validated > 0 above) resolves the same for everyone, so it passes.
        IF v_chem_manual IS NULL AND EXISTS (
          SELECT 1 FROM unnest(v_members) AS m(cust)
           WHERE COALESCE((v_chem_price_map->>m.cust)::bigint, 0) <= 0
        ) THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_PRICE_UNRESOLVED: chemical line % has no resolvable price (no field quote and no tier price) for one or more co-owners — set the product''s tier pricing / a field quote, or enter a manual override, before saving', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

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
      -- Codex round-5 P1: require a POSITIVE amount server-side. The editor rejects <=0
      -- ("credits aren't supported here yet"), but a direct RPC call must not create a free or
      -- negative flat charge (a negative flat_cents would post a CHARGE the operator never saw).
      IF v_src_flat IS NULL OR v_src_flat <= 0 THEN
        RAISE EXCEPTION 'SPLIT_FLAT_CENTS_REQUIRED: source_flat_cents must be a positive amount for % line %', v_line_kind, v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_src_unit_price := COALESCE(v_src_unit_price, 0);
      v_base_source    := 'flat';
    END IF;

    INSERT INTO field_app_billing_lines (
      billing_set_id, line_kind, product_id, application_service_id, description,
      source_quantity, source_acres, source_unit_price_cents, sort_order
    ) VALUES (
      v_set_id, v_line_kind, v_product_id, v_app_service_id, v_line_desc,
      -- Codex round-4 P2 #10: persist the source applied-acre basis alongside the quantity.
      -- Service lines bill on acres (source_quantity is NULL for them), so without this a
      -- post-time verifier had no acre basis for a service line. Now every line records both.
      v_src_qty, v_src_acres, v_src_unit_price, v_idx
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
      -- Codex round-7 P2: preserve the RESOLVED representative base BEFORE the uniform penny guard may
      -- overwrite v_src_unit_price with a (uniform) caller override. An 'override' share's AUDITED base
      -- must stay the true tier/quote/service base, not the override value — otherwise the audit reads
      -- as if the override equalled the base and the real tier/quote/service price is lost.
      v_repr_base_price := v_src_unit_price;
      IF v_uniform_price IS NOT NULL THEN
        v_src_unit_price := v_uniform_price;
      END IF;
    ELSE
      v_repr_base_price := v_src_unit_price;
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

    -- Persist the canonical source-line total for the invariant check. Fable-adversarial MED: also
    -- re-persist source_unit_price_cents to the price the money ACTUALLY used — the billing line was
    -- INSERTed with the representative resolved price, but the uniform-override penny guard above may
    -- have re-pointed v_src_unit_price (e.g. a uniform per-person override that differs from the base),
    -- leaving the audit row's price × source inconsistent with its own source_line_cents.
    UPDATE field_app_billing_lines
       SET source_line_cents = (v_calc->>'source_line_cents')::bigint,
           source_unit_price_cents = v_src_unit_price
     WHERE id = v_line_id;

    -- #G (Codex round-2 P1): allocate the ONE canonical line COGS across co-owners with the
    -- SAME largest-remainder rule used for revenue, so the group total_cost ties EXACTLY to
    -- unit_cost x source — no per-child independent-rounding drift of up to n-1 cents. The
    -- line's micro_pct weights already sum to 100000000 (enforced by the invariant), so
    -- _lr_allocate_int sums the shares to v_line_cogs exactly. Zero cost => all-zero shares.
    v_line_cogs := CASE
      WHEN v_line_kind = 'service'  THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_acres, 0))
      WHEN v_line_kind = 'chemical' THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_qty, 0))
      ELSE 0 END;
    SELECT jsonb_agg(jsonb_build_object('customer_id', a->>'customer_id',
                                        'weight', (a->>'micro_pct')::bigint))
      INTO v_cogs_weights
      FROM jsonb_array_elements(v_calc->'allocations') AS a;
    SELECT jsonb_object_agg(x->>'customer_id', (x->>'amount')::bigint)
      INTO v_cogs_map
      FROM jsonb_array_elements(public._lr_allocate_int(v_line_cogs, v_cogs_weights)) AS x;

    v_line_plans := v_line_plans || jsonb_build_array(jsonb_build_object(
      'billing_line_id', v_line_id::text,
      'line_kind',       v_line_kind,
      'product_id',      v_product_id,
      'description',     v_line_desc,
      'rate_unit',       v_eff_rate_unit,
      'sort_order',      v_idx,
      'unit_cost_cents', v_line_unit_cost,   -- per-unit COGS (Codex P1 #3)
      'cogs_by_customer', v_cogs_map,        -- LR-allocated per-child COGS (Codex r2 #G)
      'per_customer_priced', (COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL), -- Option B (#M)
      'caller_override_custs', COALESCE(to_jsonb(v_caller_override), '[]'::jsonb),       -- genuine overrides (#M)
      'repr_base_unit_price_cents', v_repr_base_price,   -- resolved representative base for the override audit (Codex r7 P2)
      'resolved_price_map', COALESCE(v_chem_price_map, v_svc_price_map, '{}'::jsonb),    -- customer_id -> OWN resolved pre-override price (Codex r8 P2)
      'svc_source_map',  COALESCE(v_svc_source_map, '{}'::jsonb),  -- per-customer service source (#M)
      'reasons_map',     COALESCE(v_reasons_map, '{}'::jsonb),     -- split/price reasons (#L)
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
      -- Reuse only an EDITABLE (draft/unposted) child. Fable-adversarial BLOCKER: a child voided/
      -- cancelled via the live void_invoice stays attached to the set; reusing (reviving) it would be a
      -- forbidden voided->draft transition AND resurrect a dead invoice. Skip it — a fresh child is
      -- INSERTed below for this still-member customer; the terminal one stays as voided/cancelled history.
      SELECT id INTO v_invoice_id FROM invoices
       WHERE field_app_billing_set_id = v_set_id
         AND customer_id = v_customer_id
         AND deleted_at IS NULL
         AND status IN ('draft', 'unposted')
       LIMIT 1;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_is_new_invoice := true;
      v_invoice_number := next_invoice_number('field_application');
      -- sql-safety: exempt-registry — invoices.field_app_billing_set_id is created by the prior
      -- parked migration 20260718010000 (not yet in the schema-registry); job_id / application_date
      -- / season are long-standing invoices columns (mirrors transfer_job_to_invoice).
      -- sql-safety: exempt-registry — field_app_billing_set_id is created by the parked migration
      -- 20260718010000 (not yet in the registry); field_names/crop_type/total_acres are long-standing
      -- invoices columns (20260219200000_invoice_statement_enrichment).
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id, season,
        field_app_billing_set_id, job_id, application_date,
        field_names, crop_type, total_acres,   -- Codex r7 P2: denormalized field context for the combined list/PDFs
        applicator_name, vehicle_name           -- Codex r8 P2: source-job applicator/vehicle
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        v_salesman_id, p_invoice->>'header_notes', p_performed_by,
        0, 0,
        v_group_id, p_application_service_id, v_season,   -- season = job/invoice season (round-3 P1)
        -- job_id + application_date on EVERY child so field-invoice lists resolve Job # and the
        -- application date, not just the first child via jobs.invoice_id (round-3 P2).
        v_set_id, p_source_job_id, v_job_app_date,
        v_inv_field_names, v_inv_crop_type, v_total_applied_acres,
        v_inv_applicator_name, v_inv_vehicle_name
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
        season                 = v_season,               -- keep season in sync on re-save (round-3 P1)
        job_id                 = p_source_job_id,         -- round-3 P2 (frozen source job)
        application_date       = v_job_app_date,
        field_names            = v_inv_field_names,        -- Codex r7 P2: keep denormalized field context in sync on re-save
        crop_type              = v_inv_crop_type,
        total_acres            = v_total_applied_acres,
        applicator_name        = v_inv_applicator_name,    -- Codex r8 P2
        vehicle_name           = v_inv_vehicle_name,
        total_amount_cents     = 0,
        total_cost_cents       = 0,
        send_disposition       = 'normal',
        updated_at             = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_chem_profit := 0;   -- round-5 P1: this child's chemical profit (LR COGS), for commissions
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

      -- #M (Codex round-2 P2) + #L reasons: decide each co-owner's AUDITED base price / source /
      -- mode. A co-owner's OWN resolved per-customer price (Option B) is their BASE with its real
      -- source and price_mode='default'; only a genuine caller-supplied manual per-person override
      -- is audited as an 'override' against the representative base. Non-Option-B lines keep the
      -- calculator's values verbatim. Reasons are captured when the operator supplied them.
      v_split_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'split_reason', '');
      v_price_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'price_reason', '');
      IF (v_plan->'caller_override_custs') ? v_cust THEN
        -- Codex round-7/8 P2: audit THIS customer's OWN resolved pre-override price (Option B), falling
        -- back to the resolved representative base (round-7) then the calculator base. Never the override
        -- value itself — the audit must document what the price WOULD have been before the override.
        v_share_base_price  := COALESCE((v_plan->'resolved_price_map'->>v_cust)::bigint,
                                        (v_plan->>'repr_base_unit_price_cents')::bigint,
                                        (v_alloc_row->>'base_unit_price_cents')::bigint);
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'override';
      ELSIF COALESCE((v_plan->>'per_customer_priced')::boolean, false) THEN
        v_share_base_price  := (v_alloc_row->>'unit_price_cents')::bigint;        -- this co-owner's OWN price
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'default';
      ELSE
        v_share_base_price  := (v_alloc_row->>'base_unit_price_cents')::bigint;
        v_share_base_source := v_alloc_row->>'base_price_source';
        v_share_price_mode  := v_alloc_row->>'price_mode';
      END IF;

      -- Map the AUDITED per-customer source onto the invoice_items.price_source
      -- convention set ('manual'|'quoted'|'tier'); the exact source is preserved
      -- on invoice_line_shares.base_price_source.
      v_item_price_source := CASE v_share_base_source
        WHEN 'quoted' THEN 'quoted'
        WHEN 'tier'   THEN 'tier'
        WHEN 'service_rate'    THEN 'tier'
        WHEN 'service_default' THEN 'tier'
        ELSE 'manual' END;

      -- #G (Codex round-2 P1): this co-owner's LR-allocated COGS share for the line, so the
      -- GROUP total_cost ties EXACTLY to the canonical unit_cost x source (no per-child
      -- independent-round drift of up to n-1 cents). The invoice_items.cost_cents keeps its
      -- display convention (#F): a chemical item carries PER-UNIT cost (PDF/detail render unit
      -- economics), a fee (service) item carries this EXTENDED share. The header total_cost
      -- accumulates the LR share below, so the group total is exact regardless.
      v_item_cost_cents := COALESCE((v_plan->'cogs_by_customer'->>v_cust)::bigint, 0);

      -- sql-safety: exempt-registry — invoice_items.billing_line_id is created by the prior parked
      -- migration 20260718010000 (not yet in the registry); unit_size/total_applied/total_applied_unit
      -- are long-standing invoice_items columns (20260219200000_invoice_statement_enrichment).
      -- Codex round-8 P1: the field-application PDF/email renders the price unit from unit_size and the
      -- applied quantity from total_applied/total_applied_unit. For a chemical child, mirror the canonical
      -- field-app item: unit_size = the pricing unit, total_applied = this co-owner's billed quantity in
      -- that unit. Service/flat leave them null (service bills per acre; flat is flat).
      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        unit_size, total_applied, total_applied_unit,
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
        CASE WHEN v_line_kind = 'chemical' THEN (v_plan->>'unit_cost_cents')::bigint
             ELSE v_item_cost_cents END,            -- chemical: PER-UNIT; fee: EXTENDED LR share (#F/#G)
        (v_plan->>'sort_order')::int,
        v_acres_alloc,
        CASE WHEN v_line_kind = 'service' THEN 'acre' ELSE v_plan->>'rate_unit' END,
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- unit_size = pricing unit
        CASE WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0) END,                  -- total_applied = billed qty
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- total_applied_unit
        (v_line_kind = 'service'),
        v_item_price_source,
        (v_plan->>'billing_line_id')::uuid
      ) RETURNING id INTO v_item_id;

      INSERT INTO invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id,
        split_mode, split_micro_pct, allocated_quantity, allocated_acres,
        base_unit_price_cents, base_price_source, price_mode,
        unit_price_cents, amount_cents,
        split_override_reason, price_override_reason,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        (v_plan->>'billing_line_id')::uuid, v_item_id, v_customer_id,
        v_alloc_row->>'split_mode', (v_alloc_row->>'micro_pct')::bigint,
        v_qty, v_acres_alloc,
        v_share_base_price,          -- #M: co-owner's OWN resolved price is the audited base
        v_share_base_source,         -- #M: their own resolved source (service_rate/tier/...)
        v_share_price_mode,          -- #M: 'default' for resolved pricing, 'override' only for a real one
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,
        v_split_reason, v_price_reason,   -- #L: captured reasons when the operator supplied them
        v_alloc_row->>'calculation_hash',
        v_plan->'alloc'->>'vector_hash',
        p_performed_by
      );

      v_invoice_total := v_invoice_total + (v_alloc_row->>'amount_cents')::bigint;
      -- #G: accumulate this co-owner's LR-allocated COGS share directly; the GROUP total_cost
      -- now ties EXACTLY to the canonical unit_cost x source (no per-child rounding drift).
      v_invoice_cost  := v_invoice_cost + v_item_cost_cents;
      -- Codex round-5 P1: chemical-line profit for commissions uses the SAME LR-allocated COGS
      -- (v_item_cost_cents), NOT a re-rounded cost*qty on the per-unit item cost. Only product-
      -- backed chemical lines count toward commission (fees/service/flat are excluded), mirroring
      -- transfer_job_to_invoice's chemical-only profit basis.
      IF v_line_kind = 'chemical' THEN
        v_invoice_chem_profit := v_invoice_chem_profit
          + ((v_alloc_row->>'amount_cents')::bigint - v_item_cost_cents);
      END IF;
    END LOOP;

    -- Stash this child's chemical profit (cents) for the commission mint below (round-5 P1).
    v_chem_profit_by_child := v_chem_profit_by_child
      || jsonb_build_object(v_invoice_id::text, v_invoice_chem_profit);

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

  -- ---- #E CONSUME THE SOURCE JOB (Codex round-2 P1) --------------------------
  -- Now that the child invoices exist, mark the source job invoiced exactly like
  -- transfer_job_to_invoice does, so the normal flow's "Job already invoiced" guard
  -- fires and the same work can never be billed twice. Idempotent on re-save (a job
  -- already 'invoiced' by THIS set is left as-is; the guard above already allowed it).
  IF p_source_job_id IS NOT NULL THEN
    -- Resolve the commission split exactly like transfer_job_to_invoice: the job's own
    -- creation-time snapshot, else the parent quote's split, else the customer default (only
    -- pre-U8 jobs reach the fallback). v_job was loaded FOR UPDATE in the #E guard above.
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Consume the job: flip completed->invoiced, set the anchor invoice_id, AND persist the resolved
    -- split — ALL IN ONE statement while OLD.status='completed'. The live enforce_billed_job_immutability
    -- trigger early-returns for a not-yet-billed job, so this is the ONLY point a non-admin may set
    -- invoice_id (drift B1); it is exactly the single-statement shape of transfer_job_to_invoice.
    -- Idempotent: no-ops on re-save (status already 'invoiced').
    UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_ids[1],
        commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
     WHERE id = p_source_job_id AND status <> 'invoiced';

    -- Codex round-5 P2 / drift B1: on a RE-SAVE that dropped the member previously stored in
    -- jobs.invoice_id, the anchor now points at a cancelled, detached child — repoint it to a surviving
    -- current child (v_invoice_ids only ever holds current members). The job is already 'invoiced', so
    -- the immutability trigger would block a non-admin from changing invoice_id — use the SAME
    -- app.admin_override hatch that trigger sanctions for definer-flow writers (as transfer_invoice_to_job
    -- does), scoped tightly around JUST this repoint, and ONLY when the stored anchor is no longer a live
    -- member child (a no-op when it is unchanged — the common re-save case, no override needed).
    IF NOT EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = (SELECT j.invoice_id FROM jobs j WHERE j.id = p_source_job_id)
         AND i.field_app_billing_set_id = v_set_id
         AND i.deleted_at IS NULL AND i.status <> 'cancelled'
    ) THEN
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE jobs SET invoice_id = v_invoice_ids[1] WHERE id = p_source_job_id;
      PERFORM set_config('app.admin_override', 'false', true);
    END IF;

    -- application_records has no billed-immutability guard (triggers live only on jobs / job_applied_
    -- records) — repoint it unconditionally to the surviving anchor, matching live transfer_job_to_invoice.
    UPDATE application_records SET invoice_id = v_invoice_ids[1]
     WHERE source_type = 'job' AND source_id = p_source_job_id;

    -- ---- Per-child commissions (Codex round-4 P1) ----------------------------
    -- Mirror transfer_job_to_invoice's PER-OWNER GROUP path: each child invoice mints
    -- commissions on ITS OWN chemical-line profit, so the sum across children equals the
    -- whole job's chemical profit and each recipient is paid per invoice they touch. A
    -- split job billed here previously created NO commissions AND the status flip blocked
    -- the normal path from ever creating them.
    --
    -- Profit basis (Codex round-5 P1): each child's CHEMICAL profit accumulated in PASS 2 using the
    -- SAME largest-remainder-allocated COGS (v_item_cost_cents) that the header total_cost carries —
    -- NOT a re-rounded ROUND(cost × qty) on the per-unit item cost, which would drift on fractional
    -- child quantities (1¢/1u/50-50 rounds both 0.5¢ shares up to 1¢, understating profit). Service /
    -- flat / fee lines contribute 0. Sum across children == the whole job's chemical profit.
    --
    -- Re-save safe: a redraw rewrites every child's items (changing profit) and may DROP a member
    -- (whose child was orphan-cancelled above). The #E guard makes this job EXCLUSIVE to this set
    -- (it cannot be on another set or normally invoiced), so EVERY commission carrying this job_id
    -- belongs to this set — clear them ALL (including a dropped member's, which would otherwise leak
    -- a phantom pending commission on a cancelled invoice), then re-mint only for the current
    -- members. First REFUSE if any are already in an active payout batch or already paid (mirrors
    -- the U8 edit guards): the operator must void that commission payment before re-saving. On a
    -- first save there are none, so the guards pass and the clear is a no-op.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = p_source_job_id AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this split''s pending commissions are in an active payout batch — void that commission payment before re-saving';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions c WHERE c.job_id = p_source_job_id AND c.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this split''s commissions were already paid out — void that commission payment before re-saving';
    END IF;

    -- Fable-adversarial HIGH: SOFT-cancel (never hard-DELETE) the prior commissions, then re-mint.
    -- A hard DELETE FK-violates once any of the job's commissions were EVER in a payout batch — even a
    -- VOIDED one, which is exactly what JOB_HAS_BATCHED_COMMISSIONS tells the operator to do first
    -- (commission_payment_items.commission_id is NO ACTION and void_commission_payment leaves its cpi
    -- rows in place). Soft-cancel mirrors the live convention (delete_invoices / void_invoice cancel+zero
    -- commissions, never delete them) and preserves the audit trail. Re-mint below writes fresh rows.
    UPDATE commissions
       SET status = 'cancelled', commission_amount = 0, deleted_at = now()
     WHERE job_id = p_source_job_id AND deleted_at IS NULL;

    FOREACH v_child_id IN ARRAY v_invoice_ids
    LOOP
      -- Chemical profit for this child from the LR-allocated accumulator (cents -> dollars).
      v_child_profit := COALESCE((v_chem_profit_by_child->>v_child_id::text)::bigint, 0)::numeric / 100.0;

      SELECT customer_id INTO v_child_customer FROM invoices WHERE id = v_child_id;

      PERFORM _insert_commissions_for_job(
        p_source_job_id, v_child_id, v_child_customer,
        COALESCE(v_child_profit, 0), v_commission_split, CURRENT_DATE);
    END LOOP;
  END IF;

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
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
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

    -- Only a genuinely COMMITTED member (posted/paid/overdue) blocks a re-save. Fable-adversarial
    -- BLOCKER: 'cancelled'/'voided' are TERMINAL, not editable money — a child voided/cancelled via the
    -- live void_invoice stays attached (that path never detaches it), so blocking on them left the whole
    -- set uneditable forever and its co-owner's share unbillable. Exclude them here; the impl's PASS-2
    -- reuse (below) skips a non-editable child and mints a fresh one for a still-member customer.
    IF EXISTS (SELECT 1 FROM invoices
                WHERE field_app_billing_set_id = p_billing_set_id
                  AND deleted_at IS NULL
                  AND status NOT IN ('draft', 'unposted', 'cancelled', 'voided')) THEN
      RAISE EXCEPTION 'Cannot edit split billing set — a member invoice is already posted';
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
-- 4. GUARD — generic save_invoice must not tamper with a split child's line items
--    (Codex round-4 P1). _save_invoice_scoped_impl DELETEs ALL invoice_items of the
--    target invoice (then re-inserts from its payload); that delete CASCADEs the
--    invoice_line_shares away, and its existing FIELD_INVOICE_SPLIT_LOCKED guard only
--    trips on >1 invoice_shares — our single-compat-share children slip through and would
--    post a malformed group. Block any DELETE of a split-produced invoice_item
--    (billing_line_id set) unless the split writer marked this txn (crx.split_writer='on').
--    The split writer's own re-save delete runs under that flag; every other path is refused.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.guard_split_invoice_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- DELETE: block cascading a split-produced item away outside the split writer (R4) — else generic
  -- save_invoice deletes the shares and a malformed group posts.
  IF TG_OP = 'DELETE' THEN
    IF OLD.billing_line_id IS NOT NULL
       AND COALESCE(current_setting('crx.split_writer', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'SPLIT_ITEM_LOCKED: invoice line % belongs to a per-line split billing set — edit it through the Split Billing editor (save_field_app_split_invoice), not save_invoice', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE (Codex round-7 P2): block a direct edit of a split-produced item's MATERIAL fields outside
  -- the split writer. The post-time SPLIT_POST_ITEM_SHARE_MISMATCH check only compares extended_cents;
  -- a PATCH of product_id / quantity / unit_price_cents / cost_cents / billing_line_id that leaves
  -- extended_cents unchanged would otherwise print + RUP-report item details that disagree with the
  -- server allocation. Cosmetic fields (description, sort_order, acres) are left editable.
  IF OLD.billing_line_id IS NOT NULL
     AND COALESCE(current_setting('crx.split_writer', true), 'off') <> 'on'
     AND (NEW.product_id      IS DISTINCT FROM OLD.product_id
          OR NEW.quantity         IS DISTINCT FROM OLD.quantity
          OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
          OR NEW.extended_cents   IS DISTINCT FROM OLD.extended_cents
          OR NEW.cost_cents       IS DISTINCT FROM OLD.cost_cents
          OR NEW.billing_line_id  IS DISTINCT FROM OLD.billing_line_id) THEN
    RAISE EXCEPTION 'SPLIT_ITEM_LOCKED: invoice line % belongs to a per-line split billing set — its product/amounts cannot be edited directly; use the Split Billing editor (save_field_app_split_invoice)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Defense-in-depth: SECURITY DEFINER trigger fn, RETURNS trigger (bare OLD/NEW), cannot be
-- invoked via PostgREST — REVOKE matches the file convention and the anon-exec-SECDEF sweep.
REVOKE ALL ON FUNCTION public.guard_split_invoice_items() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_split_invoice_items ON public.invoice_items;
CREATE TRIGGER trg_guard_split_invoice_items
  BEFORE DELETE OR UPDATE ON public.invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_split_invoice_items();

COMMENT ON FUNCTION public.guard_split_invoice_items() IS
  'Per-line split billing R4/round-7: blocks DELETE of, and direct MATERIAL-field UPDATE (product/quantity/unit_price/cost/extended/billing_line) to, a split-produced invoice_item (billing_line_id set) outside the split writer (crx.split_writer=on). Stops generic save_invoice cascading away a split child''s shares AND stops a direct admin PATCH desyncing printed/RUP-reported item details from the server allocation. The split RPC sets the flag for its own re-save delete/insert.';

-- ============================================================================
-- 5. R1 POST SNAPSHOT + POSTING-BOUNDARY VALIDATION
--    AFTER UPDATE OF status on invoices: when a split child flips to 'posted',
--    FIRST validate the split is well-formed (every item carries a line share and the
--    shares tie to the header — Codex round-4 P1), THEN append its current line shares to
--    the append-only history table WITH self-contained line identity (product / service /
--    description / kind — Codex round-4 P1 #8, so post history survives the source rows being
--    deleted on a later unpost+re-save). Keeps post_invoice_group unchanged (smallest blast
--    radius). No-op for every non-split invoice (guarded on field_app_billing_set_id).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.snapshot_invoice_line_shares_on_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_item_cnt   int;
  v_share_cnt  int;
  v_share_sum  bigint;
BEGIN
  IF NEW.status = 'posted'
     AND OLD.status IS DISTINCT FROM 'posted'
     AND NEW.field_app_billing_set_id IS NOT NULL THEN

    -- Posting-boundary invariants (Codex round-4 P1): a split child must be intact to post.
    -- If generic save_invoice (or anything) cascaded away the shares, or item/share/header
    -- diverged, refuse the post — a malformed split must never become a real, posted invoice.
    SELECT count(*) INTO v_item_cnt FROM invoice_items WHERE invoice_id = NEW.id;
    SELECT count(ils.id), COALESCE(SUM(ils.amount_cents), 0)
      INTO v_share_cnt, v_share_sum
      FROM invoice_items ii
      JOIN invoice_line_shares ils ON ils.invoice_item_id = ii.id
     WHERE ii.invoice_id = NEW.id;

    IF v_share_cnt <> v_item_cnt THEN
      RAISE EXCEPTION 'SPLIT_POST_MALFORMED: invoice % has % line item(s) but % line share(s) — the per-line split was corrupted; edit it via the Split Billing editor and re-save before posting',
        NEW.id, v_item_cnt, v_share_cnt USING ERRCODE = 'internal_error';
    END IF;
    IF v_share_sum IS DISTINCT FROM COALESCE(NEW.total_amount_cents, 0) THEN
      RAISE EXCEPTION 'SPLIT_POST_TOTAL_MISMATCH: invoice % line shares sum to % but the header total is % — refusing to post a malformed split',
        NEW.id, v_share_sum, NEW.total_amount_cents USING ERRCODE = 'internal_error';
    END IF;
    -- Fable-adversarial MED: each printed line item's extended_cents must equal its frozen share's
    -- amount_cents. invoice_items UPDATE is is_admin(), and the guard trigger blocks only DELETE — so an
    -- admin PATCH of a split child's extended_cents would desync the printed line from the share while the
    -- share-sum=header check above still passes (shares untouched). Refuse posting such a split.
    IF EXISTS (
      SELECT 1 FROM invoice_items ii
      JOIN invoice_line_shares ils ON ils.invoice_item_id = ii.id
      WHERE ii.invoice_id = NEW.id
        AND COALESCE(ii.extended_cents, 0) IS DISTINCT FROM COALESCE(ils.amount_cents, 0)
    ) THEN
      RAISE EXCEPTION 'SPLIT_POST_ITEM_SHARE_MISMATCH: invoice % has a line item whose amount no longer matches its per-line split share — refusing to post a tampered split',
        NEW.id USING ERRCODE = 'internal_error';
    END IF;

    INSERT INTO invoice_line_share_snapshots (
      invoice_id, billing_line_id, customer_id, split_micro_pct,
      allocated_quantity, allocated_acres, unit_price_cents, amount_cents,
      line_kind, product_id, application_service_id, line_description,
      -- Codex round-7 P2: capture the full override/pricing provenance so post history is auditable
      -- even after a later unpost+re-save deletes the source invoice_line_shares + billing lines.
      base_unit_price_cents, base_price_source, split_mode, price_mode,
      split_override_reason, price_override_reason, calculation_hash, vector_hash,
      snapshot_reason
    )
    SELECT NEW.id, ils.billing_line_id, ils.customer_id, ils.split_micro_pct,
           ils.allocated_quantity, ils.allocated_acres, ils.unit_price_cents, ils.amount_cents,
           bl.line_kind, ii.product_id, bl.application_service_id,
           COALESCE(NULLIF(ii.description, ''), bl.description),
           ils.base_unit_price_cents, ils.base_price_source, ils.split_mode, ils.price_mode,
           ils.split_override_reason, ils.price_override_reason, ils.calculation_hash, ils.vector_hash,
           'post'
      FROM invoice_line_shares ils
      JOIN invoice_items ii ON ii.id = ils.invoice_item_id
      LEFT JOIN field_app_billing_lines bl ON bl.id = ils.billing_line_id
     WHERE ii.invoice_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Defense-in-depth (RLS review I1): this SECURITY DEFINER trigger function keeps the default
-- PUBLIC EXECUTE otherwise. It is a RETURNS trigger (bare NEW/OLD) so it cannot be invoked via
-- PostgREST RPC, but REVOKE matches this file's convention and the anon-exec-SECDEF sweep.
REVOKE ALL ON FUNCTION public.snapshot_invoice_line_shares_on_post() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_snapshot_line_shares_on_post ON public.invoices;
CREATE TRIGGER trg_snapshot_line_shares_on_post
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_invoice_line_shares_on_post();

COMMENT ON FUNCTION public.snapshot_invoice_line_shares_on_post() IS
  'Per-line split billing R1/R4: on a split child flipping to posted, validates the split is well-formed (item↔share count + shares tie to header; refuses SPLIT_POST_MALFORMED / SPLIT_POST_TOTAL_MISMATCH otherwise), then appends its invoice_line_shares to invoice_line_share_snapshots with self-contained line identity (kind/product/service/description). No-op for non-split invoices. Keeps post_invoice_group unchanged.';

-- ============================================================================
-- DONE — additive, flag-gated. Posting reuses post_invoice_group unchanged.
-- ============================================================================

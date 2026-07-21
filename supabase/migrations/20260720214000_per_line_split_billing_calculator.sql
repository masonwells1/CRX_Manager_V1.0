-- ============================================================================
-- PER-LINE SPLIT BILLING — PENNY-EXACT CALCULATOR (pure math, flag-gated)
-- CRX Manager V1.0
-- Date: 2026-07-18
-- Spec: docs/plans/per-line-item-split-billing-spec-2026-07-17.md  (§4 penny-exact
--       algorithm + the 7 pinned rules, §5 money-integrity invariants)
-- Schema it maps to: supabase/migrations/20260718010000_per_line_split_billing_schema.sql
--
-- WHAT
--   Three pure PL/pgSQL functions (no table reads — math over jsonb only) that
--   compute a penny-exact per-line split:
--     * _lr_allocate_int(total, weights)  — signed integer largest-remainder
--       allocation of a total across micro-percent weights.
--     * compute_even_split_vector(customer_ids) — the DEFAULT even split vector,
--       built by the SAME largest-remainder rule so it sums to EXACTLY 100%.
--     * compute_line_split_allocation(line) — allocate ONE billing line across
--       its customers (quantities/acres AND cents), the single engine BOTH the
--       TS preview and the SECURITY DEFINER save/post RPC will call.
--   Output field names map 1:1 onto invoice_line_shares columns (split_micro_pct,
--   allocated_quantity, allocated_acres, base_unit_price_cents, base_price_source,
--   price_mode, unit_price_cents, amount_cents, calculation_hash, vector_hash).
--
-- WHY
--   Independent per-customer rounding is NOT penny-safe (spec §4): 1 unit @ 1¢
--   split 50/50 rounds to 2¢, an even 3-way quantity split rounds to .9999.
--   Largest-remainder allocation with a fixed tie-break (customer_id ASC, applied
--   IDENTICALLY in the quantity pass and the cents pass) is the only way the
--   stored child cents tie back to the canonical source line, and the only way a
--   return/credit (negative line) mirrors the positive case exactly.
--
-- MONEY RULES (spec §4 pinned rules — enforced in code, restated at each site):
--   * numeric / bigint ONLY — never float / double precision, anywhere.
--   * round() is Postgres native half-away-from-zero on numeric (audit-explainable,
--     NOT banker's). Do NOT cast to double.
--   * round exactly once per money figure; prices/quantities stay at full numeric
--     precision through the multiply.
--   * largest remainder = floor on the ABSOLUTE value, distribute the residual one
--     unit at a time ordered by (fractional_remainder DESC, customer_id ASC), then
--     reapply the sign — so −13¢ splits −7/−6 the same way +13¢ splits +7/+6.
--   * same tie-break (customer_id ASC) in BOTH the quantity pass and the cents pass
--     so the extra 0.0001-unit tick and the extra cent land on the same customer.
--
-- BEHAVIOR CHANGE: NONE.
--   Purely additive. These functions read no tables and are called by nothing yet
--   (no caller until the split save/post RPC lands behind a feature flag in a later
--   migration). Existing invoicing is untouched.
--
-- SECURITY
--   All three are SECURITY INVOKER with SET search_path = public, pg_temp. They
--   touch no tables, so they carry no RLS surface; EXECUTE is nonetheless revoked
--   from public/anon and granted only to authenticated.
-- ============================================================================


-- ============================================================================
-- FUNCTION 1: _lr_allocate_int(p_total, p_weights)
--   Signed integer largest-remainder allocation of p_total across micro-percent
--   weights, tie-break customer_id ASC. SUM(result.amount) = p_total EXACTLY.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._lr_allocate_int(p_total bigint, p_weights jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total_weight bigint;
  v_bad_weight   bigint;
  v_sign         integer;
  v_abs          numeric;   -- abs(p_total) as exact numeric; math stays in numeric
  v_result       jsonb;
BEGIN
  IF p_weights IS NULL
     OR jsonb_typeof(p_weights) <> 'array'
     OR jsonb_array_length(p_weights) = 0 THEN
    RAISE EXCEPTION 'SPLIT_WEIGHTS_EMPTY: p_weights must be a non-empty jsonb array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- GUARD 1: a NULL/absent weight is skipped by SUM() and would slip past the
  -- sum-to-1e8 check, then produce NULL amounts. Reject it up front.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_weights) AS w
    WHERE w->'weight' IS NULL OR jsonb_typeof(w->'weight') = 'null'
  ) THEN
    RAISE EXCEPTION 'SPLIT_WEIGHT_NULL: every share needs a numeric micro_pct'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- GUARD 3: a per-weight range check (BEFORE the ideal/floor math) — the SUM
  -- alone accepts e.g. [200000000, -100000000] and would mis-sign the money.
  -- Accepts the exact endpoints 0 and 100000000 (100/0 splits stay valid).
  SELECT (w->>'weight')::bigint
    INTO v_bad_weight
    FROM jsonb_array_elements(p_weights) AS w
    WHERE (w->>'weight')::bigint < 0 OR (w->>'weight')::bigint > 100000000
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SPLIT_WEIGHT_OUT_OF_RANGE: micro_pct % out of [0,100000000]', v_bad_weight
      USING ERRCODE = 'check_violation';
  END IF;

  -- Pinned rule 6: the vector MUST sum to exactly 100.000000% (micro-percent).
  SELECT COALESCE(SUM((w->>'weight')::bigint), 0)
    INTO v_total_weight
    FROM jsonb_array_elements(p_weights) AS w;

  IF v_total_weight <> 100000000 THEN
    RAISE EXCEPTION 'SPLIT_VECTOR_NOT_100PCT: got %', v_total_weight
      USING ERRCODE = 'check_violation';
  END IF;

  -- p_total = 0: everyone gets zero (still ordered by customer_id ASC).
  IF p_total = 0 THEN
    SELECT jsonb_agg(
             jsonb_build_object('customer_id', w->>'customer_id', 'amount', 0::bigint)
             ORDER BY w->>'customer_id' ASC
           )
      INTO v_result
      FROM jsonb_array_elements(p_weights) AS w;
    RETURN v_result;
  END IF;

  -- Abs-then-floor-then-reapply-sign (pinned rule 4). p_total <> 0 here.
  v_sign := CASE WHEN p_total < 0 THEN -1 ELSE 1 END;
  v_abs  := abs(p_total)::numeric;

  WITH ideals AS (
    SELECT
      w->>'customer_id'                                          AS customer_id,
      -- price/weight intermediate in numeric (pinned rule 7, overflow-safe)
      (v_abs * (w->>'weight')::numeric) / 100000000::numeric     AS ideal
    FROM jsonb_array_elements(p_weights) AS w
  ),
  bases AS (
    SELECT
      customer_id,
      floor(ideal)::bigint AS base,
      ideal - floor(ideal) AS frac
    FROM ideals
  ),
  resid AS (
    -- SUM(ideal) = v_abs exactly (weights sum to 1e8), so this residual is in [0, n].
    SELECT abs(p_total) - COALESCE(SUM(base), 0) AS residual FROM bases
  ),
  ranked AS (
    SELECT
      customer_id,
      base,
      row_number() OVER (ORDER BY frac DESC, customer_id ASC) AS rn
    FROM bases
  ),
  allocated AS (
    SELECT
      customer_id,
      -- reapply the sign AFTER the +1 residual bonus
      v_sign * (base + CASE WHEN rn <= (SELECT residual FROM resid) THEN 1 ELSE 0 END) AS amount
    FROM ranked
  )
  SELECT jsonb_agg(
           jsonb_build_object('customer_id', customer_id, 'amount', amount)
           ORDER BY customer_id ASC
         )
    INTO v_result
    FROM allocated;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public._lr_allocate_int(bigint, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public._lr_allocate_int(bigint, jsonb) TO authenticated;

COMMENT ON FUNCTION public._lr_allocate_int(bigint, jsonb) IS
  'Per-line split billing: signed integer largest-remainder allocation of a total (cents or 0.0001-unit ticks) across micro-percent weights, tie-break customer_id ASC. Floors on abs then reapplies sign so negatives mirror positives; SUM of results = p_total exactly. Raises SPLIT_VECTOR_NOT_100PCT if weights <> 100000000. Pure numeric math, no table reads.';


-- ============================================================================
-- FUNCTION 2: compute_even_split_vector(p_customer_ids)
--   The DEFAULT even split vector, built by the SAME largest-remainder rule so it
--   sums to EXACTLY 100000000 (pinned rule 6: 3-way => 33,333,334 / 33,333,333 /
--   33,333,333, NOT three 33,333,333). Returns [{customer_id, micro_pct}] ordered
--   by customer_id ASC.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_even_split_vector(p_customer_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n      integer;
  v_result jsonb;
BEGIN
  IF p_customer_ids IS NULL
     OR jsonb_typeof(p_customer_ids) <> 'array'
     OR jsonb_array_length(p_customer_ids) = 0 THEN
    RAISE EXCEPTION 'SPLIT_CUSTOMERS_EMPTY: p_customer_ids must be a non-empty jsonb array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_n := jsonb_array_length(p_customer_ids);

  -- Equal ideal (100000000 / n each); distribute the residual by largest remainder.
  -- All fractional remainders are equal, so the tie-break (customer_id ASC) alone
  -- decides who gets the extra micro-percent — matching the cents/quantity passes.
  WITH ids AS (
    SELECT val AS customer_id
    FROM jsonb_array_elements_text(p_customer_ids) AS val
  ),
  ranked AS (
    SELECT
      customer_id,
      floor(100000000::numeric / v_n)::bigint AS base,
      row_number() OVER (ORDER BY customer_id ASC) AS rn
    FROM ids
  ),
  resid AS (
    SELECT 100000000 - COALESCE(SUM(base), 0) AS residual FROM ranked
  ),
  allocated AS (
    SELECT
      customer_id,
      base + CASE WHEN rn <= (SELECT residual FROM resid) THEN 1 ELSE 0 END AS micro_pct
    FROM ranked
  )
  SELECT jsonb_agg(
           jsonb_build_object('customer_id', customer_id, 'micro_pct', micro_pct)
           ORDER BY customer_id ASC
         )
    INTO v_result
    FROM allocated;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_even_split_vector(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.compute_even_split_vector(jsonb) TO authenticated;

COMMENT ON FUNCTION public.compute_even_split_vector(jsonb) IS
  'Per-line split billing: builds the default EVEN split vector across customer_ids via largest-remainder (tie-break customer_id ASC) so micro_pct sums to exactly 100000000 (e.g. 3-way => 33,333,334 / 33,333,333 / 33,333,333). Returns [{customer_id, micro_pct}] ordered by customer_id ASC. Raises SPLIT_CUSTOMERS_EMPTY on an empty array.';


-- ============================================================================
-- FUNCTION 3: compute_line_split_allocation(p_line)
--   Allocate ONE billing line across its customers. The SINGLE engine both the TS
--   preview and the save/post RPC call (single-engine rule 1) so preview and post
--   can never diverge on a rounded half-cent.
--
--   INPUT p_line:
--     { billing_line_id, line_kind ('chemical'|'service'|'fuel_surcharge'|'flat_fee'),
--       source_quantity numeric|null, source_acres numeric|null,
--       source_unit_price_cents bigint (0 for flat), base_price_source text,
--       source_flat_cents bigint|null,
--       shares: [ { customer_id, micro_pct, split_mode, price_mode,
--                   override_unit_price_cents } ] }
--
--   OUTPUT:
--     { billing_line_id, line_kind, cents_method, group_total_cents,
--       source_line_cents, vector_hash,
--       allocations: [ ... ordered by customer_id ASC ... ] }
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_line_split_allocation(p_line jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_billing_line_id        text    := p_line->>'billing_line_id';
  v_line_kind              text    := p_line->>'line_kind';
  v_base_price_source      text    := p_line->>'base_price_source';
  v_source_quantity        numeric := (p_line->>'source_quantity')::numeric;
  v_source_acres           numeric := (p_line->>'source_acres')::numeric;
  v_source_unit_price_cents bigint := (p_line->>'source_unit_price_cents')::bigint;
  v_source_flat_cents      bigint  := (p_line->>'source_flat_cents')::bigint;
  v_shares                 jsonb   := p_line->'shares';
  v_weights                jsonb;
  v_all_same               boolean;
  v_cents_method           text;
  v_source_line_cents      bigint;
  v_group_total            bigint;
  v_qty_alloc              jsonb;   -- _lr over 0.0001-unit ticks, or NULL
  v_acres_alloc            jsonb;   -- _lr over 0.0001-acre ticks, or NULL
  v_cents_alloc            jsonb;   -- _lr over cents (flat_lr / source_lr), or NULL
  v_b_source               numeric; -- canonical billable base for source_lr
  v_allocations            jsonb;
  v_sum                    bigint;
  v_vector_string          text;
  v_result                 jsonb;
BEGIN
  -- ---- VALIDATION ---------------------------------------------------------
  IF v_line_kind IS NULL
     OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
    RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: line_kind must be chemical|service|fuel_surcharge|flat_fee, got %',
      COALESCE(v_line_kind, '<null>')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_shares IS NULL
     OR jsonb_typeof(v_shares) <> 'array'
     OR jsonb_array_length(v_shares) = 0 THEN
    RAISE EXCEPTION 'SPLIT_SHARES_EMPTY: p_line.shares must be a non-empty array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Duplicate customer_id in the vector (mirrors UNIQUE(billing_line_id, customer_id)).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_shares) AS s
    GROUP BY s->>'customer_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_CUSTOMER: a customer_id appears more than once in shares'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- GUARD 1 (share side): a NULL/absent micro_pct would slip past the sum check
  -- inside _lr_allocate_int (SUM skips NULLs) and null the money — reject it here.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_shares) AS s
    WHERE s->'micro_pct' IS NULL OR jsonb_typeof(s->'micro_pct') = 'null'
  ) THEN
    RAISE EXCEPTION 'SPLIT_WEIGHT_NULL: every share needs a numeric micro_pct'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Override price mode must carry a price.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_shares) AS s
    WHERE s->>'price_mode' = 'override'
      AND (s->'override_unit_price_cents' IS NULL
           OR jsonb_typeof(s->'override_unit_price_cents') = 'null')
  ) THEN
    RAISE EXCEPTION 'SPLIT_OVERRIDE_PRICE_NULL: price_mode=override requires override_unit_price_cents'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Kind-specific source requirements.
  IF v_line_kind = 'chemical' AND v_source_quantity IS NULL THEN
    RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_QUANTITY: chemical line requires source_quantity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_line_kind = 'service' AND v_source_acres IS NULL THEN
    RAISE EXCEPTION 'SPLIT_SERVICE_NO_ACRES: service line requires source_acres'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_line_kind IN ('flat_fee', 'fuel_surcharge') AND v_source_flat_cents IS NULL THEN
    RAISE EXCEPTION 'SPLIT_FLAT_NO_CENTS: % line requires source_flat_cents', v_line_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- GUARD 2: chemical/service compute cents from source_unit_price_cents; a NULL
  -- price makes round(NULL * qty) = NULL and silently nulls every allocation.
  -- (flat_fee/fuel_surcharge bill from source_flat_cents and may have 0/absent unit price.)
  IF v_line_kind IN ('chemical', 'service') AND v_source_unit_price_cents IS NULL THEN
    RAISE EXCEPTION 'SPLIT_PRICE_REQUIRED: source_unit_price_cents required for %', v_line_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ---- WEIGHTS (micro_pct) ------------------------------------------------
  -- The sum-to-100000000 invariant is enforced inside _lr_allocate_int, which is
  -- called at least once on every code path (qty, acres, or flat cents).
  SELECT jsonb_agg(jsonb_build_object(
           'customer_id', s->>'customer_id',
           'weight',      (s->>'micro_pct')::bigint))
    INTO v_weights
    FROM jsonb_array_elements(v_shares) AS s;

  -- ---- QUANTITIES & ACRES (largest-remainder at 4dp, round exactly once) ---
  -- ticks = 0.0001-unit granularity; round to the nearest tick ONCE, allocate by
  -- LR (same tie-break as cents), then divide back by 10000 (lossless at 4dp).
  IF v_source_quantity IS NOT NULL THEN
    v_qty_alloc := public._lr_allocate_int(round(v_source_quantity * 10000)::bigint, v_weights);
  END IF;
  IF v_source_acres IS NOT NULL THEN
    v_acres_alloc := public._lr_allocate_int(round(v_source_acres * 10000)::bigint, v_weights);
  END IF;

  -- ---- CENTS METHOD -------------------------------------------------------
  IF v_line_kind IN ('flat_fee', 'fuel_surcharge') THEN
    -- Flat / fuel surcharge: LR the fixed total across the percentages.
    v_cents_method      := 'flat_lr';
    v_cents_alloc       := public._lr_allocate_int(v_source_flat_cents, v_weights);
    v_source_line_cents := v_source_flat_cents;
    v_group_total       := v_source_flat_cents;
  ELSE
    -- chemical | service. Determine whether every effective price equals the base.
    SELECT bool_and(
             CASE WHEN s->>'price_mode' = 'override'
                  THEN (s->>'override_unit_price_cents')::bigint = v_source_unit_price_cents
                  ELSE true END)
      INTO v_all_same
      FROM jsonb_array_elements(v_shares) AS s;

    -- Canonical billable base: acres for a service line, quantity otherwise.
    v_b_source := CASE WHEN v_line_kind = 'service' THEN v_source_acres ELSE v_source_quantity END;

    IF v_all_same THEN
      -- Same price for everyone: round the canonical source-line total ONCE, LR it.
      v_cents_method      := 'source_lr';
      v_source_line_cents := round(v_source_unit_price_cents::numeric * v_b_source)::bigint;
      v_cents_alloc       := public._lr_allocate_int(v_source_line_cents, v_weights);
      v_group_total       := v_source_line_cents;
    ELSE
      -- Different per-person prices: no canonical parent total. amount_i is computed
      -- per row below as round(price_i * allocated_billable_i); group_total = SUM.
      -- (spec §4/§5: per-person pricing makes the sum primary; source_line_cents is
      -- documented as = group_total, there is nothing else it should tie to.)
      v_cents_method := 'per_person';
    END IF;
  END IF;

  -- ---- ASSEMBLE PER-CUSTOMER ROWS -----------------------------------------
  -- Join shares with the qty/acres/cents allocations by customer_id. amount_cents:
  --   flat_lr / source_lr => the LR-allocated cents (residual-adjusted; authoritative,
  --                          NOT an independent qty*price re-round — spec §5);
  --   per_person          => round(effective_price * allocated_billable) ONCE.
  WITH sh AS (
    SELECT
      s->>'customer_id'                                    AS customer_id,
      (s->>'micro_pct')::bigint                            AS micro_pct,
      COALESCE(s->>'split_mode', 'field_default')          AS split_mode,
      COALESCE(s->>'price_mode', 'default')                AS price_mode,
      CASE WHEN s->>'price_mode' = 'override'
           THEN (s->>'override_unit_price_cents')::bigint
           ELSE v_source_unit_price_cents END              AS eff_price
    FROM jsonb_array_elements(v_shares) AS s
  ),
  qty AS (
    SELECT q->>'customer_id' AS customer_id, (q->>'amount')::bigint AS ticks
    FROM jsonb_array_elements(COALESCE(v_qty_alloc, '[]'::jsonb)) AS q
  ),
  acr AS (
    SELECT a->>'customer_id' AS customer_id, (a->>'amount')::bigint AS ticks
    FROM jsonb_array_elements(COALESCE(v_acres_alloc, '[]'::jsonb)) AS a
  ),
  cts AS (
    SELECT c->>'customer_id' AS customer_id, (c->>'amount')::bigint AS amt
    FROM jsonb_array_elements(COALESCE(v_cents_alloc, '[]'::jsonb)) AS c
  ),
  rows AS (
    SELECT
      sh.customer_id,
      sh.micro_pct,
      sh.split_mode,
      sh.price_mode,
      sh.eff_price,
      -- lossless normalize back to 4dp (ticks are exact at 4dp)
      CASE WHEN v_qty_alloc   IS NOT NULL THEN round(qty.ticks::numeric / 10000, 4) END AS allocated_quantity,
      CASE WHEN v_acres_alloc IS NOT NULL THEN round(acr.ticks::numeric / 10000, 4) END AS allocated_acres,
      -- billable for the per_person path: acres for service, quantity otherwise
      CASE WHEN v_line_kind = 'service'
           THEN round(acr.ticks::numeric / 10000, 4)
           ELSE round(qty.ticks::numeric / 10000, 4) END AS billable,
      cts.amt AS cents_amt
    FROM sh
    LEFT JOIN qty ON qty.customer_id = sh.customer_id
    LEFT JOIN acr ON acr.customer_id = sh.customer_id
    LEFT JOIN cts ON cts.customer_id = sh.customer_id
  ),
  final AS (
    SELECT
      customer_id,
      micro_pct,
      split_mode,
      price_mode,
      allocated_quantity,
      allocated_acres,
      CASE
        WHEN v_cents_method = 'per_person' THEN round(eff_price::numeric * billable)::bigint
        ELSE cents_amt
      END AS amount_cents,
      CASE
        WHEN v_cents_method = 'flat_lr'    THEN cents_amt            -- implicit qty 1
        WHEN v_cents_method = 'per_person' THEN eff_price
        ELSE v_source_unit_price_cents                              -- source_lr
      END AS unit_price_cents
    FROM rows
  )
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'customer_id',           customer_id,
        'micro_pct',             micro_pct,
        'split_mode',            split_mode,
        'allocated_quantity',    allocated_quantity,
        'allocated_acres',       allocated_acres,
        'base_unit_price_cents', v_source_unit_price_cents,
        'base_price_source',     v_base_price_source,
        'price_mode',            price_mode,
        'unit_price_cents',      unit_price_cents,
        'amount_cents',          amount_cents,
        'calculation_hash',      md5(v_billing_line_id
                                     || customer_id
                                     || micro_pct::text
                                     || unit_price_cents::text
                                     || amount_cents::text)
      ) ORDER BY customer_id ASC
    ),
    SUM(amount_cents),
    string_agg(
      customer_id || ':' || micro_pct::text || ':' || unit_price_cents::text || ':' || amount_cents::text,
      '|' ORDER BY customer_id ASC
    )
    INTO v_allocations, v_sum, v_vector_string
    FROM final;

  -- For the per_person path the total is definitionally the sum of the per-row
  -- rounds; source_line_cents is documented as = group_total (no parent figure).
  IF v_cents_method = 'per_person' THEN
    v_group_total       := v_sum;
    v_source_line_cents := v_sum;
  END IF;

  v_result := jsonb_build_object(
    'billing_line_id',   v_billing_line_id,
    'line_kind',         v_line_kind,
    'cents_method',      v_cents_method,
    'group_total_cents', v_group_total,
    'source_line_cents', v_source_line_cents,
    'vector_hash',       md5(v_vector_string),
    'allocations',       v_allocations
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_line_split_allocation(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.compute_line_split_allocation(jsonb) TO authenticated;

COMMENT ON FUNCTION public.compute_line_split_allocation(jsonb) IS
  'Per-line split billing: penny-exact allocation of ONE billing line across its customers (quantities/acres AND cents) via largest-remainder, tie-break customer_id ASC in every pass. The single engine both the TS preview and the save/post RPC call. cents_method is source_lr (same price: round canonical source-line total once, LR it), per_person (different prices: round price*allocated_qty per person, sum is primary), or flat_lr (LR a fixed total). Output maps 1:1 to invoice_line_shares. Pure numeric math, no table reads.';

-- ============================================================================
-- DONE — additive, flag-gated, no caller yet. No behavior change.
-- ============================================================================

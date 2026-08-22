-- save_job: move the chemical-unit invariant and the job money totals OUT of React
-- and INTO the database, where a hand-built RPC call cannot skip them.
--
-- WHY. EXECUTE on save_job is granted to `authenticated`, so any logged-in user can call
-- it directly. Until now save_job took total_cost_cents / total_price_cents straight from
-- the caller's payload, and inserted job_chemicals rows without ever comparing the rate's
-- unit against the unit the price is quoted in. The React page guards both (JobDetail.tsx,
-- chemLineBillingHazard) -- but a client-side guard is early warning, not a boundary. A
-- stale browser tab, a replayed request, or a direct RPC call bypassed it entirely.
--
-- The live trigger this closes: a 'Dry oz' rate against pound-priced stock invoices 16x,
-- because transfer_job_to_invoice multiplies quantity x price_per_unit_cents with NO
-- conversion.
--
-- WHAT CHANGES -- three things, and nothing else:
--   1. A chemical line whose units provably disagree is REFUSED, naming the product and
--      both units. The predicate mirrors chemLineBillingHazard exactly, so nothing the
--      page accepts today becomes unsaveable.
--   2. A rate unit measured per something OTHER than acres ('oz/cwt') is REFUSED. The
--      quantity = rate x acres derivation is meaningless for such a unit, and the page
--      already refuses it (rateDenominatorIsUnrecognized).
--   3. total_cost_cents / total_price_cents are DERIVED here from p_chemicals via
--      safe_cents_qty, and the caller-supplied totals are IGNORED. This is what makes a
--      stale tab harmless: the totals can no longer disagree with the stored lines.
--
-- The 6-argument signature is UNCHANGED (JobDetail.tsx depends on it), so this is a body
-- replacement, not a new overload, and existing grants are preserved by CREATE OR REPLACE.
--
-- Existing unit tables are REUSED, never reimplemented: normalize_rate_unit,
-- field_app_priced_quantity, safe_cents_qty. Divergence between the client's copy of the
-- unit table and the server's is the original bug; a second server-side copy would be the
-- same mistake again.
--
-- BLAST RADIUS. Verified read-only against every job_chemicals row in the database before
-- writing this: all of them pass the new predicate, and the derived totals reproduce each
-- job's stored total_cost_cents / total_price_cents to the cent.

CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid,
  p_job_payload jsonb,
  p_fields jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_job_id uuid;
  v_is_new boolean := (p_job_id IS NULL);
  v_field jsonb;
  v_chem jsonb;
  v_share jsonb;
  v_field_id uuid;
  v_season integer;
  v_job_date date;
  v_existing jsonb;
  v_result jsonb;
  v_share_total numeric;
  -- Chemical-unit invariant + derived totals (this migration).
  v_acres numeric;
  v_raw_rate_unit text;
  v_rate_base text;
  v_qty_unit text;
  v_price_unit text;
  v_qty numeric;
  v_rate numeric;
  v_carried numeric;
  v_form text;
  v_product_name text;
  v_total_cost_cents bigint;
  v_total_price_cents bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency: replay with the same key returns the original result without
  -- creating a second job (the create-path double-submit hazard).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'save_job';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_job_date := (p_job_payload->>'job_date')::date;
  -- U3 (Codex R2 P2): the live body used a JULY season cutoff (>= 7) while the
  -- system canon is Oct 1 (CLAUDE.md; create_job_from_quote_section and
  -- allocate_payment both use >= 10). transfer_job_to_invoice passes jobs.season
  -- to compute_application_service_fee for customer-specific rates, so a
  -- Jul-Sep job stamped into next season would look up the WRONG season's rate.
  -- Use the canonical live helper.
  v_season := compute_season(v_job_date);

  -- ==========================================================================
  -- CHEMICAL UNIT INVARIANT. Runs BEFORE any write, so a refusal leaves the job
  -- exactly as it was. Mirrors chemLineBillingHazard (src/lib/chemCalculator.ts)
  -- condition for condition; a divergence here would either break a save the page
  -- allows, or wave through the very shape the page blocks.
  --
  -- The acreage is the one the page uses: sumAcres(fieldRows), i.e. the sum of
  -- acres_to_treat over the fields being saved -- NOT p_job_payload.total_acres,
  -- which is caller-supplied and is exactly the kind of number this migration
  -- stops trusting.
  -- ==========================================================================
  SELECT COALESCE(SUM(COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0)), 0)
    INTO v_acres
    FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f;

  FOR v_chem IN SELECT * FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) LOOP
    -- A row with no product is a blank grid line; the page skips it and so do we.
    CONTINUE WHEN COALESCE(v_chem->>'product_id', '') = '';

    v_raw_rate_unit := lower(btrim(COALESCE(v_chem->>'rate_unit', '')));

    -- (2) A rate measured per something other than an acre. 'quantity = rate x acres'
    -- cannot be derived from it, so the quantity is simply the wrong amount. Refused
    -- rather than silently treated as per-acre.
    IF v_raw_rate_unit <> ''
       AND v_raw_rate_unit !~ '\s*/\s*(ac|acre|acres|a)\s*$'
       AND v_raw_rate_unit !~ '\s+per\s+acre$'
       AND position('/' IN v_raw_rate_unit) > 0 THEN
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_RATE_DENOMINATOR_NOT_ACRES: % has a rate unit of "%", which is measured per something other than acres, so a per-acre quantity cannot be derived from it.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit;
    END IF;

    -- The unit the QUANTITY is counted in, and the unit the money is quoted in.
    -- baseUnitOfRate: take everything before the first '/', then drop a spelled-out
    -- ' per acre'. normalize_rate_unit then canonicalises synonyms (lbs -> lb, gl -> gal).
    v_rate_base := btrim(split_part(v_raw_rate_unit, '/', 1));
    v_rate_base := btrim(regexp_replace(v_rate_base, '\s+per\s+acre$', ''));
    v_qty_unit  := normalize_rate_unit(v_rate_base);
    v_price_unit := normalize_rate_unit(v_chem->>'unit');

    -- Blank or unrecognised on either side proves nothing, so nothing is claimed.
    CONTINUE WHEN v_qty_unit IS NULL OR v_price_unit IS NULL;
    CONTINUE WHEN v_qty_unit = v_price_unit;

    v_qty := COALESCE(NULLIF(v_chem->>'quantity','')::numeric, 0);
    CONTINUE WHEN v_qty = 'NaN'::numeric OR v_qty <= 0;

    SELECT p.product_name, lower(COALESCE(p.product_form, ''))
      INTO v_product_name, v_form
      FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;

    -- PROOF OF SAFETY, and the only one: the quantity is what rate x acres reads once
    -- carried into the unit the price is quoted in. Without a usable rate and acreage
    -- nothing is proven, so the row is refused rather than escaping.
    v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
    IF v_rate IS NOT NULL AND v_rate <> 'NaN'::numeric AND v_rate > 0 AND v_acres > 0 THEN
      v_carried := field_app_priced_quantity(v_rate * v_acres, v_qty_unit, v_price_unit, v_form);
      -- quantity is stored through fmt4, so allow 4-dp slack plus a relative epsilon.
      IF v_carried IS NOT NULL
         AND abs(v_qty - v_carried) <= GREATEST(0.0001::numeric, abs(v_carried) * 0.000001::numeric) THEN
        CONTINUE;
      END IF;
    END IF;

    RAISE EXCEPTION
      'CHEM_UNIT_MISMATCH: % is measured in % but its cost and price are quoted per %. Set Unit to %, or change the rate unit to %/ac and re-enter the rate.',
      COALESCE(v_product_name, 'This product'), v_qty_unit, v_price_unit, v_qty_unit, v_price_unit;
  END LOOP;

  -- ==========================================================================
  -- (3) DERIVED MONEY TOTALS. The caller's total_cost_cents / total_price_cents are
  -- ignored outright. safe_cents_qty is the same exact-cents multiply the page's
  -- centsTimesQuantity reproduces (exact numeric multiply, ROUND half away from zero),
  -- rounded PER LINE and then summed -- the same order the page uses, so the two agree
  -- to the cent. customer_supplied product is applied but not billed, contributing 0.
  -- ==========================================================================
  SELECT
    COALESCE(SUM(
      CASE WHEN COALESCE((c->>'customer_supplied')::boolean, false) THEN 0
           ELSE safe_cents_qty(
                  COALESCE(NULLIF(c->>'cost_per_unit_cents','')::bigint, 0),
                  COALESCE(NULLIF(c->>'quantity','')::numeric, 0))
      END), 0)::bigint,
    COALESCE(SUM(
      CASE WHEN COALESCE((c->>'customer_supplied')::boolean, false) THEN 0
           ELSE safe_cents_qty(
                  COALESCE(NULLIF(c->>'price_per_unit_cents','')::bigint, 0),
                  COALESCE(NULLIF(c->>'quantity','')::numeric, 0))
      END), 0)::bigint
    INTO v_total_cost_cents, v_total_price_cents
    FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) c;

  IF v_is_new THEN
    INSERT INTO jobs (
      job_number, customer_id, status, job_date, scheduled_time,
      applicator_id, vehicle_id, recipe_id, application_service_id,
      notes, tags, batch_id, season,
      total_acres, total_cost_cents, total_price_cents,
      call_date, date_proposed, time_proposed, schedule_date, date_expires,
      consultant_id, loader_comment, additional_info, internal_memo,
      created_by, updated_by
    ) VALUES (
      next_job_number(),
      (p_job_payload->>'customer_id')::uuid,
      COALESCE(p_job_payload->>'status', 'scheduled'),
      v_job_date,
      CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'application_service_id' IS NOT NULL AND p_job_payload->>'application_service_id' != ''
        THEN (p_job_payload->>'application_service_id')::uuid ELSE NULL END,
      p_job_payload->>'notes',
      CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      p_job_payload->>'batch_id',
      v_season,
      COALESCE((p_job_payload->>'total_acres')::numeric, 0),
      -- DERIVED, not taken from the caller.
      v_total_cost_cents,
      v_total_price_cents,
      NULLIF(p_job_payload->>'call_date','')::date,
      NULLIF(p_job_payload->>'date_proposed','')::date,
      NULLIF(p_job_payload->>'time_proposed','')::time,
      NULLIF(p_job_payload->>'schedule_date','')::date,
      NULLIF(p_job_payload->>'date_expires','')::date,
      CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      p_job_payload->>'loader_comment',
      p_job_payload->>'additional_info',
      p_job_payload->>'internal_memo',
      p_performed_by,
      v_actor
    )
    RETURNING id INTO v_job_id;
  ELSE
    SELECT id INTO v_job_id FROM jobs WHERE id = p_job_id FOR UPDATE;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'Job not found: %', p_job_id;
    END IF;

    UPDATE jobs SET
      customer_id = (p_job_payload->>'customer_id')::uuid,
      job_date = v_job_date,
      scheduled_time = CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      applicator_id = CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      vehicle_id = CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      recipe_id = CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      -- U3 (Codex R3 P2): three-way -- key ABSENT (stale/cached client on the old
      -- payload shape) preserves the saved service; key present-but-empty is an
      -- explicit clear; a uuid sets it. Prevents an old client's ordinary save
      -- from silently wiping a billing-impacting field.
      application_service_id = CASE
        WHEN NOT (p_job_payload ? 'application_service_id') THEN application_service_id
        WHEN p_job_payload->>'application_service_id' IS NOT NULL AND p_job_payload->>'application_service_id' != ''
          THEN (p_job_payload->>'application_service_id')::uuid
        ELSE NULL END,
      notes = p_job_payload->>'notes',
      tags = CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      batch_id = p_job_payload->>'batch_id',
      season = v_season,
      total_acres = COALESCE((p_job_payload->>'total_acres')::numeric, 0),
      -- DERIVED, not taken from the caller.
      total_cost_cents = v_total_cost_cents,
      total_price_cents = v_total_price_cents,
      call_date = NULLIF(p_job_payload->>'call_date','')::date,
      date_proposed = NULLIF(p_job_payload->>'date_proposed','')::date,
      time_proposed = NULLIF(p_job_payload->>'time_proposed','')::time,
      schedule_date = NULLIF(p_job_payload->>'schedule_date','')::date,
      date_expires = NULLIF(p_job_payload->>'date_expires','')::date,
      consultant_id = CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      loader_comment = p_job_payload->>'loader_comment',
      additional_info = p_job_payload->>'additional_info',
      internal_memo = p_job_payload->>'internal_memo',
      updated_by = v_actor
    WHERE id = v_job_id;
  END IF;

  -- Replace fields (now incl. agronomy: planted_acres, crop, strip, pests)
  DELETE FROM job_fields WHERE job_id = v_job_id;
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, planted_acres, crop, strip, pests, sort_order)
    VALUES (
      v_job_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'acres_to_treat')::numeric,
      NULLIF(v_field->>'planted_acres','')::numeric,
      v_field->>'crop',
      v_field->>'strip',
      v_field->>'pests',
      COALESCE((v_field->>'sort_order')::integer, 0)
    );
  END LOOP;

  -- Replace per-field customer shares. Each field's shares must total 100%
  -- (mirrors the field-app split invariant so section #26 can split cleanly).
  -- A share whose field_id is NOT one of the job's fields (a stale defaults
  -- response or a hand-built payload) is REJECTED -- otherwise the Jobs list /
  -- the #26 split would surface a customer/field that is not on the job (Codex P2).
  DELETE FROM job_field_shares WHERE job_id = v_job_id;
  IF p_job_payload->'field_shares' IS NOT NULL THEN
    -- Reject any share pointing at a field not in p_fields.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid NOT IN (
         SELECT (f->>'field_id')::uuid FROM jsonb_array_elements(p_fields) f
       )
    ) THEN
      RAISE EXCEPTION 'SHARE_FIELD_NOT_ON_JOB';
    END IF;

    -- Validate: per field, the sum of split_pct == 100 (within rounding).
    FOR v_field_id IN
      SELECT DISTINCT (s->>'field_id')::uuid
      FROM jsonb_array_elements(p_job_payload->'field_shares') s
    LOOP
      SELECT COALESCE(SUM((s->>'split_pct')::numeric), 0)
        INTO v_share_total
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid = v_field_id;
      IF ROUND(v_share_total, 2) <> 100 THEN
        RAISE EXCEPTION 'SHARE_NOT_100' USING DETAIL = 'Field shares must total 100%; got ' || v_share_total;
      END IF;
    END LOOP;

    FOR v_share IN SELECT * FROM jsonb_array_elements(p_job_payload->'field_shares') LOOP
      INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
      VALUES (
        v_job_id,
        (v_share->>'field_id')::uuid,
        (v_share->>'customer_id')::uuid,
        (v_share->>'split_pct')::numeric,
        COALESCE((v_share->>'is_primary')::boolean, false)
      );
    END LOOP;
  END IF;

  -- Replace chemicals (now incl. extras: diluent_rate, rei_hours, phi_days,
  -- warehouse, vendor)
  DELETE FROM job_chemicals WHERE job_id = v_job_id;
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals) LOOP
    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied,
      sort_order
    )
    VALUES (
      v_job_id,
      (v_chem->>'product_id')::uuid,
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit',
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit',
      COALESCE((v_chem->>'cost_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'price_per_unit_cents')::bigint, 0),
      NULLIF(v_chem->>'diluent_rate','')::numeric,
      NULLIF(v_chem->>'rei_hours','')::integer,
      NULLIF(v_chem->>'phi_days','')::integer,
      v_chem->>'warehouse',
      v_chem->>'vendor',
      -- U4<<< customer-supplied product: applied but not drawn/deducted/billed. (#53/#54)
      COALESCE((v_chem->>'customer_supplied')::boolean, false),
      -- >>>U4
      COALESCE((v_chem->>'sort_order')::integer, 0)
    );
  END LOOP;

  v_result := jsonb_build_object('success', true, 'job_id', v_job_id, 'is_new', v_is_new);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'save_job', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) IS
  'Saves a job with its fields, customer shares, and chemical lines. Enforces the chemical-unit invariant server-side (a line whose rate unit and price unit provably disagree is refused, as is a rate measured per anything but acres) and DERIVES total_cost_cents / total_price_cents from the chemical lines via safe_cents_qty, ignoring caller-supplied totals. The React guard in JobDetail.tsx is early warning; this is the boundary.';

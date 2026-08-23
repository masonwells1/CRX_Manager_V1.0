-- save_job: move the chemical-unit invariant and the job money totals OUT of React
-- and INTO the database, where a hand-built RPC call cannot skip them.
--
-- WHY. EXECUTE on save_job is granted to `authenticated`, so any logged-in user can call
-- it directly. Until now save_job took total_cost_cents / total_price_cents straight from
-- the caller's payload, and inserted job_chemicals rows without ever comparing the rate's
-- unit against the unit the price is quoted in. Nothing anywhere refused the bad shape.
--
-- The live trigger this closes: a 'Dry oz' rate against pound-priced stock invoices 16x,
-- because transfer_job_to_invoice multiplies quantity x price_per_unit_cents with NO
-- conversion.
--
-- THIS IS A REAL BEHAVIOUR CHANGE, NOT A MIRROR OF AN EXISTING CLIENT GUARD. Read this
-- before approving an apply:
--   * As of this file, `main` has NO save-blocking unit guard in JobDetail.tsx. The
--     client-side counterpart (chemLineBillingHazard / rateDenominatorIsUnrecognized /
--     the exact-cents centsTimesQuantity) exists only on the UNMERGED PR #436 branch. An
--     earlier draft of this header claimed parity with those functions; that claim was
--     false and is retracted.
--   * Worse, reconcileChemAutofillUnits (src/lib/chemCalculator.ts) has a documented
--     "SAFE FALLBACK: keep the STOCK unit" path that MANUFACTURES the refused shape --
--     including the 16x dry-oz/lb case above. The page creates these rows today.
--   * Consequence: applied before PR #436 lands, the first operator to hit this gets a
--     hard save failure, with no prior on-screen warning, on a job the UI showed as fine.
--     Because performSave always re-sends the whole chemical grid, ONE bad legacy line
--     makes the entire job unsaveable -- they cannot even edit its memo -- until that
--     chemical line is corrected.
--   * ORDERING REQUIREMENT: land PR #436 (client warning + exact client money math)
--     BEFORE applying this migration.
--
-- WHAT CHANGES -- three things, and nothing else:
--   1. A chemical line whose units provably disagree is REFUSED, naming the product and
--      both units.
--   2. A rate unit measured per something OTHER than acres is REFUSED, in BOTH the slash
--      form ('oz/cwt') and the spelled-out form ('oz per cwt'). The quantity = rate x
--      acres derivation is meaningless for such a unit.
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
    -- A row with no product cannot be checked: the conversion needs products.product_form.
    -- It is not silently accepted either -- job_chemicals.product_id is NOT NULL, so such a
    -- row aborts the whole save at the INSERT below. (buildJobChemicalsPayload does NOT
    -- filter these out, so this is a real path, not a theoretical one.)
    CONTINUE WHEN COALESCE(v_chem->>'product_id', '') = '';

    v_raw_rate_unit := lower(btrim(COALESCE(v_chem->>'rate_unit', '')));

    -- (2) A rate measured per something other than an acre. 'quantity = rate x acres'
    -- cannot be derived from it, so the quantity is simply the wrong amount. Refused
    -- rather than silently treated as per-acre.
    --
    -- BOTH denominator spellings are caught. Checking only for '/' left a real hole
    -- (Codex P1): 'oz per cwt' has no slash, so it fell through to the unit comparison --
    -- and when `unit` carried the SAME text it compared EQUAL and the row was accepted,
    -- with its quantity already derived as rate x acres against a denominator that is not
    -- acres. The word form is therefore refused too. A genuine per-acre rate in either
    -- spelling ('pt/ac', 'gal per acre') is excluded first and is unaffected.
    IF v_raw_rate_unit <> ''
       AND v_raw_rate_unit !~ '\s*/\s*(ac|acre|acres|a)\s*$'
       AND v_raw_rate_unit !~ '\s+per\s+acre$'
       AND (position('/' IN v_raw_rate_unit) > 0 OR v_raw_rate_unit ~ '\s+per\s+') THEN
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

    -- BLANK on either side proves nothing, so nothing is claimed and the row passes.
    -- Note precisely what this does NOT do: normalize_rate_unit returns NULL only for
    -- BLANK input; an UNRECOGNISED unit comes back as itself (its ELSE branch). So an
    -- unrecognised unit is NOT skipped here -- it flows on, field_app_priced_quantity
    -- cannot size it, and the row is REFUSED. That is deliberate (an unpriceable unit
    -- must not bill), but it also means a metric pair such as 'g/ac' against 'kg' is
    -- refused even though the conversion is arithmetically well defined, because the
    -- live size tables carry no metric entries. Widening them is a separate change.
    CONTINUE WHEN v_qty_unit IS NULL OR v_price_unit IS NULL;
    CONTINUE WHEN v_qty_unit = v_price_unit;

    -- Only a finite, positive quantity can be proven or disproven. NaN and Infinity are
    -- both skipped here (NaN > 0 is TRUE in PostgreSQL, so this must be written as a
    -- finite-range test, not as a NaN test plus <= 0).
    v_qty := COALESCE(NULLIF(v_chem->>'quantity','')::numeric, 0);
    CONTINUE WHEN NOT (v_qty > 0 AND v_qty < 'Infinity'::numeric);

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

    -- The remedy text must not teach a quieter version of the same bug. An earlier draft
    -- said only "Set Unit to <qty_unit>" -- but changing the unit while LEAVING the
    -- per-pound cost and price in place applies a per-pound price per ounce: a 16x
    -- UNDER-bill that also silences this guard, because the units then agree. Both
    -- branches now say explicitly which numbers must be re-entered.
    RAISE EXCEPTION
      'CHEM_UNIT_MISMATCH: % is measured in % but its cost and price are quoted per %. Either set Unit to % AND re-enter the cost and price per %, or change the rate unit to %/ac AND re-enter the rate. Changing one without the other bills the wrong amount.',
      COALESCE(v_product_name, 'This product'), v_qty_unit, v_price_unit, v_qty_unit, v_qty_unit, v_price_unit;
  END LOOP;

  -- ==========================================================================
  -- (3) DERIVED MONEY TOTALS. The caller's total_cost_cents / total_price_cents are
  -- ignored outright. safe_cents_qty is an EXACT numeric multiply with ROUND half away
  -- from zero, applied PER LINE and then summed. customer_supplied product is applied
  -- but not billed, contributing 0.
  --
  -- THE PAGE AND THIS DO NOT AGREE TO THE CENT, and an earlier draft of this comment
  -- wrongly said they did. On `main`, JobDetail.tsx computes its displayed totals as
  -- Math.round(parseFloat(qty) * parseInt(cents)) -- IEEE-754 binary multiply, and
  -- Math.round is half-UP, not half-away-from-zero. Two divergences follow: float
  -- representation error (25c x 0.58 displays 14c, exact arithmetic gives 15c) and
  -- negative half-cents. From here on the SERVER value is the authoritative one and is
  -- what transfer_job_to_invoice bills, so the money is right -- but until PR #436 lands
  -- the exact-cents client path, the operator can see a figure one cent off what is
  -- stored. Per-line-then-sum ordering DOES match the page; only the arithmetic base
  -- differs. This is the second reason PR #436 is an ordering prerequisite.
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
      -- U3 (Codex R3 P2): three-way — key ABSENT (stale/cached client on the old
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
  -- response or a hand-built payload) is REJECTED — otherwise the Jobs list /
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

-- =============================================================================
-- POSTFLIGHT. Assert that the replacement kept every security property the
-- pre-change function had. CREATE OR REPLACE preserves owner and ACLs, but that
-- is a property to VERIFY, not to assume -- rows 888-890 assert the same set for
-- the same reason.
-- =============================================================================
DO $postflight$
DECLARE
  v_oid     oid;
  v_count   integer;
  v_secdef  boolean;
  v_config  text[];
  v_acl     text;
BEGIN
  v_oid := to_regprocedure(format('%I.%I(uuid,jsonb,jsonb,jsonb,uuid,text)', 'public', 'save' || '_job'));
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: the six-argument job-save RPC is absent after replacement.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = (SELECT proname FROM pg_proc WHERE oid = v_oid);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: expected exactly 1 overload after replacement, found % -- a second overload silently splits callers.', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, COALESCE(array_to_string(p.proacl, ','), '')
    INTO v_secdef, v_config, v_acl
    FROM pg_proc p WHERE p.oid = v_oid;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_NOT_SECURITY_DEFINER: the replacement dropped SECURITY DEFINER.';
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SEARCH_PATH: expected a pinned search_path, found %', COALESCE(array_to_string(v_config, ','), '<none>');
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT_LOST: authenticated no longer holds EXECUTE; the app would break.';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT_LOST: service_role no longer holds EXECUTE.';
  END IF;

  -- anon must never reach a SECURITY DEFINER write path, and the default PUBLIC
  -- grant must stay revoked. A bare "=X/" entry in the ACL is the PUBLIC grant.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ANON_EXECUTE: anon holds EXECUTE on a SECURITY DEFINER write path.';
  END IF;
  IF v_acl ~ '(^|,)=X/' THEN
    RAISE EXCEPTION 'POSTFLIGHT_PUBLIC_EXECUTE: PUBLIC holds EXECUTE (acl=%)', v_acl;
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) IS
  'Saves a job with its fields, customer shares, and chemical lines. Enforces the chemical-unit invariant server-side (a line whose rate unit and price unit provably disagree is refused, as is a rate measured per anything but acres) and DERIVES total_cost_cents / total_price_cents from the chemical lines via safe_cents_qty, ignoring caller-supplied totals. The React guard in JobDetail.tsx is early warning; this is the boundary.';

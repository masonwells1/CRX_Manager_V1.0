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
-- WHAT CHANGES -- four things, and nothing else:
--   1. A chemical line whose units provably disagree is REFUSED, naming the product and
--      both units.
--   2. A rate unit measured per something OTHER than acres is REFUSED, in the slash form
--      ('oz/cwt'), the spelled-out form ('oz per cwt') and the hyphenated form
--      ('oz-per-cwt'). The quantity = rate x acres derivation is meaningless for such a
--      unit.
--   3. A quantity that is negative, NaN or Infinity is REFUSED outright, before the unit
--      comparison and regardless of its outcome, because it reaches the money totals in
--      step 4 whether or not the units agree.
--   4. total_cost_cents / total_price_cents are DERIVED here from p_chemicals via
--      safe_cents_qty, and the caller-supplied totals are IGNORED. This is what makes a
--      stale tab harmless: the totals can no longer disagree with the stored lines.
--
-- The 6-argument signature is UNCHANGED (JobDetail.tsx depends on it), so this is a body
-- replacement, not a new overload, and existing grants are preserved by CREATE OR REPLACE.
--
-- Existing unit tables are REUSED, never reimplemented: normalize_rate_unit,
-- field_app_priced_quantity, safe_cents_qty. Divergence between the client's copy of the
-- unit table and the server-side copy is the original bug; a second server-side copy
-- would be the same mistake again.
--
-- ONE DELIBERATE EXCEPTION, stated because the sentence above would otherwise be false.
-- The per-acre SUFFIX STRIPPER here is wider than the one inside normalize_rate_unit.
-- That helper strips only `\s+per\s+acre$`; this file strips
-- `[\s-]+per[\s-]+(acres|acre|ac|a)$`, so it also handles the plural, the hyphen and the
-- abbreviations. Review flagged the divergence and it is kept on purpose, because
-- narrowing it does not remove the disagreement -- it converts it into a FALSE REFUSAL of
-- an ordinary spelling such as `pt per ac`, and a refusal blocks the entire job, not the
-- one line. The divergence runs in the permissive direction and cannot mis-bill: nothing
-- downstream multiplies money by rate_unit. Billing and inventory both read
-- job_chemicals.unit, and the stripped value is used here only to pick which unit the
-- quantity is counted in. Aligning normalize_rate_unit and the client baseUnitOfRate to
-- this wider form is the correct follow-up and is deliberately NOT bundled into a money
-- migration, because that helper is called from paths this change does not touch.
--
-- APPLY CHANNEL: Supabase MCP `apply_migration` ONLY. This file is four top-level
-- statements -- the preflight pin, the replacement, the postflight, and the COMMENT.
-- `execute_sql` returns only the LAST statement, so applied through that channel the pin,
-- the replacement and the postflight would all be silently skipped and the COMMENT alone
-- would run. Every atomicity claim in this header assumes the whole file executes as one
-- unit.
--
-- BLAST RADIUS, re-verified read-only on 2026-08-23 against every job_chemicals row:
-- 4 rows, none negative, none NaN or Infinity, so nothing live is refused by the new
-- step-3 check. The derived totals reproduce every stored total to the cent. One row
-- carries quantity = 0; the invariant skips it, which is correct, because it bills
-- nothing.
--
-- KNOWN RESIDUALS -- stated, not hidden:
--   * One live row has a BLANK unit against a pt/ac rate, carrying both a cost and a
--     price. A blank unit proves nothing, so the invariant skips it, and
--     transfer_job_to_invoice still bills it at price_per_unit_cents x quantity. That is
--     the same hazard class this migration exists to close, and for blank units it is NOT
--     closed. Refusing them would make that live job unsaveable until its unit is
--     corrected, which is an operational decision rather than a code one. Tracked in
--     docs/manual/KNOWN_ISSUES.md.
--   * A NaN acreage can no longer bypass the invariant, but job_fields.acres_to_treat
--     still carries no CHECK, so a hand-built payload can still STORE one. Pre-existing
--     and unchanged by this migration.

-- PREFLIGHT PIN. Asserts that the body the CREATE OR REPLACE below is about to overwrite
-- is exactly the body that was reviewed. It sits in THIS file, immediately before the
-- replacement, so the check and the replacement share one transaction.
--
-- It briefly lived in its own migration (20260820115900, now deleted). Codex and the
-- drift reviewer independently rejected that split: two separately ledgered migrations
-- are not atomic, so if the pin committed and the replacement did not, the ledger
-- recorded the pin as applied and the next run replaced the body WITHOUT revalidating
-- it -- silently reverting whatever changed out of band. Applying them in order was the
-- only control, and an ordering convention is not a guarantee.
--
-- RETRACTION: that file claimed the split was forced by a lexer defect in
-- .claude/hooks/idempotency-body-check.mjs -- that any dollar-quoted block preceding the
-- CREATE made the guard fail closed. That claim was WRONG and is withdrawn. The guard
-- lexes the EDIT FRAGMENT, not the whole file, and the fragment under test had ended
-- mid-signature on an unclosed parenthesis; the guard was correctly reporting an
-- unbalanced parameter list in what it was given. Re-tested on 2026-08-23 with a
-- balanced fragment: this block is accepted exactly where it belongs. The guard has no
-- such defect, no exempt marker is needed, and idempotency inspection stays fully armed.
--
-- This block changes NO schema, NO data and NO function. It only reads the catalog
-- and raises.
DO $preflight$
DECLARE
  v_oid   oid;
  v_count integer;
  v_src   text;
BEGIN
  -- Written as a plain literal on purpose. An earlier draft built this name by
  -- concatenation; review flagged that a grep for the function name would then miss the
  -- two catalog assertions that pin it, which is the opposite of what an auditable
  -- security check should do. No guard in .claude/hooks/ keys on this name, so the
  -- concatenation bought nothing and cost readability.
  v_oid := to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING: the six-argument job-save RPC is not installed. This migration replaces a body; it does not create one.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = (SELECT proname FROM pg_proc WHERE oid = v_oid);
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload of the job-save RPC in public, found %. Reconcile before applying this migration.', v_count;
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;

  -- 7e1668161ae287086e76a8ba5bd313d6 is the reviewed pre-change body, installed by
  -- 20260706080000_customer_supplied_chemicals.sql and read live on 2026-08-23. The
  -- live text carries no CR bytes, so this md5 is computed over exactly what is
  -- stored -- do NOT normalise line endings before comparing, which manufactures a
  -- false drift alarm.
  --
  -- The second arm makes a re-apply a no-op instead of a failure. It keys on the body
  -- MARKER below, not on the operator-visible error text: keying on the error string
  -- meant ANY later body still raising CHEM_UNIT_MISMATCH satisfied the pin, so
  -- replaying this migration would silently revert that later work. A version marker
  -- narrows the window -- a later revision carries a new marker and is refused here. It
  -- does not close it: a later migration that copies this marker verbatim would still
  -- pass, so any body change must bump the marker.
  IF md5(v_src) <> '7e1668161ae287086e76a8ba5bd313d6'
     AND position('chem_unit_invariant_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_BODY_DRIFT: live body md5 is %, expected 7e1668161ae287086e76a8ba5bd313d6. The job-save RPC changed out of band since review. Diff the live body against 20260706080000 and re-review; applying this migration now would silently revert that change.',
      md5(v_src);
  END IF;

  RAISE NOTICE 'PREFLIGHT_OK: job-save RPC body matches the reviewed pin; the replacement may proceed.';
END
$preflight$;

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

  -- BODY MARKER: chem_unit_invariant_v1
  -- Do not remove or reword this string. The preflight pin at the top of this file keys
  -- its re-apply no-op on it, and any future revision of this body MUST bump it to
  -- chem_unit_invariant_v2 so that replaying this migration is refused rather than
  -- silently reverting that revision.
  -- ==========================================================================
  -- CHEMICAL UNIT INVARIANT. Runs BEFORE any write, so a refusal leaves the job
  -- exactly as it was. This predicate is SERVER-AUTHORED AND HAS NO SHIPPED CLIENT
  -- COUNTERPART -- see the retraction in the file header. An earlier draft of this
  -- comment claimed it mirrored chemLineBillingHazard condition for condition; that
  -- function does not exist on `main`, and the claim is retracted. Until PR #436
  -- lands there is NO on-screen warning before this refusal, which is precisely why
  -- that PR is an ordering prerequisite.
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
    -- QUANTITY MUST BE FINITE AND NON-NEGATIVE, and it is checked FIRST -- ahead of every
    -- skip below, including the missing-product skip. A negative or non-finite quantity is
    -- a money defect in its own right, independent of the units: it flows into
    -- safe_cents_qty at the derived-totals step whether or not the units agree, so
    -- checking it only on the units path would leave the matching-units case open.
    --
    -- It also has to precede the product_id skip specifically, because the derived-totals
    -- SELECT sums EVERY element of p_chemicals -- including the ones this loop skips. With
    -- the check placed after that skip, a row carrying no product_id and a NaN quantity
    -- bypassed it entirely and then aborted inside safe_cents_qty with a raw "cannot
    -- convert NaN to bigint" instead of the operator-facing refusal. Fail-closed either
    -- way, but the wrong message (compliance review, round 3).
    --
    -- Written as a finite RANGE test, never as a NaN test. In PostgreSQL numeric, NaN is
    -- ordered ABOVE every other value, so `NaN > 0` is TRUE, and NaN is equal to itself,
    -- so `NaN <= NaN` is TRUE. A naive positivity test therefore admits NaN, and the
    -- tolerance comparison further down admits it a second time (Codex P1, round 3).
    v_qty := COALESCE(NULLIF(v_chem->>'quantity', '')::numeric, 0);
    IF NOT (v_qty >= 0 AND v_qty < 'Infinity'::numeric) THEN
      -- The name lookup is guarded: this arm now runs for rows with no product_id, and
      -- casting an empty string to uuid would replace the business error with a cast error.
      v_product_name := NULL;
      IF COALESCE(v_chem->>'product_id', '') <> '' THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      END IF;
      RAISE EXCEPTION
        'CHEM_QUANTITY_NOT_FINITE: % has a quantity of "%", which is not a finite, non-negative number, so it cannot be priced.',
        COALESCE(v_product_name, 'This product'), COALESCE(v_chem->>'quantity', '');
    END IF;

    -- A row with no product cannot have its UNITS checked: the conversion needs
    -- products.product_form. It is not silently accepted either -- job_chemicals.product_id
    -- is NOT NULL, so such a row aborts the whole save at the INSERT below.
    -- (buildJobChemicalsPayload does NOT filter these out, so this is a real path, not a
    -- theoretical one.)
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
    -- The two acre spellings accept the SAME set of abbreviations, in the same order.
    -- Three asymmetries were found across two review rounds, and every one of them was a
    -- FALSE REFUSAL of a legitimate per-acre rate, which matters more here than it looks:
    -- a refusal blocks the whole job, not the line. (i) the slash form accepted 'acres'
    -- while the word form took only 'acre'; (ii) neither form saw a hyphen, so 'oz-per-cwt'
    -- fell through to the unit comparison and passed whenever `unit` carried the same
    -- text; (iii) the word form took only 'acre'/'acres' while the slash form also took
    -- 'ac' and 'a', so 'pt per ac' -- an ordinary spelling -- was refused as non-acre.
    -- Alternation is longest-first because PostgreSQL regexps are POSIX. 'per' must still
    -- appear as a whole word between separators, so a plain hyphenated unit such as
    -- 'fl-oz' is untouched.
    IF v_raw_rate_unit <> ''
       AND v_raw_rate_unit !~ '\s*/\s*(acres|acre|ac|a)\s*$'
       AND v_raw_rate_unit !~ '[\s-]+per[\s-]+(acres|acre|ac|a)$'
       AND (position('/' IN v_raw_rate_unit) > 0 OR v_raw_rate_unit ~ '[\s-]+per[\s-]+') THEN
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
    -- Kept character-for-character identical to the exclusion above. If the two ever
    -- disagree, a rate unit can be excluded from the non-acre refusal and then NOT
    -- stripped, so it reaches normalize_rate_unit whole, comes back unrecognised, and the
    -- line is refused by the unit comparison instead -- a refusal with the wrong message.
    v_rate_base := btrim(regexp_replace(v_rate_base, '[\s-]+per[\s-]+(acres|acre|ac|a)$', ''));
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

    -- A zero quantity bills nothing, so there is nothing here to prove or disprove.
    -- Negative and non-finite quantities were refused outright at the top of the loop.
    CONTINUE WHEN v_qty = 0;

    SELECT p.product_name, lower(COALESCE(p.product_form, ''))
      INTO v_product_name, v_form
      FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;

    -- PROOF OF SAFETY, and the only one: the quantity is what rate x acres reads once
    -- carried into the unit the price is quoted in. Without a usable rate and acreage
    -- nothing is proven, so the row is refused rather than escaping.
    v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
    -- EVERY operand is range-checked for FINITENESS, not merely for NULL or NaN. This
    -- closes the bypass Codex found (P1, round 3): with a single field carrying
    -- acres_to_treat = 'NaN', the old test `v_acres > 0` PASSED, because PostgreSQL
    -- orders numeric NaN above every other value. v_carried then came back NaN, and the
    -- tolerance line compared NaN <= GREATEST(0.0001, NaN) -- that is, NaN <= NaN, which
    -- is TRUE, since NaN is equal to itself. A mismatched line was therefore waved
    -- through AND the NaN acreage stored. A `< 'Infinity'` bound excludes NaN and
    -- Infinity in one test; a NaN test alone would still admit Infinity.
    IF v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
       AND v_acres > 0 AND v_acres < 'Infinity'::numeric THEN
      v_carried := field_app_priced_quantity(v_rate * v_acres, v_qty_unit, v_price_unit, v_form);
      -- quantity is stored through fmt4, so allow 4-dp slack plus a relative epsilon.
      -- v_carried is bounded for the same reason as its inputs: the helper can return a
      -- non-finite value, and a NaN tolerance compares TRUE against a NaN difference.
      IF v_carried IS NOT NULL
         AND v_carried > '-Infinity'::numeric
         AND v_carried < 'Infinity'::numeric
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
-- ESTABLISH the ACL this file goes on to assert. On live these three statements
-- are a NO-OP: the grants were read read-only on 2026-08-23 and already stand at
-- exactly `postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres`,
-- with `anon` holding nothing.
--
-- They are here for the FROM-SCRATCH REBUILD path, which is where the postflight
-- below would otherwise abort. No migration in this repository has ever REVOKEd
-- this function from `anon` or `PUBLIC`, and the only grant it has ever received
-- is `TO authenticated` (migration 20260624120000). So a database replayed from
-- migrations alone carries whatever Supabase default privileges left at creation
-- time and no `service_role` grant at all -- and the postflight would then refuse
-- a migration that is perfectly correct, or, worse, the assertion would be the
-- only thing standing between an inherited `anon` grant and a SECURITY DEFINER
-- write path. A file that asserts a security property should also establish it;
-- asserting alone was the round-3 review finding.
--
-- caller-analysis: save_job :: the one live caller is the authenticated job-save
-- UI (src/pages/JobDetail.tsx:2210, via the shared client in src/lib/db.ts, which
-- carries the signed-in user's JWT and therefore the `authenticated` role). That
-- role is GRANTed on the line below and is unaffected. Nothing in the repository
-- calls this RPC as `anon` or over the public/service key: the body itself raises
-- AUTH_REQUIRED when auth.uid() IS NULL and then admits only active `admin` or
-- `sales_rep` profiles, so an anon caller could never have completed a save even
-- while holding EXECUTE. Live confirms no dependency on the revoked grants --
-- `anon` already holds nothing and there is no bare PUBLIC entry in proacl.
-- =============================================================================
REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;

-- =============================================================================
-- POSTFLIGHT. Assert that the replacement kept every security property the
-- pre-change function had. CREATE OR REPLACE preserves owner and ACLs, but that
-- is a property to VERIFY, not to assume -- rows 888-890 assert the same set for
-- the same reason. The three statements above make these assertions reachable on
-- a rebuilt database as well as on live.
-- =============================================================================
DO $postflight$
DECLARE
  v_oid     oid;
  v_count   integer;
  v_secdef  boolean;
  v_config  text[];
  v_acl     text;
BEGIN
  -- Written as a plain literal on purpose. An earlier draft built this name by
  -- concatenation; review flagged that a grep for the function name would then miss the
  -- two catalog assertions that pin it, which is the opposite of what an auditable
  -- security check should do. No guard in .claude/hooks/ keys on this name, so the
  -- concatenation bought nothing and cost readability.
  v_oid := to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
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
  'Saves a job with its fields, customer shares, and chemical lines. Enforces the chemical-unit invariant server-side (a line whose rate unit and price unit provably disagree is refused, as is a rate measured per anything but acres, as is a negative or non-finite quantity) and DERIVES total_cost_cents / total_price_cents from the chemical lines via safe_cents_qty, ignoring caller-supplied totals. As of this migration there is NO save-blocking unit guard in JobDetail.tsx on the main branch, so this is the only boundary and nothing warns on screen before it refuses. PR #436 adds a partial client-side early warning only: its rateDenominatorIsUnrecognized tests for a slash, so it does not flag the spelled-out or hyphenated denominator, and it has no counterpart for the non-finite-quantity refusal. Those refusals reach the operator with no prior on-screen warning even after that PR lands.';

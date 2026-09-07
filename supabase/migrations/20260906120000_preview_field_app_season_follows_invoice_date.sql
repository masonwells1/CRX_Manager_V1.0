-- 20260906120000_preview_field_app_season_follows_invoice_date.sql
-- CRX-SEC-001: the field-application invoice PREVIEW priced the application fee from the
-- server clock while SAVE prices it from the invoice's own season, so the per-acre rate Mason
-- approves on the Customers tab could differ from the rate he is billed. Display-only (the
-- charge itself was always correct), but he approves a number that may not be what is charged.
--
-- 20260904180000 moved BOTH save bodies onto the invoice's season and deliberately left this
-- read-only preview alone. That closed the save side and OPENED this divergence: before it,
-- both sides read the same UTC clock and agreed (while both being wrong). Two windows:
--   * ~5 hours on 2026-09-30, 7pm-midnight Chicago, when the UTC clock season has rolled over
--     but invoice_date has not; and
--   * ALL YEAR, whenever an invoice from another season is reopened -- a September 2026 invoice
--     edited in November 2026 previewed season-2027 rates against a season-2026 save.
-- The second window needs no clock edge case at all and is the larger exposure.
--
-- Signature changes (jsonb,jsonb,uuid,uuid) -> (jsonb,jsonb,uuid,uuid,date), so this DROPs the
-- old function and CREATEs the new one. DROP+CREATE rather than a second overload on purpose:
-- PostgREST resolves by named arguments, and a 4-arg and a 5-arg-with-default candidate would
-- both match a 4-argument call, so PostgREST could not choose between them and every preview
-- would fail with PGRST203 ("Could not choose the best candidate function"). Exactly one
-- signature exists before and after. Backward compatible: a 4-argument call still resolves,
-- with p_invoice_date NULL falling back to the America/Chicago business date -- which is the
-- same fallback save uses, never UTC.
--
-- The body is the live body byte-faithful (md5(prosrc) = ca33fb973d86dbf3a2788dc11fbc49a5,
-- verified against live 2026-09-06) plus four additive deltas: the p_invoice_date parameter,
-- four declares, the season setup after derive_customer_shares_from_fields, and the
-- customer_application_rates lookup binding to v_price_season instead of current_season().
-- Nothing else moves; no pricing, rounding, unit-conversion or ACL behaviour changes.
--
-- caller-analysis: preview_field_app_invoice_split :: the only live caller
--   (src/pages/FieldApplicationInvoice.tsx handlePreview) runs as an AUTHENTICATED user and is
--   updated in this same change to pass the transaction date already on screen -- the identical
--   value it already sends to save_field_app_invoice. The live grant posture is exactly
--   authenticated:EXECUTE + service_role:EXECUTE, with NO anon and NO PUBLIC (verified against
--   information_schema.role_routine_grants on 2026-09-06). A fresh CREATE FUNCTION re-acquires
--   BOTH a default PUBLIC grant and, under Supabase's ALTER DEFAULT PRIVILEGES, an explicit
--   anon grant -- the exact regression 20260624030000 had to correct out-of-band after
--   20260624020000 did this same DROP+CREATE. REVOKE ALL FROM PUBLIC does NOT remove the
--   explicit anon grant, so both revokes below are required to restore the live posture. They
--   remove no access the function had; only the would-be-new PUBLIC/anon grants are stripped.

-- PREFLIGHT. The header above claims the live body hashes to ca33fb973d86dbf3a2788dc11fbc49a5,
-- read read-only from production on 2026-09-06. That is a comment, not a guard: if another lane
-- changed the live body between that read and this apply, DROP+CREATE would overwrite it in
-- silence, because this file re-emits the reviewed body verbatim plus four deltas. Pin it in the
-- same transaction that replaces it. Same shape as the sibling 20260904180000 on this code path.
DO $preflight$
DECLARE
  v_count int;
  v_src   text;
  v_owner text;
  v_nargs int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING: public.preview_field_app_invoice_split does not exist, so this migration would CREATE a function where a reviewed one is supposed to be replaced. Investigate before applying.';
  END IF;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload before replacement, found % -- callers are already split and the DROP list in this file is incomplete.', v_count;
  END IF;

  SELECT p.prosrc, p.proowner::regrole::text, p.pronargs
    INTO v_src, v_owner, v_nargs
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';

  -- The owner is pinned to postgres, and it is NOT a cosmetic pin. CREATE OR REPLACE keeps the
  -- owner; DROP + CREATE assigns the new function to whichever role runs the migration. This body
  -- does SELECT * FROM application_services at the v_app_service lookup below, and
  -- 20260729015706_application_service_cost_admin_only revoked SELECT on that table from
  -- authenticated and re-granted only the non-cost columns -- its own comment states the revoke is
  -- safe ONLY because every function reading the table is SECURITY DEFINER owned by postgres, and
  -- names this function as the case a bare SELECT * would otherwise break. So a re-owned function
  -- either fails every preview with "permission denied for column cost_per_acre_cents", or, if the
  -- new owner is more privileged, widens a SECDEF read surface past what the 2026-07-28 ACL audit
  -- signed off on. Neither is acceptable silently. Fail closed instead.
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION
      'PREFLIGHT_OWNER: preview_field_app_invoice_split is owned by %, not postgres. DROP+CREATE re-owns it to the applying role, which changes this SECURITY DEFINER function''s effective privileges over application_services. Investigate before applying.', v_owner;
  END IF;

  IF v_nargs = 5 THEN
    -- Replay: the candidate is already installed, so the 4-argument body pin below describes a
    -- predecessor that no longer exists and cannot match. The end state is still fully asserted --
    -- the postflight pins the INSTALLED body md5 as well as the signature, owner, SECDEF,
    -- search_path and ACL, so a replay over a body another lane had patched is refused there
    -- rather than silently overwritten. Do not weaken that postflight pin on the assumption this
    -- preflight covers the body: on this path it does not.
    RAISE NOTICE 'PREFLIGHT_OK: the 5-argument candidate is already installed; this apply is a replay.';
    RETURN;
  END IF;

  IF v_nargs <> 4 THEN
    RAISE EXCEPTION
      'PREFLIGHT_SIGNATURE: expected either the 4-argument predecessor or the 5-argument candidate, found % arguments.', v_nargs;
  END IF;

  IF md5(v_src) <> 'ca33fb973d86dbf3a2788dc11fbc49a5' THEN
    RAISE EXCEPTION
      'PREFLIGHT_BODY_DRIFT: live body md5 is %, not the reviewed pin ca33fb973d86dbf3a2788dc11fbc49a5. Applying over a drifted body would silently revert whatever changed it. Diff and re-review before applying.', md5(v_src);
  END IF;

  RAISE NOTICE 'PREFLIGHT_OK: preview body matches the reviewed pin and the function is postgres-owned; the replacement may proceed.';
END
$preflight$;

-- Both signatures are dropped so the file is safe to replay. Dropping only the 4-argument
-- one makes a SECOND apply -- a cold rebuild, or a retried apply -- fail with "function
-- already exists with same argument types", because by then the installed function is the
-- 5-argument one and the single DROP silently skips. Caught by PHASE 5 of
-- scripts/smoke/prove-preview-field-app-season.mjs, not by inspection. Dropping both also
-- makes "exactly one signature exists afterwards" unconditional rather than a claim about
-- the starting state.
-- The legacy 3-argument signature is dropped too. Live evidence says it is already gone --
-- 20260624020000 dropped it, and that apply is recorded in the baseline ledger at
-- supabase/baselines/20260727174805_migration_history.sql as version 20260624123816 -- so on
-- production this line is a no-op, and in fact it can ONLY ever be a no-op: if a 3-argument
-- signature had survived, the preflight's overload count would be 2 and the apply would already
-- have aborted at PREFLIGHT_OVERLOAD before reaching any DROP. It is kept as documentation of the
-- full known lineage. What actually guarantees "exactly one signature afterwards" is the
-- postflight's count, which is read from the catalog rather than assumed from this list.
DROP FUNCTION IF EXISTS public.preview_field_app_invoice_split(jsonb, jsonb, uuid);
DROP FUNCTION IF EXISTS public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid);
DROP FUNCTION IF EXISTS public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date);

CREATE FUNCTION public.preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL::uuid, p_invoice_id uuid DEFAULT NULL::uuid, p_invoice_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field_ids         uuid[];
  v_applied_acres_map jsonb := '{}'::jsonb;
  v_loc               jsonb;
  v_shares            jsonb;
  v_customers         jsonb;
  v_customer          jsonb;
  v_customer_id       uuid;
  v_customer_tier     int;
  v_app_service       record;
  v_per_customer      jsonb := '[]'::jsonb;
  v_customer_lines    jsonb;
  v_grand_total       bigint := 0;
  v_chem              jsonb;
  v_share_row         jsonb;
  v_chem_qty_a        numeric;
  v_chem_qty_b        numeric;
  v_share_acres       numeric;
  v_field_override    bigint;
  v_unit_price        bigint;
  v_qi_price          numeric;
  v_extended          bigint;
  v_fee_rate          bigint;
  v_fee_acres         numeric;
  v_fee_extended      bigint;
  v_customer_total    bigint;
  v_rate              numeric;
  v_ta_unit           text;       -- PARKED-010: rate unit of the applied amount
  v_inv_unit          text;       -- PARKED-010: product's sold/pricing unit
  v_form              text;       -- PARKED-010: product_form (liquid/dry)
  v_priced_qty        numeric;    -- PARKED-010: applied qty converted into the pricing unit
  v_group_id          uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_surcharge_acres   numeric;
  v_surcharge_cents   bigint;
  v_customer_count    int;        -- CRX-SEC-001: mirrors save's single-customer test
  v_new_season        integer;    -- CRX-SEC-001: season a NOT-YET-SAVED invoice would be filed under
  v_row_season        integer;    -- CRX-SEC-001: season an ALREADY-SAVED member carries
  v_price_season      integer;    -- CRX-SEC-001: the season the fee is actually priced at
BEGIN
  -- PARKED-007 (codex-driven cycle 5 #1 HIGH): in-body role gate — without it
  -- ANY authenticated role (applicator, driver, etc.) can call this SECDEF
  -- function with arbitrary field_ids and receive private customer pricing
  -- and split detail. RLS doesn't apply (we're SECDEF), the EXECUTE grant to
  -- `authenticated` widens beyond billing roles. Mirrors the save side's gate.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can preview field-app invoice splits'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(
      v_loc->>'field_id',
      GREATEST(COALESCE((v_loc->>'applied_acres')::numeric, 0), 0)
    );
  END LOOP;

  IF v_field_ids IS NULL THEN
    RETURN jsonb_build_object('per_customer', '[]'::jsonb, 'grand_total_cents', 0, 'customer_count', 0);
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  -- CRX-SEC-001 (2026-09-06): counted BEFORE the deleted-member skip, exactly like save's
  -- v_customer_count, because save's single-customer branch tests the DERIVED list.
  v_customer_count := jsonb_array_length(v_customers);
  -- The season a customer WITHOUT an existing invoice would be filed under. Same expression
  -- and same America/Chicago fallback as _save_field_app_invoice_impl_20260714's v_season, so
  -- a preview and the save it precedes cannot land on different sides of October 1.
  v_new_season := compute_season(COALESCE(p_invoice_date, (now() AT TIME ZONE 'America/Chicago')::date));

  IF p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_group_id FROM invoices WHERE id = p_invoice_id;
    IF v_group_id IS NOT NULL THEN
      SELECT COALESCE(array_agg(DISTINCT d.customer_id), '{}') INTO v_skipped_customer_ids
        FROM invoices d
       WHERE d.invoice_group_id = v_group_id
         AND d.deleted_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM invoices l
            WHERE l.invoice_group_id = v_group_id
              AND l.customer_id = d.customer_id
              AND l.deleted_at IS NULL
         );
    END IF;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id    := (v_customer->>'customer_id')::uuid;
    IF v_customer_id = ANY(v_skipped_customer_ids) THEN CONTINUE; END IF;
    v_customer_tier  := COALESCE((v_customer->>'tier')::int, 1);
    v_customer_total := 0;
    v_customer_lines := '[]'::jsonb;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'customer_id')::uuid = v_customer_id
        AND (value->>'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres    := (v_share_row->>'share_acres')::numeric;
      v_field_override := (v_share_row->>'price_override_cents')::bigint;
      v_extended := ROUND(v_field_override * v_share_acres)::bigint;
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'grower_share',
        'description', (v_share_row->>'field_name') || ' grower share @ $' ||
                       (v_field_override / 100.0)::numeric(12,2) || '/ac',
        'quantity', v_share_acres,
        'unit_price_cents', v_field_override,
        'extended_cents', v_extended
      );
      v_customer_total := v_customer_total + v_extended;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);
      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value->>'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      IF v_chem_qty_b > 0 THEN
        v_unit_price := NULL;
        IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
           AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
          v_unit_price := (v_chem->>'unit_price_cents')::bigint;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
            JOIN quote_sections qs ON qs.id = qi.section_id
           WHERE qi.product_id = (v_chem->>'product_id')::uuid
             AND qs.field_id   = ANY(v_field_ids)
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN v_unit_price := ROUND(v_qi_price * 100)::bigint; END IF;
        END IF;
        IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
          SELECT CASE v_customer_tier
            WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
            WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
            WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
            ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
          END INTO v_unit_price FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_unit_price := COALESCE(v_unit_price, 0);

        -- PARKED-010 (preview parity with save_field_app_invoice): the applied amount is in the
        -- RATE unit but v_unit_price is per the product's SOLD unit; convert before pricing so this
        -- on-page customer-split preview shows the same dollars the saved invoice will (not ~128x).
        v_ta_unit  := COALESCE(NULLIF(v_chem->>'rate_unit', ''), NULLIF(v_chem->>'unit_size', ''));
        v_inv_unit := NULL;
        v_form     := NULL;
        IF (v_chem->>'product_id') IS NOT NULL THEN
          SELECT p.inventory_unit, p.product_form::text INTO v_inv_unit, v_form
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;
        v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
        -- Unconvertible units (save blocks with FIELD_APP_UNIT_UNCONVERTIBLE): preview the line at
        -- $0 rather than the old ~128x figure or crashing the preview.
        v_priced_qty := CASE WHEN v_priced_qty IS NULL THEN 0 ELSE ROUND(v_priced_qty, 4) END;
        v_extended := ROUND(v_unit_price * v_priced_qty)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'chemical', 'description', v_chem->>'description',
          'quantity', v_priced_qty,
          'unit_price_cents', v_unit_price, 'extended_cents', v_extended
        );
        v_customer_total := v_customer_total + v_extended;
      END IF;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      -- CRX-SEC-001: resolve the season THIS customer's invoice is (or would be) filed under,
      -- reproducing _save_field_app_invoice_impl_20260714's branch order exactly:
      --   1. an existing live member of the group  -> that row's stored season
      --   2. a single-customer edit of p_invoice_id -> that row's stored season
      --   3. otherwise (a new invoice)              -> compute_season(invoice date)
      -- Save never re-seasons an existing invoice (DECISION_LOG 2026-09-04), so branches 1
      -- and 2 must read the STORED season rather than recompute one.
      --
      -- v_row_season is reset at the top of every iteration. The hazard is not the SELECT INTO
      -- itself -- PL/pgSQL assigns NULL to the target when the query returns no row -- it is the
      -- IF/ELSIF below, which can take NEITHER branch (no group, and either no p_invoice_id or a
      -- multi-customer split). In that case nothing assigns v_row_season at all and, without this
      -- reset, it would still hold the PREVIOUS customer's season and price this customer's fee
      -- against the wrong year. The reset makes branch 3 reachable rather than inherited.
      --
      -- COALESCE treats "no row found" and "row found with a NULL season" the same way, falling
      -- through to the computed season where save would instead match no rate row and use the
      -- service default. That divergence cannot occur today because invoices.season is NOT NULL
      -- with a default; if that constraint is ever relaxed, this line must be revisited.
      v_row_season := NULL;
      IF v_group_id IS NOT NULL THEN
        SELECT i.season INTO v_row_season
          FROM invoices i
         WHERE i.invoice_group_id = v_group_id
           AND i.customer_id      = v_customer_id
           AND i.deleted_at IS NULL
         LIMIT 1;
      ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
        SELECT i.season INTO v_row_season FROM invoices i WHERE i.id = p_invoice_id;
      END IF;
      v_price_season := COALESCE(v_row_season, v_new_season);

      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id = v_customer_id
         AND car.application_service_id = p_application_service_id
         AND car.season = v_price_season LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;
      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;
      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := ROUND(v_fee_rate * v_fee_acres)::bigint;
        v_customer_lines := v_customer_lines || jsonb_build_object(
          'kind', 'service_fee', 'description', v_app_service.name,
          'quantity', v_fee_acres, 'unit_price_cents', v_fee_rate,
          'extended_cents', v_fee_extended
        );
        v_customer_total := v_customer_total + v_fee_extended;
      END IF;
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_customer_total);

    IF v_surcharge_cents > 0 THEN
      v_customer_lines := v_customer_lines || jsonb_build_object(
        'kind', 'fuel_surcharge', 'description', 'Fuel Surcharge',
        'quantity', 1, 'unit_price_cents', v_surcharge_cents,
        'extended_cents', v_surcharge_cents
      );
      v_customer_total := v_customer_total + v_surcharge_cents;
    END IF;

    v_per_customer := v_per_customer || jsonb_build_object(
      'customer_id',   v_customer_id,
      'customer_name', v_customer->>'customer_name',
      'is_primary',    COALESCE((v_customer->>'is_primary')::boolean, false),
      'tier',          v_customer_tier,
      'total_cents',   v_customer_total,
      'lines',         v_customer_lines
    );
    v_grand_total := v_grand_total + v_customer_total;
  END LOOP;

  RETURN jsonb_build_object(
    'per_customer',      v_per_customer,
    'grand_total_cents', v_grand_total,
    'customer_count',    jsonb_array_length(v_per_customer),
    'shares_detail',     v_shares
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid, date) TO authenticated, service_role;

-- POSTFLIGHT. Every property this file depends on, re-read from the catalog after the replacement
-- rather than assumed from the statements above. The container prover asserts the same set, but the
-- prover runs against a rebuilt database; this block is the only check that runs against LIVE.
DO $postflight$
DECLARE
  v_oid      oid;
  v_count    int;
  v_owner    text;
  v_secdef   boolean;
  v_config   text;
  v_body_md5 text;
  v_signature text;
  v_has_anon boolean;
  v_has_pub  boolean;
  v_has_auth boolean;
  v_has_svc  boolean;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_OVERLOAD: expected exactly 1 signature after replacement, found %. Two candidates make every PostgREST call ambiguous (PGRST203), and a preview could resolve against a stale, unrevoked signature.', v_count;
  END IF;

  SELECT p.oid,
         p.proowner::regrole::text,
         p.prosecdef,
         COALESCE(array_to_string(p.proconfig, ','), '<none>'),
         md5(p.prosrc),
         p.oid::regprocedure::text
    INTO v_oid, v_owner, v_secdef, v_config, v_body_md5, v_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'preview_field_app_invoice_split';

  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION
      'POSTFLIGHT_OWNER: the replacement is owned by %, not postgres. See the preflight comment -- the column-level revoke on application_services.cost_per_acre_cents depends on this function being a postgres-owned SECURITY DEFINER.', v_owner;
  END IF;

  -- Counting signatures is not the same as checking WHICH signature. An edit that dropped
  -- p_invoice_date from the CREATE would leave the count at 1 and the body md5 unchanged, so
  -- every other check here would pass while the frontend got PGRST202 on every Preview -- the
  -- exact outage this migration exists to make impossible. Assert the identity, not the count.
  IF v_signature <> 'preview_field_app_invoice_split(jsonb,jsonb,uuid,uuid,date)' THEN
    RAISE EXCEPTION
      'POSTFLIGHT_SIGNATURE: the replacement installed %, not the 5-argument signature the frontend calls. Preview would fail with PGRST202 for every operator.', v_signature;
  END IF;

  IF NOT v_secdef THEN
    RAISE EXCEPTION
      'POSTFLIGHT_NOT_SECURITY_DEFINER: the replacement dropped SECURITY DEFINER, so it can no longer read the pricing tables its callers are gated out of.';
  END IF;

  -- Exact string, not a substring test. A substring test would accept
  -- search_path=notpublic_evil, pg_temp, and would also accept an entry PREPENDED before public,
  -- which is the whole attack a pinned search_path exists to stop.
  IF v_config <> 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION
      'POSTFLIGHT_SEARCH_PATH: expected exactly search_path=public, pg_temp; found %.', v_config;
  END IF;

  -- The installed body is pinned here rather than only in the preflight, so BOTH paths are
  -- covered. The preflight's pin describes the 4-argument predecessor and is skipped on a replay;
  -- without this line a replay would silently overwrite a 5-argument body another lane had
  -- patched -- the exact failure the preflight exists to prevent, on the other path.
  IF v_body_md5 <> '83f6600412ced085d0876a3c7339ff12' THEN
    RAISE EXCEPTION
      'POSTFLIGHT_BODY: the installed body hashes to %, not this file''s candidate pin 83f6600412ced085d0876a3c7339ff12. Either the file was edited without updating this pin, or a CRLF smudge put CR bytes in the body -- see the .gitattributes entry for this file.', v_body_md5;
  END IF;

  -- Grants are read from the catalog, not inferred from the REVOKE/GRANT statements above. This is
  -- the check that matters most in this file: a fresh CREATE re-acquires a PUBLIC grant AND, under
  -- Supabase's ALTER DEFAULT PRIVILEGES, an explicit anon grant -- and REVOKE ALL FROM PUBLIC does
  -- not remove the latter. That exact regression is why 20260624030000 had to be written out of
  -- band after 20260624020000 did this same DROP+CREATE on this same function.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND proacl IS NOT NULL) THEN
    RAISE EXCEPTION
      'POSTFLIGHT_ACL_DEFAULT: the function carries a NULL ACL, which means default privileges apply and PUBLIC holds EXECUTE. The REVOKE statements did not take effect.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE' AND a.grantee = 0),
         EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
                    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')),
         EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
                    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')),
         EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
                    AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'service_role'))
    INTO v_has_pub, v_has_anon, v_has_auth, v_has_svc;

  IF v_has_pub THEN
    RAISE EXCEPTION
      'POSTFLIGHT_GRANT_PUBLIC: PUBLIC still holds EXECUTE on the replacement; every role in the database could price an invoice.';
  END IF;

  IF v_has_anon THEN
    RAISE EXCEPTION
      'POSTFLIGHT_GRANT_ANON: anon still holds EXECUTE on the replacement. This is the 20260624020000 regression repeating -- an unauthenticated caller could reach a SECURITY DEFINER pricing read.';
  END IF;

  IF NOT v_has_auth THEN
    RAISE EXCEPTION
      'POSTFLIGHT_GRANT_LOST: authenticated no longer holds EXECUTE, so the Preview button on the field-application invoice screen would fail for every operator.';
  END IF;

  IF NOT v_has_svc THEN
    RAISE EXCEPTION
      'POSTFLIGHT_GRANT_LOST: service_role no longer holds EXECUTE.';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: one postgres-owned SECURITY DEFINER signature with a pinned search_path; EXECUTE held by authenticated and service_role only.';
END
$postflight$;

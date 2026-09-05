-- NOT APPLIED — DO NOT APPLY without Mason's explicit in-chat approval.
-- Commission dates follow the source document's business date, never the UTC clock.
-- idempotency-body-check: exempt
-- The two re-emitted INSERT helpers are owner-only SECURITY INVOKER internals.
-- Their already-authorized SECURITY DEFINER callers own the operation-level
-- idempotency boundary; exposing a second key here would split one business
-- operation across two unrelated replay caches.
--
-- ############################################################################
-- PARTIAL FIX — THIS DOES NOT CLOSE THE SEPTEMBER 30 RISK ON ITS OWN.
--
-- This migration makes a commission inherit its DOCUMENT's date. On four of the
-- five broken paths that document is ITSELF stamped from the UTC clock, so the
-- inherited date is still wrong. Confirmed against live pg_proc.prosrc on
-- 2026-09-05:
--
--   _draw_down_quote_below_cost_impl_20260810    order_date   = current_date
--   _create_quick_delivery_intent_impl_20260802  order_date   = CURRENT_DATE
--   transfer_job_to_invoice                      invoice_date = CURRENT_DATE
--   _convert_quote_to_order_owner_impl           same INSERT shape as the drawdown
--   _save_field_app_split_invoice_impl           Chicago — genuinely fixed by this
--
-- This change is NECESSARY but NOT SUFFICIENT. It is the correct semantics, and
-- without it a writer-side fix would still leave commissions free to drift from
-- their documents. Closing the risk additionally requires converting those four
-- document-date writers. DO NOT record September 30 as closed until that lands.
--
-- Related live defect, NOT fixed here: transfer_job_to_invoice stamps the INVOICE
-- itself from UTC. 20260904160000 converted four invoice-dating functions to
-- Chicago and this was not one of them, so a field-application invoice raised on
-- a Chicago evening is dated tomorrow — affecting its season, due date and aging,
-- not only its commission.
-- ############################################################################
--
-- WHY THIS EXISTS
-- ---------------
-- Crop RX's business day is America/Chicago; the database clock is UTC. Between UTC
-- midnight and Chicago midnight (7pm Chicago under CDT, 6pm under CST) the server's
-- CURRENT_DATE is ALREADY TOMORROW in business terms.
--
-- 20260904160000_invoice_date_fallbacks_chicago converted invoice_date for exactly this
-- reason, and 20260904180000 made the season follow the invoice date. The commission
-- side was never converted, so the two now DISAGREE. An invoice raised at 8pm Chicago
-- on September 30 is dated 2026-09-30 (correct); the commission it creates is stamped
-- 2026-10-01. Three consequences, all real money:
--
--   * the commission drops out of September 30 commission history — the snapshot
--     report filters `s.order_date <= p_as_of_date`;
--   * a September 30 payout is REFUSED outright by
--     validate_commission_payment_item_history, which raises
--     COMMISSION_SETTLEMENT_PAYMENT_DATE_BEFORE_ORDER when payment_date precedes the
--     commission's order_date;
--   * the commission lands in the wrong CROP SEASON, because the season rolls at
--     October 1 — the single worst night of the year for this defect.
--
-- WHERE THE DEFECT ACTUALLY LIVES
-- -------------------------------
-- Enumerated from the LIVE catalog, not from the migration files (which do not reflect
-- later replacements). EIGHT call sites feed the two commission-creating helpers:
--
--   pass the source document's own date (CORRECT):
--     _bulk_import_order_below_cost_impl_20260810      p_order_date
--     _create_direct_order_below_cost_impl_20260810    p_order_date
--     _price_order_below_cost_impl_20260810            v_order.order_date
--
--   pass the server's UTC CURRENT_DATE (THE DEFECT):
--     _convert_quote_to_order_owner_impl               1 site
--     _draw_down_quote_below_cost_impl_20260810        1 site
--     _create_quick_delivery_intent_impl_20260802      1 site
--     _save_field_app_split_invoice_impl               1 site
--     transfer_job_to_invoice                          2 sites
--
-- Read that list again and the real bug is visible: the five broken callers are not
-- "using the wrong timezone", they are passing WHEN THE CODE RAN in place of WHAT THE
-- DOCUMENT IS DATED. The three correct callers already pass the document's date. So
-- the fix belongs at the point of insertion, not spread across five large callers.
--
-- WHAT IS CHANGED
-- ---------------
-- The two helpers stop trusting the caller's date and DERIVE it from the record the
-- commission actually belongs to:
--
--   _insert_commissions_for_order  ->  public.orders.order_date   for p_order_id
--   _insert_commissions_for_job    ->  public.invoices.invoice_date for p_invoice_id
--
-- For the three correct callers this is a no-op: the value they pass IS the document's
-- date, so the derived value is identical. For the five broken callers it replaces a
-- UTC timestamp with the document's own business date. Any FUTURE caller that passes a
-- careless date is corrected too, which a per-caller fix would not achieve.
--
-- invoices.invoice_date is already the America/Chicago business date as of
-- 20260904160000, so the job path inherits a correct date rather than re-deriving one.
--
-- The caller's date is retained as a FALLBACK, used only when the source row cannot be
-- read (it is looked up by primary key, so in practice only if the row is absent). A
-- final Chicago fallback guarantees the NOT NULL column is satisfied and that the
-- ledger's COMMISSION_HISTORY_ORDER_DATE_REQUIRED can never fire because of this path.
--
-- The parameter DEFAULTs and the orders.order_date column DEFAULT also move off UTC,
-- so an order created without an explicit date no longer seeds a UTC date that
-- _price_order_below_cost_impl_20260810 would later read back and propagate.
--
-- NOT DESTRUCTIVE: no row is deleted, no column dropped, and NO EXISTING COMMISSION IS
-- RE-DATED. This changes only how future commission dates are derived. Historical rows
-- keep the dates they were given; correcting those, if wanted, is a separate decision.
--
-- FAIL-CLOSED: both helper bodies are pinned by md5, read read-only from production on
-- 2026-09-05. If either has drifted at apply time this migration aborts and changes
-- nothing, rather than replacing a body it never inspected. Re-pin deliberately after
-- reading the new body; never widen the check to make it pass.
--
-- ATOMICITY IS THE APPLY PATH'S, NOT THIS FILE'S. Do NOT add a top-level BEGIN;/COMMIT;
-- here. scripts/apply-migration-file.mjs wraps the migration AND its schema_migrations
-- ledger row in ONE transaction so they commit together; a file that opens its own
-- transaction breaks that pairing and is hard-refused by assertWrappable() in
-- .claude/hooks/migration-wrappability-lib.mjs, leaving the file with no delivery route
-- at all. Every RAISE EXCEPTION below still aborts the whole apply — the wrapper's
-- transaction rolls it back, and no ledger row is written.

-- ---------------------------------------------------------------------------
-- Preflight. Refuse on drift, on a missing function, or on an unexpected overload.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  r record;
  -- TWO accepted bodies per helper: the pre-image this migration converts, and the
  -- post-image it produces. Pinning only the pre-image made the migration abort on its
  -- OWN output — fail-closed, but a re-run (a retried apply, a replay, a rebuild that
  -- reaches this file twice) would stop the whole run with PREFLIGHT_DRIFT and read as a
  -- real drift incident. Proven by scripts/smoke/prove-commission-dates-chicago.mjs
  -- PHASE 5, which is why the post-image hashes are measured, not guessed.
  --
  --   ...order: 9f1a3c7a pre-image (live + clean-rebuild)  541fb0f7 post-image
  --   ...job:   c23fd25c pre-image (live + clean-rebuild)  f11b71fa post-image
  --
  -- The postflight below is what actually proves the conversion happened; these pins
  -- only decide WHICH bodies this migration is willing to touch.
  v_expected constant jsonb := jsonb_build_object(
    '_insert_commissions_for_order',
      jsonb_build_array('9f1a3c7af994b768bb0a76debc186350', '541fb0f707fcf1a8608c8af50944faff'),
    '_insert_commissions_for_job',
      jsonb_build_array('c23fd25cf213da9ee832a1764369ac77', 'f11b71fa3de558618c27ff02cb734b15')
  );
  v_seen int := 0;
BEGIN
  FOR r IN
    SELECT p.proname, md5(p.prosrc) AS src_md5, p.prosecdef, p.proconfig, p.procost,
           p.provolatile, p.proowner::regrole::text AS owner,
           count(*) OVER (PARTITION BY p.proname) AS overloads
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_insert_commissions_for_order', '_insert_commissions_for_job')
  LOOP
    v_seen := v_seen + 1;

    IF r.overloads <> 1 THEN
      RAISE EXCEPTION
        'PREFLIGHT_OVERLOAD: public.% has % overloads; this migration replaces a single signature and must not guess which one carries the commission date.',
        r.proname, r.overloads;
    END IF;

    IF NOT ((v_expected -> r.proname) ? r.src_md5) THEN
      RAISE EXCEPTION
        'PREFLIGHT_DRIFT: public.% body md5 is %, which is neither body this migration accepts (%). The helper changed after this migration was authored. Re-read the current body, confirm the date argument is still the only thing needing conversion, then re-pin.',
        r.proname, r.src_md5, (v_expected -> r.proname)::text;
    END IF;

    -- These are SECURITY INVOKER by design: they run with the caller's rights inside
    -- an already-authorised SECURITY DEFINER RPC. Re-emitting must not silently
    -- promote them.
    IF r.prosecdef THEN
      RAISE EXCEPTION 'PREFLIGHT_SECDEF: public.% is unexpectedly SECURITY DEFINER; refusing to re-emit.', r.proname;
    END IF;

    IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
      RAISE EXCEPTION 'PREFLIGHT_SEARCH_PATH: public.% has search_path %, expected {search_path=public, pg_temp}.',
        r.proname, COALESCE(r.proconfig::text, '(null)');
    END IF;

    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'PREFLIGHT_OWNER: public.% is owned by %, expected postgres.', r.proname, r.owner;
    END IF;
  END LOOP;

  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_MISSING: expected both commission helpers, found %.', v_seen;
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- Order-sourced commissions: date follows the ORDER.
-- Re-emitted in full and explicitly; the only change from the pinned body is the
-- resolved date (and the parameter default moving off UTC).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id uuid, p_customer_id uuid, p_order_profit numeric,
  p_commission_split jsonb,
  p_order_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
  v_order_date date;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

  -- The commission belongs to the ORDER, so it carries the order's business date --
  -- not the moment this code happened to run. Several callers pass CURRENT_DATE,
  -- which is the UTC calendar day and is already TOMORROW during a Chicago evening;
  -- on September 30 that also moves the crop season. The caller's value is kept only
  -- as a fallback for an unreadable order row, and the Chicago expression guarantees
  -- the NOT NULL column is satisfied.
  SELECT o.order_date INTO v_order_date
    FROM public.orders o
   WHERE o.id = p_order_id;

  v_order_date := COALESCE(v_order_date, p_order_date, (now() AT TIME ZONE 'America/Chicago')::date);

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  WITH split_rows AS (
    SELECT
      s,
      ord,
      row_number() OVER (ORDER BY ord) AS rn,
      count(*) OVER () AS split_count,
      s->>'recipient' AS recipient,
      NULLIF(btrim(s->>'recipient_user_id'), '')::uuid AS split_user_id,
      (s->>'percentage')::numeric AS percentage
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
    WHERE (NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
           OR NULLIF(btrim(s->>'recipient_user_id'), '') IS NOT NULL)
      AND (s->>'percentage')::numeric > 0
  ),
  calculated AS (
    SELECT
      sr.*,
      COALESCE(
        (SELECT p.id FROM public.profiles p
          WHERE p.id = sr.split_user_id AND p.is_active = true),
        (SELECT p.id FROM public.profiles p
          WHERE lower(trim(p.full_name)) = lower(trim(sr.recipient))
            AND p.is_active = true
            AND (SELECT count(*) FROM public.profiles p2
                  WHERE lower(trim(p2.full_name)) = lower(trim(sr.recipient))
                    AND p2.is_active = true) = 1
          LIMIT 1)
      ) AS resolved_user_id,
      CASE
        WHEN sr.rn = sr.split_count THEN
          GREATEST(ROUND(COALESCE(p_order_profit, 0), 2), 0)
          - COALESCE(
              SUM(public.compute_commission_amount(p_order_profit, sr.percentage))
                OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
              0
            )
        ELSE public.compute_commission_amount(p_order_profit, sr.percentage)
      END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT
    p_order_id,
    p_customer_id,
    COALESCE(
      (SELECT p.full_name FROM public.profiles p WHERE p.id = c.resolved_user_id),
      c.recipient
    ),
    c.resolved_user_id,
    c.percentage,
    c.reconciled_amount,
    COALESCE(p_order_profit, 0),
    v_order_date,
    'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Job-sourced commissions: date follows the INVOICE.
-- invoices.invoice_date is already the America/Chicago business date as of
-- 20260904160000, so this inherits a correct date rather than re-deriving one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._insert_commissions_for_job(
  p_job_id uuid, p_invoice_id uuid, p_customer_id uuid, p_profit numeric,
  p_commission_split jsonb,
  p_commission_date date DEFAULT (now() AT TIME ZONE 'America/Chicago')::date)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
  v_commission_date date;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

  -- The commission belongs to the INVOICE this job was transferred onto, so it
  -- carries the invoice's business date. Both live callers (transfer_job_to_invoice
  -- and _save_field_app_split_invoice_impl) pass CURRENT_DATE, which is the UTC
  -- calendar day and is already tomorrow during a Chicago evening.
  SELECT i.invoice_date INTO v_commission_date
    FROM public.invoices i
   WHERE i.id = p_invoice_id;

  v_commission_date := COALESCE(v_commission_date, p_commission_date, (now() AT TIME ZONE 'America/Chicago')::date);

  INSERT INTO public.commissions (
    job_id, invoice_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  WITH split_rows AS (
    SELECT
      s, ord,
      row_number() OVER (ORDER BY ord) AS rn,
      count(*) OVER () AS split_count,
      s->>'recipient' AS recipient,
      NULLIF(btrim(s->>'recipient_user_id'), '')::uuid AS split_user_id,
      (s->>'percentage')::numeric AS percentage
    FROM jsonb_array_elements(p_commission_split->'splits') WITH ORDINALITY AS e(s, ord)
    WHERE (NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
           OR NULLIF(btrim(s->>'recipient_user_id'), '') IS NOT NULL)
      AND (s->>'percentage')::numeric > 0
  ),
  calculated AS (
    SELECT sr.*,
      COALESCE(
        (SELECT p.id FROM public.profiles p
          WHERE p.id = sr.split_user_id AND p.is_active = true),
        (SELECT p.id FROM public.profiles p
          WHERE lower(trim(p.full_name)) = lower(trim(sr.recipient))
            AND p.is_active = true
            AND (SELECT count(*) FROM public.profiles p2
                  WHERE lower(trim(p2.full_name)) = lower(trim(sr.recipient))
                    AND p2.is_active = true) = 1
          LIMIT 1)
      ) AS resolved_user_id,
      CASE WHEN sr.rn = sr.split_count THEN
          GREATEST(ROUND(COALESCE(p_profit, 0), 2), 0)
          - COALESCE(SUM(public.compute_commission_amount(p_profit, sr.percentage))
              OVER (ORDER BY sr.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
        ELSE public.compute_commission_amount(p_profit, sr.percentage)
      END AS reconciled_amount
    FROM split_rows sr
  )
  SELECT p_job_id, p_invoice_id, p_customer_id,
    COALESCE(
      (SELECT p.full_name FROM public.profiles p WHERE p.id = c.resolved_user_id),
      c.recipient
    ),
    c.resolved_user_id,
    c.percentage, c.reconciled_amount, COALESCE(p_profit, 0), v_commission_date, 'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The column default that seeds a UTC date onto any order created without an
-- explicit one. _price_order_below_cost_impl_20260810 reads v_order.order_date back
-- out and hands it to the helper above, so leaving this on UTC would re-open the
-- defect through the deferred-pricing path.
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
  ALTER COLUMN order_date SET DEFAULT (now() AT TIME ZONE 'America/Chicago')::date;

-- ---------------------------------------------------------------------------
-- Postflight. Prove the replacement did what the header claims, and that
-- CREATE OR REPLACE did not silently normalise an attribute.
-- ---------------------------------------------------------------------------
DO $postflight$
DECLARE
  r record;
  v_default text;
  v_seen int := 0;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc, p.prosecdef, p.proconfig, p.prorettype::regtype::text AS rettype,
           p.proowner::regrole::text AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_insert_commissions_for_order', '_insert_commissions_for_job')
  LOOP
    v_seen := v_seen + 1;

    -- These assert the PREMISE of the migration — that the date is DERIVED from the
    -- source document — rather than probing for a formatting accident. An earlier
    -- draft checked `position('    p_order_date,' ...)`, which depends on the INSERT
    -- list's exact indentation: re-indent the body and a function that genuinely
    -- writes the caller's date would have passed clean. A guard whose message claims
    -- more than it tests is worse than no guard.
    IF r.proname = '_insert_commissions_for_order' THEN
      -- 1. the derivation exists and reads the ORDER
      IF position('SELECT o.order_date INTO v_order_date' in r.prosrc) = 0
         OR position('FROM public.orders o' in r.prosrc) = 0 THEN
        RAISE EXCEPTION
          'POSTFLIGHT_DERIVATION: public._insert_commissions_for_order does not derive its date from public.orders; the whole point of this migration is absent.';
      END IF;
      -- 2. the caller's parameter survives ONLY as the COALESCE fallback. prosrc
      --    excludes the parameter list, so exactly one occurrence is expected; a
      --    second means it reached the INSERT again, whatever the indentation.
      IF (SELECT count(*) FROM regexp_matches(r.prosrc, 'p_order_date', 'g')) <> 1 THEN
        RAISE EXCEPTION
          'POSTFLIGHT_RESIDUAL: public._insert_commissions_for_order references p_order_date % times, expected exactly 1 (the COALESCE fallback). The caller-supplied date must not reach commissions.order_date.',
          (SELECT count(*) FROM regexp_matches(r.prosrc, 'p_order_date', 'g'));
      END IF;
      -- 3. the derived value is what actually gets written
      IF (SELECT count(*) FROM regexp_matches(r.prosrc, 'v_order_date', 'g')) < 4 THEN
        RAISE EXCEPTION
          'POSTFLIGHT_DERIVATION: public._insert_commissions_for_order references v_order_date fewer than 4 times (declare, SELECT INTO, COALESCE, INSERT); the derived date is not reaching the row.';
      END IF;
    END IF;

    IF r.proname = '_insert_commissions_for_job' THEN
      IF position('SELECT i.invoice_date INTO v_commission_date' in r.prosrc) = 0
         OR position('FROM public.invoices i' in r.prosrc) = 0 THEN
        RAISE EXCEPTION
          'POSTFLIGHT_DERIVATION: public._insert_commissions_for_job does not derive its date from public.invoices; the whole point of this migration is absent.';
      END IF;
      -- p_commission_date is a strict substring of nothing else here, but
      -- v_commission_date is NOT — count the caller parameter with a boundary so the
      -- two are not distinguished by a single leading character.
      IF (SELECT count(*) FROM regexp_matches(r.prosrc, '(^|[^_[:alnum:]])p_commission_date', 'g')) <> 1 THEN
        RAISE EXCEPTION
          'POSTFLIGHT_RESIDUAL: public._insert_commissions_for_job references p_commission_date % times, expected exactly 1 (the COALESCE fallback).',
          (SELECT count(*) FROM regexp_matches(r.prosrc, '(^|[^_[:alnum:]])p_commission_date', 'g'));
      END IF;
      IF (SELECT count(*) FROM regexp_matches(r.prosrc, 'v_commission_date', 'g')) < 4 THEN
        RAISE EXCEPTION
          'POSTFLIGHT_DERIVATION: public._insert_commissions_for_job references v_commission_date fewer than 4 times; the derived date is not reaching the row.';
      END IF;
    END IF;

    -- Deliberately AFTER the derivation checks: on its own this proves nothing, since
    -- a comment mentioning the zone would satisfy it.
    IF (SELECT count(*) FROM regexp_matches(r.prosrc, 'America/Chicago', 'g')) < 1 THEN
      RAISE EXCEPTION 'POSTFLIGHT_CHICAGO: public.% carries no America/Chicago conversion after replacement.', r.proname;
    END IF;

    IF r.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT_SECDEF: public.% became SECURITY DEFINER across replacement.', r.proname;
    END IF;

    IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
      RAISE EXCEPTION 'POSTFLIGHT_SEARCH_PATH: public.% lost its pinned search_path.', r.proname;
    END IF;

    IF r.rettype <> 'integer' THEN
      RAISE EXCEPTION 'POSTFLIGHT_RETTYPE: public.% returns %, expected integer.', r.proname, r.rettype;
    END IF;

    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'POSTFLIGHT_OWNER: public.% changed owner to %.', r.proname, r.owner;
    END IF;
  END LOOP;

  IF v_seen <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: expected both commission helpers after replacement, found %.', v_seen;
  END IF;

  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'order_date';

  IF v_default IS NULL OR position('America/Chicago' in v_default) = 0 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_ORDER_DATE_DEFAULT: orders.order_date default is %, expected an America/Chicago business date.',
      COALESCE(v_default, '(null)');
  END IF;
END;
$postflight$;

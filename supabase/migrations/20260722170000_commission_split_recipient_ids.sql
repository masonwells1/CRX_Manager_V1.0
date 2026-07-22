-- Durable commission routing: immutable profile UUIDs in commission_split JSON
-- (Codex push-proof follow-up to the 2026-07-22 fail-closed trio: live ledger
-- 20260722134252 reject_unresolvable_commission_recipients,
-- 20260722144121 lock_commission_identity_names,
-- 20260722150432 forbid_referenced_recipient_name_acquisition).
--
-- Splits stored as {"splits":[{"recipient":"Display Name","percentage":N}]}
-- route money by display-name string, resolved at validation/invoicing time.
-- The trio above made that fail-closed but rigid: a split-referenced name can
-- never be re-acquired (COMMISSION_RECIPIENT_NAME_RESERVED). The durable fix:
-- each split element also carries the recipient's immutable profile UUID —
--   {"recipient":"Mason Wells","recipient_user_id":"<uuid>","percentage":50}
-- — and the id, not the name, is authoritative for routing. Layers:
--   1. Backfill: stamp recipient_user_id into every stored split (preflight
--      proves every stored recipient resolves to exactly one active profile
--      first — 2026-07-22 live check: 3 names / 36 split rows, all unique).
--   2. Stamp triggers on quotes/orders/jobs.commission_split and
--      customers.default_commission_split enrich any id-less element at write
--      time (fail-closed if unresolvable), so an id-less split can never
--      exist again — even from a stale browser session that sends name-only.
--   3. validate_commission_split_json validates by id when present (active
--      profile), by unique-active name otherwise, and dedupes on the RESOLVED
--      id (catches the same person listed once by id and once by name).
--   4. _insert_commissions_for_order / _insert_commissions_for_job route by
--      the element id first, name-resolution only as legacy fallback, and
--      refresh the display name from the profile.
--   5. list_commission_recipients() now returns (id, full_name) so the
--      editor can store both.
--   6. trg_guard_recipient_name_reuse is RETIRED: with ids authoritative and
--      no id-less split able to exist (layers 1+2), acquiring an old name can
--      no longer redirect stored splits. The other trio protections stay:
--      unique-active names, admin-only name edits (20260722144121), and the
--      commissions.recipient_user_id NOT-NULL backstop trigger.

SET LOCAL lock_timeout = '5s';

-- Block concurrent writers between preflight, backfill, and guard swap while
-- still allowing reads (same posture as 20260722134252).
LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.orders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.jobs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.commissions IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_validator_hash text;
  v_bad_count integer;
BEGIN
  -- Baseline drift guard: the validator being replaced must be the exact
  -- LIVE body fetched from the catalog on 2026-07-22 (post-20260722150432
  -- ledger state; md5 of pg_proc.prosrc). A different hash means another
  -- migration got there first — stop and reconcile instead of clobbering.
  SELECT md5(p.prosrc)
    INTO v_validator_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.validate_commission_split_json(jsonb)');

  IF v_validator_hash IS DISTINCT FROM '85907c592622d8cc12aaad03372b34f8' THEN
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_BASELINE_DRIFT: %', v_validator_hash;
  END IF;

  -- Same drift pin for every other function this migration replaces or drops
  -- (drift-review H2): all md5(prosrc) values fetched from LIVE on 2026-07-22,
  -- post-20260722150432. Any mismatch = another migration touched the body
  -- since review — abort instead of clobbering.
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public._insert_commissions_for_order(uuid,uuid,numeric,jsonb,date)'))
     IS DISTINCT FROM '192d18e4fd1887bc8cc9cbfb2fa1644a' THEN
    RAISE EXCEPTION 'COMMISSION_ORDER_HELPER_BASELINE_DRIFT';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public._insert_commissions_for_job(uuid,uuid,uuid,numeric,jsonb,date)'))
     IS DISTINCT FROM '05452dbb099e31e44a45c6a82d46df58' THEN
    RAISE EXCEPTION 'COMMISSION_JOB_HELPER_BASELINE_DRIFT';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public.list_commission_recipients()'))
     IS DISTINCT FROM '1bdea0077f5e94f19750b8d64148ce0e' THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_LIST_BASELINE_DRIFT';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public.commission_recipient_resolves(text)'))
     IS DISTINCT FROM '9a19892622e213d0f25b043169d99418' THEN
    RAISE EXCEPTION 'COMMISSION_RESOLVES_HELPER_BASELINE_DRIFT';
  END IF;

  -- The guard being retired must still exist (we are the ones removing it)
  -- and carry the exact reviewed body from live 20260722150432.
  IF to_regprocedure('public._guard_recipient_name_reuse()') IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_NAME_REUSE_GUARD_ALREADY_GONE';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = to_regprocedure('public._guard_recipient_name_reuse()'))
     IS DISTINCT FROM '0b74292a2961d22ffd266b8ef25103e3' THEN
    RAISE EXCEPTION 'COMMISSION_NAME_REUSE_GUARD_BASELINE_DRIFT';
  END IF;

  -- Every stored split recipient (ALL rows, including soft-deleted quotes and
  -- cancelled orders — the backfill touches everything) must resolve to
  -- exactly one active profile, or the backfill cannot stamp a trustworthy id.
  WITH all_recips AS (
    SELECT btrim(s->>'recipient') AS recipient
      FROM public.quotes q,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
                  THEN q.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
    UNION ALL
    SELECT btrim(s->>'recipient')
      FROM public.orders o,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
                  THEN o.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
    UNION ALL
    SELECT btrim(s->>'recipient')
      FROM public.customers c,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.default_commission_split->'splits') = 'array'
                  THEN c.default_commission_split->'splits' ELSE '[]'::jsonb END
           ) s
    UNION ALL
    SELECT btrim(s->>'recipient')
      FROM public.jobs j,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
                  THEN j.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
  )
  SELECT count(*)
    INTO v_bad_count
    FROM all_recips r
   WHERE NULLIF(r.recipient, '') IS NULL
      OR (SELECT count(*) FROM public.profiles p
           WHERE lower(trim(p.full_name)) = lower(r.recipient)
             AND p.is_active = true) <> 1;

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_BACKFILL_BLOCKED: % unresolvable split recipients', v_bad_count;
  END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- Resolution helpers. SECURITY DEFINER because profiles SELECT is
-- admin-or-self and these run from invoker-rights validators/triggers; each
-- leaks only resolution facts, never profile rows.
-- ---------------------------------------------------------------------------

-- Unique-active name -> profile id (NULL when zero or ambiguous).
CREATE OR REPLACE FUNCTION public.resolve_commission_recipient_id(p_recipient text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT p.id
    FROM public.profiles p
   WHERE lower(trim(p.full_name)) = lower(btrim(p_recipient))
     AND p.is_active = true
     AND (SELECT count(*) FROM public.profiles p2
           WHERE lower(trim(p2.full_name)) = lower(btrim(p_recipient))
             AND p2.is_active = true) = 1
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.resolve_commission_recipient_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_commission_recipient_id(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_commission_recipient_id(text) TO authenticated, service_role;

-- Profile id -> active full_name (NULL when missing or inactive).
CREATE OR REPLACE FUNCTION public.commission_recipient_name_for_id(p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT p.full_name
    FROM public.profiles p
   WHERE p.id = p_id
     AND p.is_active = true;
$function$;

REVOKE ALL ON FUNCTION public.commission_recipient_name_for_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commission_recipient_name_for_id(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.commission_recipient_name_for_id(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enrichment: return the split JSON with every element stamped with its
-- resolved recipient_user_id and the profile's current display name.
-- Fail-closed: an element that cannot be resolved raises. Non-object noise
-- and shape problems pass through untouched for the validator to reject.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commission_split_with_recipient_ids(p_split jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_elems jsonb := '[]'::jsonb;
  v_e jsonb;
  v_id_txt text;
  v_rid uuid;
  v_name text;
  v_display text;
BEGIN
  IF p_split IS NULL OR p_split = 'null'::jsonb
     OR jsonb_typeof(p_split) <> 'object'
     OR jsonb_typeof(p_split->'splits') <> 'array' THEN
    RETURN p_split;
  END IF;

  FOR v_e IN SELECT value FROM jsonb_array_elements(p_split->'splits')
  LOOP
    -- Fail closed here rather than passing through for the validator: only
    -- quotes have a write-time validate trigger, so a pass-through element
    -- could persist id-less on orders/jobs/customers (it could never route
    -- money — commission creation validates — but it would decay the
    -- "every stored element carries an id" invariant). Messages match the
    -- validator's canonical wording.
    IF jsonb_typeof(v_e) <> 'object' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: each split must be an object';
    END IF;

    v_id_txt := NULLIF(btrim(v_e->>'recipient_user_id'), '');
    v_name := NULLIF(btrim(v_e->>'recipient'), '');

    IF v_id_txt IS NOT NULL THEN
      BEGIN
        v_rid := v_id_txt::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient_user_id % is not a valid uuid', v_id_txt;
      END;
      v_display := public.commission_recipient_name_for_id(v_rid);
      IF v_display IS NULL THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient_user_id % does not match an active user', v_rid;
      END IF;
    ELSIF v_name IS NOT NULL THEN
      v_rid := public.resolve_commission_recipient_id(v_name);
      IF v_rid IS NULL THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient % does not match exactly one active user', v_name;
      END IF;
      v_display := public.commission_recipient_name_for_id(v_rid);
    ELSE
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient is required';
    END IF;

    v_elems := v_elems || jsonb_build_array(
      v_e || jsonb_build_object('recipient_user_id', v_rid::text, 'recipient', v_display)
    );
  END LOOP;

  RETURN jsonb_set(p_split, '{splits}', v_elems);
END;
$function$;

REVOKE ALL ON FUNCTION public.commission_split_with_recipient_ids(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commission_split_with_recipient_ids(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.commission_split_with_recipient_ids(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Validator v3: id-first. Shape, percentage, and 100%-total rules unchanged
-- from 20260722134252; recipient resolution now prefers recipient_user_id and
-- dedupes on the RESOLVED id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_commission_split_json(p_split jsonb)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_split jsonb;
  v_recipient text;
  v_id_txt text;
  v_rid uuid;
  v_seen_ids uuid[] := ARRAY[]::uuid[];
  v_percentage numeric;
  v_total numeric := 0;
BEGIN
  IF p_split IS NULL OR p_split = 'null'::jsonb THEN
    RETURN;
  END IF;

  IF jsonb_typeof(p_split) <> 'object'
     OR NOT (p_split ? 'splits')
     OR jsonb_typeof(p_split->'splits') <> 'array' THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: expected object with splits array';
  END IF;

  IF jsonb_array_length(p_split->'splits') = 0 THEN
    RETURN;
  END IF;

  FOR v_split IN SELECT value FROM jsonb_array_elements(p_split->'splits')
  LOOP
    IF jsonb_typeof(v_split) <> 'object' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: each split must be an object';
    END IF;

    v_id_txt := NULLIF(btrim(v_split->>'recipient_user_id'), '');
    v_recipient := NULLIF(btrim(v_split->>'recipient'), '');

    IF v_id_txt IS NOT NULL THEN
      BEGIN
        v_rid := v_id_txt::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient_user_id % is not a valid uuid', v_id_txt;
      END;
      IF public.commission_recipient_name_for_id(v_rid) IS NULL THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient_user_id % does not match an active user', v_rid;
      END IF;
    ELSE
      IF v_recipient IS NULL THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient is required';
      END IF;
      v_rid := public.resolve_commission_recipient_id(v_recipient);
      IF v_rid IS NULL THEN
        RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient % does not match exactly one active user', v_recipient;
      END IF;
    END IF;

    IF v_rid = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: duplicate recipient %',
        COALESCE(v_recipient, v_rid::text);
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_rid);

    BEGIN
      v_percentage := (v_split->>'percentage')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: invalid percentage for %',
        COALESCE(v_recipient, v_rid::text);
    END;

    IF v_percentage IS NULL OR v_percentage <= 0 OR v_percentage > 100 THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentage out of range for %',
        COALESCE(v_recipient, v_rid::text);
    END IF;

    v_total := v_total + v_percentage;
  END LOOP;

  IF abs(v_total - 100) > 0.01 THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentages total %.2f, expected 100.00', v_total;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Commission-creation helpers: route by element id first, unique-active name
-- resolution only as legacy fallback; display name refreshed from the
-- profile. Money math (largest-remainder reconciliation on the last row) is
-- byte-identical to the live bodies.
-- ---------------------------------------------------------------------------
-- idempotency-body-check: exempt (internal underscore helper, SECURITY INVOKER,
-- signature unchanged from the live body it re-emits; not frontend-callable)
CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id uuid, p_customer_id uuid, p_order_profit numeric,
  p_commission_split jsonb, p_order_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

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
    p_order_date,
    'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- idempotency-body-check: exempt (internal underscore helper, SECURITY INVOKER,
-- signature unchanged from the live body it re-emits; not frontend-callable)
CREATE OR REPLACE FUNCTION public._insert_commissions_for_job(
  p_job_id uuid, p_invoice_id uuid, p_customer_id uuid, p_profit numeric,
  p_commission_split jsonb, p_commission_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  PERFORM public.validate_commission_split_json(p_commission_split);

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
    c.percentage, c.reconciled_amount, COALESCE(p_profit, 0), p_commission_date, 'pending'
  FROM calculated c;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Backfill: stamp ids into every stored split that has any id-less element.
-- Runs before the stamp triggers exist; the quotes validate trigger fires and
-- passes (preflight proved resolution). Guard triggers on these tables are
-- status-change-gated and see no status change.
-- ---------------------------------------------------------------------------
UPDATE public.quotes q
   SET commission_split = public.commission_split_with_recipient_ids(q.commission_split)
 WHERE q.commission_split IS NOT NULL
   AND jsonb_typeof(q.commission_split->'splits') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(q.commission_split->'splits') e
      WHERE NULLIF(btrim(e->>'recipient_user_id'), '') IS NULL
   );

UPDATE public.orders o
   SET commission_split = public.commission_split_with_recipient_ids(o.commission_split)
 WHERE o.commission_split IS NOT NULL
   AND jsonb_typeof(o.commission_split->'splits') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(o.commission_split->'splits') e
      WHERE NULLIF(btrim(e->>'recipient_user_id'), '') IS NULL
   );

UPDATE public.customers c
   SET default_commission_split = public.commission_split_with_recipient_ids(c.default_commission_split)
 WHERE c.default_commission_split IS NOT NULL
   AND jsonb_typeof(c.default_commission_split->'splits') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(c.default_commission_split->'splits') e
      WHERE NULLIF(btrim(e->>'recipient_user_id'), '') IS NULL
   );

UPDATE public.jobs j
   SET commission_split = public.commission_split_with_recipient_ids(j.commission_split)
 WHERE j.commission_split IS NOT NULL
   AND jsonb_typeof(j.commission_split->'splits') = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(j.commission_split->'splits') e
      WHERE NULLIF(btrim(e->>'recipient_user_id'), '') IS NULL
   );

-- ---------------------------------------------------------------------------
-- Stamp triggers: enrich at write time so id-less splits can never recur.
-- One invoker-rights trigger function; TG_TABLE_NAME picks the column
-- (plpgsql record fields are late-bound, so the untaken branch never
-- resolves). Fires only when the split column is in the UPDATE SET list.
-- Alphabetical BEFORE-trigger ordering places it AFTER
-- trg_jobs_snapshot_commission_split ('j' < 's') and BEFORE
-- trg_validate_quote_commission_split ('s' < 'v'), so a snapshot gets
-- stamped and the quote validator sees the enriched value.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_commission_split_recipient_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'customers' THEN
    NEW.default_commission_split :=
      public.commission_split_with_recipient_ids(NEW.default_commission_split);
  ELSE
    NEW.commission_split :=
      public.commission_split_with_recipient_ids(NEW.commission_split);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.stamp_commission_split_recipient_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_commission_split_recipient_ids() FROM anon;

DROP TRIGGER IF EXISTS trg_stamp_commission_split_recipient_ids ON public.quotes;
CREATE TRIGGER trg_stamp_commission_split_recipient_ids
  BEFORE INSERT OR UPDATE OF commission_split ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_commission_split_recipient_ids();

DROP TRIGGER IF EXISTS trg_stamp_commission_split_recipient_ids ON public.orders;
CREATE TRIGGER trg_stamp_commission_split_recipient_ids
  BEFORE INSERT OR UPDATE OF commission_split ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_commission_split_recipient_ids();

DROP TRIGGER IF EXISTS trg_stamp_commission_split_recipient_ids ON public.jobs;
CREATE TRIGGER trg_stamp_commission_split_recipient_ids
  BEFORE INSERT OR UPDATE OF commission_split ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_commission_split_recipient_ids();

DROP TRIGGER IF EXISTS trg_stamp_commission_split_recipient_ids ON public.customers;
CREATE TRIGGER trg_stamp_commission_split_recipient_ids
  BEFORE INSERT OR UPDATE OF default_commission_split ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_commission_split_recipient_ids();

-- ---------------------------------------------------------------------------
-- Dropdown source now returns the id alongside the name. RETURNS TABLE shape
-- change requires DROP + CREATE; grants restated.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.list_commission_recipients();

CREATE FUNCTION public.list_commission_recipients()
RETURNS TABLE(id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT p.id, p.full_name
    FROM public.profiles p
   WHERE p.is_active = true
     AND p.role IN ('admin', 'sales_rep', 'entity_recipient')
     AND public.commission_recipient_resolves(p.full_name)
   ORDER BY p.full_name;
$function$;

REVOKE ALL ON FUNCTION public.list_commission_recipients() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_commission_recipients() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_commission_recipients() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retire the name-reservation guard (20260722150432). With every stored split
-- carrying an id (backfill) and no id-less split able to be written (stamp
-- triggers), acquiring a previously-referenced name can no longer redirect
-- stored splits — routing follows the id.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_guard_recipient_name_reuse ON public.profiles;
DROP FUNCTION IF EXISTS public._guard_recipient_name_reuse();

DO $postflight$
DECLARE
  v_count integer;
  v_good_id uuid;
  v_good_name text;
BEGIN
  -- 1. Zero id-less split elements remain anywhere.
  WITH all_elems AS (
    SELECT s FROM public.quotes q,
      jsonb_array_elements(CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
        THEN q.commission_split->'splits' ELSE '[]'::jsonb END) s
    UNION ALL
    SELECT s FROM public.orders o,
      jsonb_array_elements(CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
        THEN o.commission_split->'splits' ELSE '[]'::jsonb END) s
    UNION ALL
    SELECT s FROM public.customers c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c.default_commission_split->'splits') = 'array'
        THEN c.default_commission_split->'splits' ELSE '[]'::jsonb END) s
    UNION ALL
    SELECT s FROM public.jobs j,
      jsonb_array_elements(CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
        THEN j.commission_split->'splits' ELSE '[]'::jsonb END) s
  )
  SELECT count(*) INTO v_count
    FROM all_elems
   WHERE NULLIF(btrim(s->>'recipient_user_id'), '') IS NULL;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_BACKFILL_POSTFLIGHT_INCOMPLETE: % id-less split elements', v_count;
  END IF;

  -- 2. Every stamped id points at an active profile.
  WITH all_elems AS (
    SELECT s FROM public.quotes q,
      jsonb_array_elements(CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
        THEN q.commission_split->'splits' ELSE '[]'::jsonb END) s
    UNION ALL
    SELECT s FROM public.orders o,
      jsonb_array_elements(CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
        THEN o.commission_split->'splits' ELSE '[]'::jsonb END) s
    UNION ALL
    SELECT s FROM public.customers c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c.default_commission_split->'splits') = 'array'
        THEN c.default_commission_split->'splits' ELSE '[]'::jsonb END) s
    UNION ALL
    SELECT s FROM public.jobs j,
      jsonb_array_elements(CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
        THEN j.commission_split->'splits' ELSE '[]'::jsonb END) s
  )
  SELECT count(*) INTO v_count
    FROM all_elems
   WHERE NOT EXISTS (
     SELECT 1 FROM public.profiles p
      WHERE p.id = (btrim(s->>'recipient_user_id'))::uuid
        AND p.is_active = true
   );

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_BACKFILL_POSTFLIGHT_STALE_IDS: % elements with non-active ids', v_count;
  END IF;

  -- 3. Stamp trigger installed and enabled on all four tables.
  SELECT count(*) INTO v_count
    FROM pg_trigger t
   WHERE t.tgname = 'trg_stamp_commission_split_recipient_ids'
     AND NOT t.tgisinternal
     AND t.tgenabled = 'O'
     AND t.tgrelid IN ('public.quotes'::regclass, 'public.orders'::regclass,
                       'public.jobs'::regclass, 'public.customers'::regclass);
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'COMMISSION_STAMP_TRIGGER_POSTFLIGHT_MISSING: % of 4 installed', v_count;
  END IF;

  -- 4. Name-reuse guard fully gone; identity + backstop protections intact.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_recipient_name_reuse')
     OR to_regprocedure('public._guard_recipient_name_reuse()') IS NOT NULL THEN
    RAISE EXCEPTION 'COMMISSION_NAME_REUSE_GUARD_STILL_PRESENT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.commissions'::regclass
       AND t.tgname = 'trg_commissions_recipient_resolved'
       AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'COMMISSION_BACKSTOP_TRIGGER_MISSING';
  END IF;

  -- 5. Exactly one overload of every touched function.
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('validate_commission_split_json', '_insert_commissions_for_order',
                       '_insert_commissions_for_job', 'list_commission_recipients',
                       'commission_split_with_recipient_ids', 'resolve_commission_recipient_id',
                       'commission_recipient_name_for_id', 'stamp_commission_split_recipient_ids');
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'COMMISSION_OVERLOAD_POSTFLIGHT_DRIFT: % functions, expected 8', v_count;
  END IF;

  -- 6. Validator behavior: id-only element passes; bogus id fails; unresolvable
  -- name fails; same person by id + by name = duplicate.
  SELECT r.id, r.full_name INTO v_good_id, v_good_name
    FROM public.list_commission_recipients() r
   ORDER BY r.full_name
   LIMIT 1;
  IF v_good_id IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_LIST_POSTFLIGHT_EMPTY';
  END IF;

  PERFORM public.validate_commission_split_json(
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient_user_id', v_good_id::text, 'percentage', 100)
    ))
  );

  BEGIN
    PERFORM public.validate_commission_split_json(
      '{"splits":[{"recipient_user_id":"00000000-0000-0000-0000-000000000000","percentage":100}]}'::jsonb
    );
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_ACCEPTED_BOGUS_ID';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'COMMISSION_VALIDATOR_POSTFLIGHT_ACCEPTED_BOGUS_ID' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'COMMISSION_SPLIT_INVALID: recipient_user_id % does not match an active user' THEN
      RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_WRONG_ID_ERROR: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.validate_commission_split_json(
      '{"splits":[{"recipient":"Postflight Unresolvable Ghost","percentage":100}]}'::jsonb
    );
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_ACCEPTED_BAD_NAME';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'COMMISSION_VALIDATOR_POSTFLIGHT_ACCEPTED_BAD_NAME' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'COMMISSION_SPLIT_INVALID: recipient Postflight Unresolvable Ghost does not match exactly one active user%' THEN
      RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_WRONG_NAME_ERROR: %', SQLERRM;
    END IF;
  END;

  BEGIN
    PERFORM public.validate_commission_split_json(
      jsonb_build_object('splits', jsonb_build_array(
        jsonb_build_object('recipient_user_id', v_good_id::text, 'percentage', 50),
        jsonb_build_object('recipient', v_good_name, 'percentage', 50)
      ))
    );
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_MISSED_CROSS_DUP';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'COMMISSION_VALIDATOR_POSTFLIGHT_MISSED_CROSS_DUP' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'COMMISSION_SPLIT_INVALID: duplicate recipient %' THEN
      RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_WRONG_DUP_ERROR: %', SQLERRM;
    END IF;
  END;

  -- 7. Enrichment stamps a name-only element with the right id.
  IF (public.commission_split_with_recipient_ids(
        jsonb_build_object('splits', jsonb_build_array(
          jsonb_build_object('recipient', v_good_name, 'percentage', 100)
        ))
      )->'splits'->0->>'recipient_user_id') IS DISTINCT FROM v_good_id::text THEN
    RAISE EXCEPTION 'COMMISSION_ENRICHMENT_POSTFLIGHT_WRONG_ID';
  END IF;

  -- 8. Dropdown returns id+name pairs that agree with resolution.
  IF EXISTS (
    SELECT 1 FROM public.list_commission_recipients() r
     WHERE public.resolve_commission_recipient_id(r.full_name) IS DISTINCT FROM r.id
  ) THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_LIST_POSTFLIGHT_INCONSISTENT';
  END IF;
END;
$postflight$;

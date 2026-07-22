-- Reject unresolvable commission recipients at creation (gauntlet 2026-07-22 §7).
--
-- A commission split recipient that does not resolve to exactly one active
-- profile produces commissions with recipient_user_id NULL, which the payout
-- UI (CommissionPayments) can never select into a payment batch — the money
-- sits invisible forever. Two layers, both fail-closed:
--   1. validate_commission_split_json now requires every recipient name to
--      resolve to exactly one active profile (via a locked-down SECURITY
--      DEFINER boolean helper, because profiles SELECT is admin-or-self and
--      the quote trigger runs as the caller).
--   2. A commissions-table backstop trigger refuses any INSERT (or UPDATE of
--      recipient_user_id) that would leave recipient_user_id NULL, covering
--      every creation path including future ones. The single legacy row
--      (cancelled, $0, blank recipient, 2026-03-16) is untouched because the
--      trigger only fires on INSERT or on UPDATE OF recipient_user_id.

-- Bound how long the apply queues behind long-running writers (advisory from
-- the 2026-07-22 RLS delta review).
SET LOCAL lock_timeout = '5s';

-- Lock every table the preflight validates (Codex round-2 P2): blocks
-- concurrent writes that could slip an unresolvable recipient in between the
-- preflight sweep and the guard installation, while still allowing reads.
LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.jobs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.commissions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_validator_hash text;
  v_bad_split_count integer;
  v_bad_commission_count integer;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_validator_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.validate_commission_split_json(jsonb)');

  IF v_validator_hash IS DISTINCT FROM '93262fb0f09b4c94aaada395f55c1519' THEN
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_BASELINE_DRIFT: %', v_validator_hash;
  END IF;

  -- Every recipient already stored on live quotes, customer defaults, and job
  -- snapshots must resolve, or the stricter validator would brick edits of
  -- those records.
  WITH all_recips AS (
    SELECT btrim(s->>'recipient') AS recipient
      FROM public.quotes q,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
                  THEN q.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
     WHERE q.deleted_at IS NULL
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
    INTO v_bad_split_count
    FROM all_recips r
   WHERE NULLIF(r.recipient, '') IS NULL
      OR (SELECT count(*) FROM public.profiles p
           WHERE lower(trim(p.full_name)) = lower(r.recipient)
             AND p.is_active = true) <> 1;

  IF v_bad_split_count <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_RECONCILIATION_REQUIRED: % unresolvable split recipients', v_bad_split_count;
  END IF;

  SELECT count(*)
    INTO v_bad_commission_count
    FROM public.commissions c
   WHERE c.recipient_user_id IS NULL
     AND c.status <> 'cancelled';

  IF v_bad_commission_count <> 0 THEN
    RAISE EXCEPTION 'COMMISSION_NULL_RECIPIENT_RECONCILIATION_REQUIRED: % active commissions', v_bad_commission_count;
  END IF;
END;
$preflight$;

-- Boolean-only resolution helper. SECURITY DEFINER because profiles SELECT is
-- admin-or-self; leaks only "does this name match exactly one active user".
CREATE OR REPLACE FUNCTION public.commission_recipient_resolves(p_recipient text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT (
    SELECT count(*)
      FROM public.profiles p
     WHERE lower(trim(p.full_name)) = lower(btrim(p_recipient))
       AND p.is_active = true
  ) = 1;
$function$;

REVOKE ALL ON FUNCTION public.commission_recipient_resolves(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commission_recipient_resolves(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.commission_recipient_resolves(text) TO authenticated, service_role;

-- Curated dropdown source for the CommissionSplitEditor (Codex P2, 2026-07-22):
-- commission-eligible roles only, and only names the validator would accept
-- (resolution stays role-agnostic so validator-pass always implies the
-- invoicing-time recipient_user_id resolution succeeds; this list is a strict
-- subset). SECURITY DEFINER because profiles SELECT is admin-or-self; leaks
-- only the active commission-eligible name list to authenticated users.
CREATE OR REPLACE FUNCTION public.list_commission_recipients()
RETURNS TABLE(full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT p.full_name
    FROM public.profiles p
   WHERE p.is_active = true
     AND p.role IN ('admin', 'sales_rep', 'entity_recipient')
     AND public.commission_recipient_resolves(p.full_name)
   ORDER BY p.full_name;
$function$;

REVOKE ALL ON FUNCTION public.list_commission_recipients() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_commission_recipients() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_commission_recipients() TO authenticated, service_role;

-- IMMUTABLE -> STABLE: the validator now consults profiles (via the helper).
CREATE OR REPLACE FUNCTION public.validate_commission_split_json(p_split jsonb)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_split jsonb;
  v_recipient text;
  v_seen text[] := ARRAY[]::text[];
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
    v_recipient := NULLIF(btrim(v_split->>'recipient'), '');
    IF v_recipient IS NULL THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient is required';
    END IF;

    IF lower(v_recipient) = ANY(v_seen) THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: duplicate recipient %', v_recipient;
    END IF;
    v_seen := array_append(v_seen, lower(v_recipient));

    IF NOT public.commission_recipient_resolves(v_recipient) THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: recipient % does not match exactly one active user', v_recipient;
    END IF;

    BEGIN
      v_percentage := (v_split->>'percentage')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: invalid percentage for %', v_recipient;
    END;

    IF v_percentage IS NULL OR v_percentage <= 0 OR v_percentage > 100 THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentage out of range for %', v_recipient;
    END IF;

    v_total := v_total + v_percentage;
  END LOOP;

  IF abs(v_total - 100) > 0.01 THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_INVALID: percentages total %.2f, expected 100.00', v_total;
  END IF;
END;
$function$;

-- Backstop: no commission row may be created (or have its recipient cleared)
-- without a resolved recipient_user_id, regardless of which code path inserts.
CREATE OR REPLACE FUNCTION public.enforce_commission_recipient_resolved()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'COMMISSION_RECIPIENT_UNRESOLVED: recipient % does not resolve to an active user; refusing to create an unpayable commission',
    COALESCE(NULLIF(btrim(NEW.recipient), ''), '(blank)');
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_commission_recipient_resolved() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_commission_recipient_resolved() FROM anon;

DROP TRIGGER IF EXISTS trg_commissions_recipient_resolved ON public.commissions;
CREATE TRIGGER trg_commissions_recipient_resolved
  BEFORE INSERT OR UPDATE OF recipient_user_id ON public.commissions
  FOR EACH ROW
  WHEN (NEW.recipient_user_id IS NULL)
  EXECUTE FUNCTION public.enforce_commission_recipient_resolved();

DO $postflight$
DECLARE
  v_good_name text;
BEGIN
  -- Shape checks on the re-emitted validator.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.validate_commission_split_json(jsonb)')
       AND p.provolatile = 's'
       AND NOT p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'COMMISSION_VALIDATOR_POSTFLIGHT_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.commissions'::regclass
       AND t.tgname = 'trg_commissions_recipient_resolved'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'COMMISSION_BACKSTOP_TRIGGER_MISSING';
  END IF;

  -- Negative: an unresolvable name must be rejected with the new error.
  BEGIN
    PERFORM public.validate_commission_split_json(
      '{"splits":[{"recipient":"Postflight Unresolvable Ghost","percentage":100}]}'::jsonb
    );
    RAISE EXCEPTION 'COMMISSION_RESOLUTION_POSTFLIGHT_FAILED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'COMMISSION_RESOLUTION_POSTFLIGHT_FAILED' THEN
      RAISE;
    END IF;
    IF SQLERRM NOT LIKE 'COMMISSION_SPLIT_INVALID: recipient Postflight Unresolvable Ghost does not match exactly one active user%' THEN
      RAISE EXCEPTION 'COMMISSION_RESOLUTION_POSTFLIGHT_WRONG_ERROR: %', SQLERRM;
    END IF;
  END;

  -- Positive: a real, uniquely-named active profile must still validate.
  SELECT min(p.full_name)
    INTO v_good_name
    FROM public.profiles p
   WHERE p.is_active = true
   GROUP BY lower(trim(p.full_name))
  HAVING count(*) = 1
   LIMIT 1;

  IF v_good_name IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_RESOLUTION_POSTFLIGHT_NO_TEST_PROFILE';
  END IF;

  PERFORM public.validate_commission_split_json(
    jsonb_build_object('splits', jsonb_build_array(
      jsonb_build_object('recipient', v_good_name, 'percentage', 100)
    ))
  );

  -- Dropdown list must be self-consistent: every listed name must pass the
  -- validator's resolution check, and the list must not be empty.
  IF NOT EXISTS (SELECT 1 FROM public.list_commission_recipients()) THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_LIST_POSTFLIGHT_EMPTY';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.list_commission_recipients() r
     WHERE NOT public.commission_recipient_resolves(r.full_name)
  ) THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_LIST_POSTFLIGHT_INCONSISTENT';
  END IF;

  -- Backstop trigger fires before any constraint or FK check, so this insert
  -- must fail with our error and never lands a row.
  BEGIN
    INSERT INTO public.commissions (recipient, recipient_user_id)
    VALUES ('Postflight Unresolvable Ghost', NULL);
    RAISE EXCEPTION 'COMMISSION_BACKSTOP_POSTFLIGHT_FAILED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'COMMISSION_BACKSTOP_POSTFLIGHT_FAILED' THEN
      RAISE;
    END IF;
    IF SQLERRM NOT LIKE 'COMMISSION_RECIPIENT_UNRESOLVED:%' THEN
      RAISE EXCEPTION 'COMMISSION_BACKSTOP_POSTFLIGHT_WRONG_ERROR: %', SQLERRM;
    END IF;
  END;
END;
$postflight$;
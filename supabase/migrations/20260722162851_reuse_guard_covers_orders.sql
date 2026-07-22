-- Extend the recipient-name reuse guard to orders (Codex push-proof HIGH #4,
-- 2026-07-22).
--
-- orders.commission_split is a snapshot (copied from the quote at conversion
-- or the customer default for direct/rush orders) and mints commissions
-- later — price_order for needs_pricing orders and the invoice-creation
-- helpers resolve recipient names at that future moment. The reuse guard
-- from 20260722150432 checked customer defaults, live quotes, and
-- uninvoiced jobs but NOT orders, so a name referenced only by a live
-- order's snapshot could be vacated and re-acquired, routing that order's
-- future commission to the new holder. This re-emits the guard with live
-- orders (deleted_at IS NULL, status confirmed/partially_fulfilled/
-- fulfilled — cancelled and voided orders mint nothing) added to the
-- referenced set, and preflight-sweeps those orders' recipients for
-- resolution. Everything else about the guard is unchanged.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_guard_hash text;
  v_bad_count integer;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_guard_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()');

  IF v_guard_hash IS DISTINCT FROM '0b74292a2961d22ffd266b8ef25103e3' THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_BASELINE_DRIFT: %', v_guard_hash;
  END IF;

  -- Every recipient snapshotted on a commission-relevant order must resolve,
  -- mirroring the 20260722134252 sweep of quotes/customers/jobs.
  SELECT count(*)
    INTO v_bad_count
    FROM (
      SELECT btrim(s->>'recipient') AS recipient
        FROM public.orders o,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
                    THEN o.commission_split->'splits' ELSE '[]'::jsonb END
             ) s
       WHERE o.deleted_at IS NULL
         AND o.status IN ('confirmed', 'partially_fulfilled', 'fulfilled')
    ) r
   WHERE NULLIF(r.recipient, '') IS NULL
      OR (SELECT count(*) FROM public.profiles p
           WHERE lower(trim(p.full_name)) = lower(r.recipient)
             AND p.is_active = true) <> 1;

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION 'ORDER_RECIPIENT_RECONCILIATION_REQUIRED: % unresolvable order split recipients', v_bad_count;
  END IF;
END;
$preflight$;

-- Same body as 20260722150432 with the orders branch added to the
-- referenced-name set.
CREATE OR REPLACE FUNCTION public._guard_recipient_name_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_key text := lower(btrim(NEW.full_name));
  v_acquiring boolean;
BEGIN
  IF v_key IS NULL OR v_key = '' THEN
    RETURN NEW;
  END IF;

  -- The check applies to INACTIVE rows too (RLS-review B1): otherwise
  -- rename-while-inactive followed by reactivation would acquire a
  -- referenced name in two individually-innocent steps — the unique name
  -- index and reactivation carve-out compose safely only when acquisition
  -- itself is always gated.
  v_acquiring := (TG_OP = 'INSERT')
    OR lower(btrim(OLD.full_name)) IS DISTINCT FROM v_key;

  IF NOT v_acquiring THEN
    RETURN NEW; -- same holder keeping (or reactivating under) their own name
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT btrim(s->>'recipient') AS recipient
        FROM public.customers c,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(c.default_commission_split->'splits') = 'array'
                    THEN c.default_commission_split->'splits' ELSE '[]'::jsonb END
             ) s
      UNION ALL
      SELECT btrim(s->>'recipient')
        FROM public.quotes q,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
                    THEN q.commission_split->'splits' ELSE '[]'::jsonb END
             ) s
       WHERE q.deleted_at IS NULL
         AND q.status IN ('draft', 'sent', 'revised', 'accepted')
      UNION ALL
      SELECT btrim(s->>'recipient')
        FROM public.jobs j,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
                    THEN j.commission_split->'splits' ELSE '[]'::jsonb END
             ) s
       WHERE j.status IN ('scheduled', 'in_progress', 'completed')
      UNION ALL
      SELECT btrim(s->>'recipient')
        FROM public.orders o,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
                    THEN o.commission_split->'splits' ELSE '[]'::jsonb END
             ) s
       WHERE o.deleted_at IS NULL
         -- 'cancelled' included (RLS-review H1): restore_cancelled_order can
         -- move cancelled back to confirmed, so a cancelled order's snapshot
         -- still reserves its names. Only 'voided' (no restore path) mints
         -- nothing forever.
         AND o.status IN ('confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')
    ) r
    WHERE lower(r.recipient) = v_key
  ) THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_NAME_RESERVED: "%" is still named as a commission recipient on a customer default, live quote, live order, or uninvoiced job; update those splits (or choose a distinguishable name) before assigning this name to a profile', btrim(NEW.full_name)
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM anon;

DO $postflight$
DECLARE
  v_order_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()')
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%FROM public.orders o%'
  ) THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_ORDERS_POSTFLIGHT_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.profiles'::regclass
       AND t.tgname = 'trg_guard_recipient_name_reuse'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'NAME_REUSE_TRIGGER_MISSING';
  END IF;

  -- Behavioral: a recipient name referenced by a live order must be
  -- un-acquirable. Skipped only if no live order carries a split recipient
  -- (the customer-default test from 20260722150432 already proved the guard
  -- mechanism itself).
  SELECT btrim(s->>'recipient')
    INTO v_order_name
    FROM public.orders o,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
                THEN o.commission_split->'splits' ELSE '[]'::jsonb END
         ) s
   WHERE o.deleted_at IS NULL
     AND o.status IN ('confirmed', 'partially_fulfilled', 'fulfilled')
     AND NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
   LIMIT 1;

  IF v_order_name IS NOT NULL THEN
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_order_name, 'sales_rep', false;
      RAISE EXCEPTION 'NAME_REUSE_ORDERS_POSTFLIGHT_FAILED';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'NAME_REUSE_ORDERS_POSTFLIGHT_FAILED' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE 'COMMISSION_RECIPIENT_NAME_RESERVED:%' THEN
        RAISE EXCEPTION 'NAME_REUSE_ORDERS_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
      END IF;
    END;
  END IF;
END;
$postflight$;
-- Extend the recipient-name reuse guard to terminal-but-revivable quotes
-- (Codex push-proof round 8, 2026-07-22 — the finding PR #213 parked on).
--
-- The guard from 20260722150432/20260722162851 reserves recipient names on
-- customer defaults, live quotes (draft/sent/revised/accepted), uninvoiced
-- jobs, and live+cancelled orders. But terminal quotes are revivable:
-- revert_quote_status (20260719044958) moves declined/expired/cancelled back
-- to sent, and restore_quote_version (20260703130000) moves a quote back to
-- revised — so a name referenced only by a terminal quote's split can be
-- vacated, re-acquired by a different profile, and later converted with the
-- wrong holder. This re-emits the guard with the quotes branch widened to
-- EVERY non-deleted quote. Reservation ≠ resolution (row-816 precedent for
-- cancelled orders): the creation-time resolution sweep stays scoped to live
-- quotes, terminal quotes merely reserve their names. Everything else about
-- the guard is unchanged.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_guard_hash text;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_guard_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()');

  IF v_guard_hash IS DISTINCT FROM '5b49513124a8eaa6be67d8d4b6799938' THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_BASELINE_DRIFT: %', v_guard_hash;
  END IF;
END;
$preflight$;

-- Same body as 20260722162851 with the quotes branch widened from
-- status IN (draft/sent/revised/accepted) to every non-deleted quote.
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
       -- No status filter (Codex round 8): terminal quotes (declined/
       -- expired/cancelled and the closed_* states) are revivable via
       -- revert_quote_status / restore_quote_version, so every non-deleted
       -- quote's snapshot reserves its names.
       WHERE q.deleted_at IS NULL
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
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_NAME_RESERVED: "%" is still named as a commission recipient on a customer default, quote, live order, or uninvoiced job; update those splits (or choose a distinguishable name) before assigning this name to a profile', btrim(NEW.full_name)
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM anon;

DO $postflight$
DECLARE
  v_quote_name text;
BEGIN
  -- Structural: the quotes branch must have no status filter left, secdef +
  -- pinned search_path intact, trigger enabled.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()')
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%FROM public.quotes q%'
       AND p.prosrc NOT LIKE '%q.status IN (''draft''%'
  ) THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_QUOTES_POSTFLIGHT_DRIFT';
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

  -- Behavioral: a name referenced by a terminal-but-revivable quote must be
  -- un-acquirable. Prefer a name referenced ONLY by a terminal quote (so the
  -- rejection proves the NEW branch, not a pre-existing one); fall back to
  -- any terminal-quote recipient; skip if live data has none (the structural
  -- check above still proves the widening).
  WITH terminal_names AS (
    SELECT DISTINCT lower(btrim(s->>'recipient')) AS k,
           btrim(s->>'recipient') AS display
      FROM public.quotes q,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
                  THEN q.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
     WHERE q.deleted_at IS NULL
       AND q.status NOT IN ('draft', 'sent', 'revised', 'accepted')
       AND NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
  ),
  otherwise_reserved AS (
    SELECT lower(btrim(s->>'recipient')) AS k
      FROM public.customers c,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.default_commission_split->'splits') = 'array'
                  THEN c.default_commission_split->'splits' ELSE '[]'::jsonb END
           ) s
    UNION
    SELECT lower(btrim(s->>'recipient'))
      FROM public.quotes q,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(q.commission_split->'splits') = 'array'
                  THEN q.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
     WHERE q.deleted_at IS NULL
       AND q.status IN ('draft', 'sent', 'revised', 'accepted')
    UNION
    SELECT lower(btrim(s->>'recipient'))
      FROM public.jobs j,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
                  THEN j.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
     WHERE j.status IN ('scheduled', 'in_progress', 'completed')
    UNION
    SELECT lower(btrim(s->>'recipient'))
      FROM public.orders o,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(o.commission_split->'splits') = 'array'
                  THEN o.commission_split->'splits' ELSE '[]'::jsonb END
           ) s
     WHERE o.deleted_at IS NULL
       AND o.status IN ('confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')
  )
  SELECT display
    INTO v_quote_name
    FROM terminal_names t
   ORDER BY (t.k IN (SELECT k FROM otherwise_reserved)) ASC
   LIMIT 1;

  IF v_quote_name IS NOT NULL THEN
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_quote_name, 'sales_rep', false;
      RAISE EXCEPTION 'NAME_REUSE_QUOTES_POSTFLIGHT_FAILED';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'NAME_REUSE_QUOTES_POSTFLIGHT_FAILED' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE 'COMMISSION_RECIPIENT_NAME_RESERVED:%' THEN
        RAISE EXCEPTION 'NAME_REUSE_QUOTES_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
      END IF;
    END;
  END IF;
END;
$postflight$;
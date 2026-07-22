-- Extend the recipient-name reuse guard to INVOICED jobs (follow-up to
-- 20260722173000 / live version 20260722172533; KNOWN_ISSUES §1b residual,
-- 2026-07-22).
--
-- jobs.commission_split is a snapshot that mints commissions when the job is
-- billed. The reuse guard reserved recipient names on jobs in
-- scheduled/in_progress/completed but NOT 'invoiced'. With the id-redesign
-- live (20260722174029), stored recipient ids win while a profile is ACTIVE,
-- but the name-based fallback still fires when a profile is DEACTIVATED. So a
-- name referenced only by an INVOICED job's snapshot could be vacated and
-- re-acquired by a new profile; if that job's invoice is then voided (job
-- returns to 'completed') and re-invoiced, the id-inactive fallback re-resolves
-- the stored name to the NEW holder — routing that job's commission to the
-- wrong person. 'invoiced' is a revivable state (transfer_invoice_to_job /
-- void-and-re-bill), so it must reserve its names exactly like completed jobs.
--
-- This re-emits the guard with 'invoiced' added to the jobs status set and
-- preflight-sweeps invoiced jobs' recipients for resolution, mirroring the
-- orders extension (20260722162851). Everything else about the guard is
-- byte-identical to the current live body. 'cancelled' jobs are intentionally
-- NOT added: no restore-from-cancelled RPC exists for jobs (unlike orders'
-- restore_cancelled_order), so a cancelled job mints nothing forever.

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

  -- Pin the exact current live body (customers + all non-deleted quotes +
  -- scheduled/in_progress/completed jobs + live orders). If a parallel session
  -- re-emitted the guard, this baseline drifts and we must re-introspect
  -- before re-emitting rather than clobber their change.
  IF v_guard_hash IS DISTINCT FROM '6e7f5bd2a3c041b81ad44789de676668' THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_BASELINE_DRIFT: %', v_guard_hash;
  END IF;

  -- Every recipient snapshotted on an invoiced job must resolve to exactly one
  -- active profile, mirroring the orders/quotes/customers/jobs sweep from
  -- 20260722134252 and 20260722162851. If one does not, an existing invoiced
  -- job already lost its holder (the bug this migration closes going forward);
  -- surface it for reconciliation instead of silently applying.
  SELECT count(*)
    INTO v_bad_count
    FROM (
      SELECT btrim(s->>'recipient') AS recipient
        FROM public.jobs j,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
                    THEN j.commission_split->'splits' ELSE '[]'::jsonb END
             ) s
       WHERE j.status = 'invoiced'
    ) r
   WHERE NULLIF(r.recipient, '') IS NULL
      OR (SELECT count(*) FROM public.profiles p
           WHERE lower(trim(p.full_name)) = lower(r.recipient)
             AND p.is_active = true) <> 1;

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION 'INVOICED_JOB_RECIPIENT_RECONCILIATION_REQUIRED: % unresolvable invoiced-job split recipients', v_bad_count;
  END IF;
END;
$preflight$;

-- Same body as the current live guard (20260722172533) with 'invoiced' added
-- to the jobs status set.
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
       -- 'invoiced' included (KNOWN_ISSUES §1b): an invoiced job is revivable
       -- (its invoice can be voided, returning the job to 'completed', then
       -- re-invoiced), so its snapshot still reserves its names. 'cancelled'
       -- is excluded — no restore-from-cancelled path exists for jobs.
       WHERE j.status IN ('scheduled', 'in_progress', 'completed', 'invoiced')
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
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_NAME_RESERVED: "%" is still named as a commission recipient on a customer default, quote, live order, or job; update those splits (or choose a distinguishable name) before assigning this name to a profile', btrim(NEW.full_name)
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM anon;

DO $postflight$
DECLARE
  v_job_name text;
BEGIN
  -- Structural: SECDEF + pinned search_path + the jobs branch now carries the
  -- exact four-status set including 'invoiced'.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()')
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
       AND p.prosrc LIKE '%''scheduled'', ''in_progress'', ''completed'', ''invoiced''%'
  ) THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_INVOICED_POSTFLIGHT_DRIFT';
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

  -- Behavioral: a recipient name referenced by an invoiced job must now be
  -- un-acquirable. Skipped only when no invoiced job carries a split recipient
  -- (the structural check above proves the code shape; the guard mechanism
  -- itself is already proven by the customer-default/orders behavioral tests).
  SELECT btrim(s->>'recipient')
    INTO v_job_name
    FROM public.jobs j,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(j.commission_split->'splits') = 'array'
                THEN j.commission_split->'splits' ELSE '[]'::jsonb END
         ) s
   WHERE j.status = 'invoiced'
     AND NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
   LIMIT 1;

  IF v_job_name IS NOT NULL THEN
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_job_name, 'sales_rep', false;
      RAISE EXCEPTION 'NAME_REUSE_INVOICED_POSTFLIGHT_FAILED';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'NAME_REUSE_INVOICED_POSTFLIGHT_FAILED' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE 'COMMISSION_RECIPIENT_NAME_RESERVED:%' THEN
        RAISE EXCEPTION 'NAME_REUSE_INVOICED_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
      END IF;
    END;
  END IF;
END;
$postflight$;

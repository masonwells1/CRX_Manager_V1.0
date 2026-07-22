-- Forbid acquiring a commission-referenced profile name (Codex push-proof
-- HIGH #2, 2026-07-22) + index-postflight hardening (Codex MEDIUM).
--
-- Residual after 20260722144121: splits store recipient NAMES, not ids. An
-- admin could deactivate/rename a person whose name is still stored in
-- splits with future money, then give that vacated name to a different
-- active profile — future commissions would silently resolve to the new
-- holder. Fail-closed closure: no profile may ACQUIRE (INSERT with, or
-- rename to) an active name whose normalized key is still referenced by a
-- split with future commission potential — customer default splits, live
-- quotes (draft/sent/revised/accepted, not deleted), or uninvoiced jobs
-- (scheduled/in_progress/completed). Reactivating a profile under its own
-- unchanged name stays allowed (the original holder returning restores
-- resolution). Renaming AWAY from a referenced name also stays allowed —
-- that direction merely makes the split unresolvable, and the validator +
-- backstop trigger already fail closed there (Mason's accepted trade-off,
-- KNOWN_ISSUES §5). The durable fix — storing profile ids in splits — is a
-- schema redesign tracked as follow-up work, not this migration.
--
-- Also hardens the 20260722144121 postflight per the Codex MEDIUM: asserts
-- the exact indexed expression of uq_profiles_active_full_name_ci and
-- re-proves the duplicate-name rejection attributing the unique_violation
-- to that specific constraint via GET STACKED DIAGNOSTICS.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_guard_hash text;
BEGIN
  -- The 20260722144121 guard (role/is_active/denied_pages/full_name) must be
  -- exactly what this migration composes with.
  SELECT md5(p.prosrc)
    INTO v_guard_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_profile_role_lock()');

  IF v_guard_hash IS DISTINCT FROM 'ac9a1057507879b62d398bcb2738b6f5' THEN
    RAISE EXCEPTION 'PROFILE_GUARD_BASELINE_DRIFT: %', v_guard_hash;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND indexname = 'uq_profiles_active_full_name_ci'
  ) THEN
    RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_INDEX_MISSING_PREFLIGHT';
  END IF;
END;
$preflight$;

-- SECURITY DEFINER: the acquiring admin's RLS view of quotes/jobs/customers
-- must not decide a money-routing invariant; search_path pinned.
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
  -- referenced name in two individually-innocent steps — the partial unique
  -- index doesn't cover inactive rows, and reactivation under an unchanged
  -- name is deliberately allowed below.
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
    ) r
    WHERE lower(r.recipient) = v_key
  ) THEN
    RAISE EXCEPTION 'COMMISSION_RECIPIENT_NAME_RESERVED: "%" is still named as a commission recipient on a customer default, live quote, or uninvoiced job; update those splits (or choose a distinguishable name) before assigning this name to a profile', btrim(NEW.full_name)
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_recipient_name_reuse() FROM anon;

DROP TRIGGER IF EXISTS trg_guard_recipient_name_reuse ON public.profiles;
CREATE TRIGGER trg_guard_recipient_name_reuse
  BEFORE INSERT OR UPDATE OF full_name, is_active ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_recipient_name_reuse();

DO $postflight$
DECLARE
  v_referenced_name text;
  v_constraint text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()')
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_POSTFLIGHT_DRIFT';
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

  -- Codex MEDIUM: the unique index must have EXACTLY the normalized-name
  -- expression and active-only predicate — IF NOT EXISTS in 20260722144121
  -- could in principle have kept a same-named impostor.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND indexname = 'uq_profiles_active_full_name_ci'
       AND indexdef LIKE '%UNIQUE%'
       AND indexdef LIKE '%lower(btrim(full_name))%'
       AND indexdef LIKE '%WHERE (is_active = true)%'
  ) THEN
    RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_INDEX_EXPRESSION_DRIFT';
  END IF;

  -- A referenced recipient name must be un-acquirable. The guard fires
  -- BEFORE row insertion, so this errors before NOT NULL/unique/FK checks
  -- and never lands a row.
  SELECT btrim(s->>'recipient')
    INTO v_referenced_name
    FROM public.customers c,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(c.default_commission_split->'splits') = 'array'
                THEN c.default_commission_split->'splits' ELSE '[]'::jsonb END
         ) s
   WHERE NULLIF(btrim(s->>'recipient'), '') IS NOT NULL
   LIMIT 1;

  IF v_referenced_name IS NOT NULL THEN
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_referenced_name, 'sales_rep', true;
      RAISE EXCEPTION 'NAME_REUSE_POSTFLIGHT_FAILED';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'NAME_REUSE_POSTFLIGHT_FAILED' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE 'COMMISSION_RECIPIENT_NAME_RESERVED:%' THEN
        RAISE EXCEPTION 'NAME_REUSE_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
      END IF;
    END;
  END IF;

  -- Codex MEDIUM (behavioral half): re-prove duplicate rejection and
  -- attribute the unique_violation to the exact index. Use a name that is
  -- active-held but NOT split-referenced, so the reuse guard passes and the
  -- index is what rejects. If every active name is referenced, skip — the
  -- reserved-guard test above already proved the stronger front gate.
  SELECT '  ' || upper(p.full_name) || ' '
    INTO v_referenced_name
    FROM public.profiles p
   WHERE p.is_active = true
     AND NULLIF(btrim(p.full_name), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM (
         SELECT btrim(s->>'recipient') AS recipient
           FROM public.customers c2,
                jsonb_array_elements(
                  CASE WHEN jsonb_typeof(c2.default_commission_split->'splits') = 'array'
                       THEN c2.default_commission_split->'splits' ELSE '[]'::jsonb END
                ) s
         UNION ALL
         SELECT btrim(s->>'recipient')
           FROM public.quotes q2,
                jsonb_array_elements(
                  CASE WHEN jsonb_typeof(q2.commission_split->'splits') = 'array'
                       THEN q2.commission_split->'splits' ELSE '[]'::jsonb END
                ) s
          WHERE q2.deleted_at IS NULL
            AND q2.status IN ('draft', 'sent', 'revised', 'accepted')
         UNION ALL
         SELECT btrim(s->>'recipient')
           FROM public.jobs j2,
                jsonb_array_elements(
                  CASE WHEN jsonb_typeof(j2.commission_split->'splits') = 'array'
                       THEN j2.commission_split->'splits' ELSE '[]'::jsonb END
                ) s
       ) r
       WHERE lower(r.recipient) = lower(btrim(p.full_name))
     )
   ORDER BY p.full_name
   LIMIT 1;

  IF v_referenced_name IS NOT NULL THEN
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_referenced_name, 'sales_rep', true;
      RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_POSTFLIGHT_FAILED';
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'uq_profiles_active_full_name_ci' THEN
          RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_POSTFLIGHT_WRONG_CONSTRAINT: %', v_constraint;
        END IF;
      WHEN OTHERS THEN
        IF SQLERRM = 'PROFILE_NAME_UNIQUE_POSTFLIGHT_FAILED' THEN
          RAISE;
        END IF;
        -- FK to auth.users firing first is tolerated (as in 20260722144121):
        -- the exact-expression catalog assertion above already covers the
        -- index; anything else is a genuine wrong error.
        IF SQLSTATE <> '23503' THEN
          RAISE EXCEPTION 'PROFILE_NAME_UNIQUE_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
  END IF;
END;
$postflight$;
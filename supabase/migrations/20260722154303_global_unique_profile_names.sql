-- Global (active + inactive) unique profile names (Codex push-proof HIGH #3,
-- 2026-07-22).
--
-- Final variant of the name-identity attack chain: pre-position an INACTIVE
-- profile B with the same name as active profile A BEFORE any split
-- references the name (the reuse guard checks references at acquisition
-- time, so an unreferenced name is acquirable), then later deactivate A and
-- reactivate B — reactivation under an unchanged name is the deliberate
-- original-holder carve-out and cannot distinguish B from A without stored
-- ids. Terminal closure: normalized-name uniqueness across ALL profiles,
-- active or not. A doppelgänger can then never exist in any state, so the
-- reactivation carve-out has nothing to hijack. (Blank/NULL names stay
-- exempt via the index predicate; the commission validator already rejects
-- blank recipients.) Trade-off, accepted: a new user can never take exactly
-- the name of ANY existing profile, including deactivated ones — the admin
-- fix is renaming the departed profile first (rename-away is always
-- allowed), which the reuse guard still gates if the name is referenced.
-- The durable id-based-splits redesign remains the tracked follow-up.

SET LOCAL lock_timeout = '5s';

LOCK TABLE public.profiles IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_guard_hash text;
  v_dup_count integer;
BEGIN
  SELECT md5(p.prosrc)
    INTO v_guard_hash
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._guard_recipient_name_reuse()');

  IF v_guard_hash IS DISTINCT FROM '0b74292a2961d22ffd266b8ef25103e3' THEN
    RAISE EXCEPTION 'NAME_REUSE_GUARD_BASELINE_DRIFT: %', v_guard_hash;
  END IF;

  SELECT count(*)
    INTO v_dup_count
    FROM (
      SELECT 1
        FROM public.profiles
       WHERE NULLIF(btrim(full_name), '') IS NOT NULL
       GROUP BY lower(btrim(full_name))
      HAVING count(*) > 1
    ) d;

  IF v_dup_count <> 0 THEN
    RAISE EXCEPTION 'PROFILE_NAME_GLOBAL_DEDUP_REQUIRED: % duplicate names across all profiles', v_dup_count;
  END IF;
END;
$preflight$;

-- Supersedes the active-only partial index from 20260722144121: the global
-- index enforces a strict superset of that uniqueness, so the partial one
-- is dropped rather than kept redundant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_full_name_ci
  ON public.profiles (lower(btrim(full_name)))
  WHERE NULLIF(btrim(full_name), '') IS NOT NULL;

DROP INDEX IF EXISTS public.uq_profiles_active_full_name_ci;

DO $postflight$
DECLARE
  v_test_name text;
  v_constraint text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND indexname = 'uq_profiles_full_name_ci'
       AND indexdef LIKE '%UNIQUE%'
       AND indexdef LIKE '%lower(btrim(full_name))%'
       AND indexdef LIKE '%WHERE (NULLIF(btrim(full_name)%'
  ) THEN
    RAISE EXCEPTION 'PROFILE_NAME_GLOBAL_INDEX_MISSING_OR_WRONG';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'uq_profiles_active_full_name_ci'
  ) THEN
    RAISE EXCEPTION 'PROFILE_NAME_PARTIAL_INDEX_NOT_DROPPED';
  END IF;

  -- Behavioral: inserting an INACTIVE row with an existing (non-referenced,
  -- so the reuse guard passes) name must now hit the GLOBAL index — this is
  -- exactly the pre-positioning step the attack chain needed. BEFORE-trigger
  -- ordering and the random id/email keep the row from ever landing.
  SELECT '  ' || upper(p.full_name) || ' '
    INTO v_test_name
    FROM public.profiles p
   WHERE NULLIF(btrim(p.full_name), '') IS NOT NULL
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

  IF v_test_name IS NOT NULL THEN
    BEGIN
      INSERT INTO public.profiles (id, email, full_name, role, is_active)
      SELECT gen_random_uuid(), gen_random_uuid() || '@postflight.invalid', v_test_name, 'sales_rep', false;
      RAISE EXCEPTION 'PROFILE_NAME_GLOBAL_POSTFLIGHT_FAILED';
    EXCEPTION
      WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'uq_profiles_full_name_ci' THEN
          RAISE EXCEPTION 'PROFILE_NAME_GLOBAL_POSTFLIGHT_WRONG_CONSTRAINT: %', v_constraint;
        END IF;
      WHEN OTHERS THEN
        IF SQLERRM = 'PROFILE_NAME_GLOBAL_POSTFLIGHT_FAILED' THEN
          RAISE;
        END IF;
        -- FK to auth.users firing first is tolerated (established pattern);
        -- the exact-expression catalog assertion above covers the index.
        IF SQLSTATE <> '23503' THEN
          RAISE EXCEPTION 'PROFILE_NAME_GLOBAL_POSTFLIGHT_WRONG_ERROR: % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
  END IF;
END;
$postflight$;
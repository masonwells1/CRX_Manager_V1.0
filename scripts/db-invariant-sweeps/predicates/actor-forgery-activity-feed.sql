-- predicate (j): actor-forgery-activity-feed
-- Authenticated SECURITY DEFINER functions must not accept an actor-shaped
-- parameter and use it to write activity_feed.performed_by without the
-- canonical auth.uid() mismatch guard. This directly prevents the 2026-07-19
-- save_field attribution finding from returning.
-- Contract: zero rows. Do not allowlist a function that trusts a supplied
-- actor at this audit sink; bind auth.uid() and raise ACTOR_MISMATCH instead.

WITH actor_params AS (
  SELECT p.oid,
         p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosrc,
         a.argname
  FROM pg_proc p
  CROSS JOIN LATERAL unnest(coalesce(p.proargnames, '{}'::text[])) AS a(argname)
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind = 'f'
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND a.argname ~* '^p_.*(performed_by|actor|user)'
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM actor_params
WHERE prosrc ~* 'insert\s+into\s+(public\.)?activity_feed'
  AND prosrc ~* 'performed_by'
  AND prosrc !~* 'ACTOR_MISMATCH'
ORDER BY violation_key;

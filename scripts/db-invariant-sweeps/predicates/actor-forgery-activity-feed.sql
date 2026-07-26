-- predicate (j): actor-forgery-activity-feed
-- Authenticated SECURITY DEFINER functions must not accept an actor-shaped
-- parameter and write activity_feed.performed_by without a semantic auth.uid()-
-- bound mismatch guard. The exception text is deliberately NOT the test: safe
-- functions may use a noncanonical error token. This directly prevents the
-- 2026-07-19 save_field attribution finding from returning.
-- Contract: zero rows, no allowlist. Existing canonical ACTOR_MISMATCH guards
-- remain accepted; the semantic detector extends coverage to safe
-- noncanonical guards. A supplied actor at this audit sink must be compared
-- against auth.uid() (or a local initialized from it) and a mismatch must
-- raise before the write.

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
),
auth_bound_locals AS (
  -- Accept both `v_actor := auth.uid()` and declaration-time initialization
  -- (`v_actor uuid := auth.uid()`), retaining the actual local name.
  SELECT ap.oid, lower(m[1]) AS actor_local
  FROM actor_params ap
  CROSS JOIN LATERAL regexp_matches(
    ap.prosrc,
    '\m([a-z_][a-z0-9_]*)\M\s+[a-z_][a-z0-9_]*(?:\[\])?\s*:=\s*auth\.uid\s*\(\s*\)',
    'gi'
  ) AS m
  UNION
  SELECT ap.oid, lower(m[1]) AS actor_local
  FROM actor_params ap
  CROSS JOIN LATERAL regexp_matches(
    ap.prosrc,
    '\m([a-z_][a-z0-9_]*)\M\s*:=\s*auth\.uid\s*\(\s*\)',
    'gi'
  ) AS m
),
semantic_mismatch_guards AS (
  SELECT DISTINCT ap.oid
  FROM actor_params ap
  WHERE
    -- Direct auth.uid() comparison (either operand order; all current
    -- mismatch operators are accepted). The RAISE must belong to the IF.
    ap.prosrc ~* (
      'if(.|\n){0,160}' || ap.argname || '\s*(is\s+distinct\s+from|<>|!=)\s*' ||
      'auth\.uid\s*\(\s*\)\s*then(.|\n){0,240}raise\s+exception'
    )
    OR ap.prosrc ~* (
      'if(.|\n){0,160}auth\.uid\s*\(\s*\)\s*' ||
      '(is\s+distinct\s+from|<>|!=)\s*' || ap.argname ||
      '\s*then(.|\n){0,240}raise\s+exception'
    )
    OR EXISTS (
      SELECT 1
      FROM auth_bound_locals abl
      WHERE abl.oid = ap.oid
        AND (
          ap.prosrc ~* (
            'if(.|\n){0,160}' || ap.argname || '\s*' ||
            '(is\s+distinct\s+from|<>|!=)\s*' || abl.actor_local ||
            '\s*then(.|\n){0,240}raise\s+exception'
          )
          OR ap.prosrc ~* (
            'if(.|\n){0,160}' || abl.actor_local || '\s*' ||
            '(is\s+distinct\s+from|<>|!=)\s*' || ap.argname ||
            '\s*then(.|\n){0,240}raise\s+exception'
          )
        )
    )
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM actor_params
WHERE prosrc ~* 'insert\s+into\s+(public\.)?activity_feed'
  AND prosrc ~* 'performed_by'
  AND prosrc !~* 'ACTOR_MISMATCH'
  AND oid NOT IN (SELECT oid FROM semantic_mismatch_guards)
ORDER BY violation_key;

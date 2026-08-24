-- predicate (c): actor-forgery   (over-broad BY DESIGN — allowlist the semantic-safe ones)
-- authenticated-executable SECDEF routines that take an actor-shaped parameter (p_%by / p_actor% / p_user%)
-- AND appear to role-check, COALESCE, use that parameter in a MERGE, or forward it to another callable/operator,
-- WITHOUT raising the canonical ACTOR_MISMATCH token.
-- Would have caught (the recurring six-date actor-forgery class): save_blend_ticket (2026-06-08),
--   cancel_return (2026-06-08), restore_cancelled_order/restore_cancelled_delivery (2026-06-08),
--   the 9 strict-actor RPCs of 2026-06-09 (void_payment, reopen_accounting_period, ...), batch_apply_all_prepayments
--   / batch_void_invoices (2026-05-30), reverse_write_off (2026-05-30), save_job (2026-06-09).
-- Contract: over-broad by design. EXPECT a handful of hits; allowlist the ones verified safe against live
--   pg_get_functiondef — i.e. the actor parameter is attribution-only and authorization derives from
--   auth.uid()/a role helper (the allocate_payment precedent), OR the function DOES strict-actor-check but
--   raises a NON-canonical string ('actor mismatch' with a space, not the ACTOR_MISMATCH token). A hit that
--   authorizes off the forgeable parameter with no auth.uid() bind is a REAL escalation — fix, don't allowlist.
-- False-positive modes documented in allowlist justifications (non-canonical token; attribution-only param).

WITH cand AS (
  SELECT p.oid,
         p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosrc,
         a.argname,
         regexp_replace(a.argname, '([][(){}.*+?^$|\\])', '\\\1', 'g') AS argname_pattern,
         a.input_position
  FROM pg_proc p
  CROSS JOIN LATERAL (
    SELECT named.argname,
           named.ordinality,
           count(*) FILTER (
             WHERE coalesce(p.proargmodes[named.ordinality], 'i'::"char") IN ('i', 'b', 'v')
           ) OVER (ORDER BY named.ordinality) AS input_position
    FROM unnest(coalesce(p.proargnames, '{}'::text[])) WITH ORDINALITY AS named(argname, ordinality)
  ) AS a
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind IN ('f', 'p')
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND coalesce(p.proargmodes[a.ordinality], 'i'::"char") IN ('i', 'b', 'v')
    AND a.argname ~* '^p_\w*by$|^p_actor|^p_user'
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM cand
WHERE prosrc !~* 'ACTOR_MISMATCH'
  AND (prosrc ~* ('coalesce\s*\(\s*(\m' || argname_pattern || '\M|\$' || input_position || '\M)')
       OR prosrc ~* ('(\m' || argname_pattern || '\M|\$' || input_position || '\M)\s*,\s*auth\.uid')
       OR prosrc ~* ('role[^;]{0,120}(\m' || argname_pattern || '\M|\$' || input_position || '\M)')
       OR prosrc ~* ('(\m' || argname_pattern || '\M|\$' || input_position || '\M)[^;]{0,120}role')
       OR prosrc ~* ('merge\s+into[^;]*(\m' || argname_pattern || '\M|\$' || input_position || '\M)')
       OR prosrc ~* ('\m([[:alpha:]_][[:alnum:]_$]*\s*\.\s*)*[[:alpha:]_][[:alnum:]_$]*\s*\([^;]*(\m' || argname_pattern || '\M|\$' || input_position || '\M)')
       OR prosrc ~* ('(\m' || argname_pattern || '\M|\$' || input_position || '\M)[^;]{0,120}\mOPERATOR\s*\(')
       OR prosrc ~* ('\mOPERATOR\s*\([^;]{0,120}(\m' || argname_pattern || '\M|\$' || input_position || '\M)')
       OR EXISTS (
         SELECT 1
         FROM regexp_matches(
           prosrc,
           '(\m' || argname_pattern || '\M|\$' || input_position || '\M)\s*([-+*/\\<>=~!@#%^&|`?]+)',
           'gi'
         ) AS actor_operator(parts)
         WHERE (actor_operator.parts)[2] NOT IN ('=', '<>', '!=', '<', '<=', '>', '>=')
       )
       OR EXISTS (
         SELECT 1
         FROM regexp_matches(
           prosrc,
           '([-+*/\\<>=~!@#%^&|`?]+)\s*(\m' || argname_pattern || '\M|\$' || input_position || '\M)',
           'gi'
         ) AS operator_actor(parts)
         WHERE (operator_actor.parts)[1] NOT IN ('=', '<>', '!=', '<', '<=', '>', '>=')
       )
  )
ORDER BY violation_key;

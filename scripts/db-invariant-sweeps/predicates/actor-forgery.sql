-- predicate (c): actor-forgery   (over-broad BY DESIGN — allowlist the semantic-safe ones)
-- authenticated-executable SECDEF routines that take an actor-shaped parameter (p_%by / p_actor% / p_user%)
-- AND appear to role-check or COALESCE that parameter, WITHOUT raising the canonical ACTOR_MISMATCH token.
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
         a.argname
  FROM pg_proc p
  CROSS JOIN LATERAL unnest(coalesce(p.proargnames, '{}'::text[])) AS a(argname)
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind IN ('f', 'p')
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND a.argname ~* '^p_\w*by$|^p_actor|^p_user'
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM cand
WHERE prosrc !~* 'ACTOR_MISMATCH'
  AND (prosrc ~* ('coalesce\s*\(\s*' || argname)
       OR prosrc ~* (argname || '\s*,\s*auth\.uid')
       OR prosrc ~* ('role[^;]{0,120}' || argname)
       OR prosrc ~* (argname || '[^;]{0,120}role'))
ORDER BY violation_key;

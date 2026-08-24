-- predicate (i): actor-forgery into the financial audit log   (blind-spot closer for predicate (c))
-- Authenticated-executable SECDEF routines that reference a forgeable actor-shaped parameter
-- (p_%by / p_actor% / p_user%) INSIDE a financial_audit_log INSERT, WITHOUT raising the canonical
-- ACTOR_MISMATCH token. financial_audit_log is append-only / immutable (a CLAUDE.md hard red line), so
-- stamping its actor (actor_user_id / actor_role) from a caller-supplied id lets an authenticated
-- admin/sales_rep forge WHO performed a money-ledger event. This is the exact class fixed for
-- link_blend_ticket_to_order / unlink_blend_ticket_from_order in migration 20260617171500 (Live
-- Foundation Gauntlet Section 1 HIGH, 2026-06-17) -- both wrote p_performed_by into
-- financial_audit_log.actor_user_id (+ derived actor_role from it) with no ACTOR_MISMATCH guard.
--
-- Why a SECOND actor predicate (this does NOT replace predicate (c) actor-forgery): predicate (c)
-- only fires when the param is used near a role-derivation or COALESCE (its four heuristics). A
-- function that writes the raw param straight into financial_audit_log with NO 'role' word and no
-- coalesce nearby (pure attribution) slips predicate (c) entirely -- that is the blind spot. This
-- predicate keys on the audit-log sink itself, so an attribution-only forgery into the immutable
-- money ledger is caught regardless of how the param reaches the row. The [^;]* span stops at the
-- first statement terminator, so a match is confined to the single financial_audit_log INSERT.
--
-- Would have caught: link_blend_ticket_to_order / unlink_blend_ticket_from_order (pre-20260617171500).
--
-- Contract: over-broad by design (the param could appear in the INSERT's new_values jsonb as data, not
-- as the actor). Allowlist a hit ONLY after verifying against live pg_get_functiondef that the audit
-- actor (actor_user_id AND any actor_role lookup) derives from auth.uid() / a v_actor := auth.uid()
-- bind -- i.e. the param is benign / attribution-only and authorization is off auth.uid(). A hit whose
-- audit actor derives from the forgeable param is a REAL finding -- fix it with the canonical
-- strict-actor block (v_actor := auth.uid(); RAISE ACTOR_MISMATCH on p_*by IS DISTINCT FROM v_actor;
-- stamp every audit write from v_actor), exactly as 20260617171500 did -- do NOT allowlist it.

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
  AND prosrc ~* ('financial_audit_log[^;]*(\m' || argname_pattern || '\M|\$' || input_position || '\M)')
ORDER BY violation_key;

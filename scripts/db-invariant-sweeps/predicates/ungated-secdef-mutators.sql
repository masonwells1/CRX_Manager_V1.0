-- predicate (b): ungated-secdef-mutators   *** the round-2 definitive predicate, as a standing gate ***
-- authenticated-executable SECURITY DEFINER functions whose body performs DML (INSERT/UPDATE/DELETE)
-- but references NONE of: auth.uid() / require_admin / is_admin / is_sales_rep.
-- Would have caught: the 2026-06-09 Codex round-2 class — the 10 ungated authenticated-callable SECDEF
--   mutators (apply_remaining_prepayments, create_planned_holds, create_quote_from_template,
--   create_quote_version, rollover_quote_to_season, save_quote_template, create_job_from_quote_section,
--   save_blend_ticket_fields, batch_approve_blend_tickets, batch_reject_blend_tickets) that a name-pattern
--   sweep missed; also 2026-06-09 save_job (B3). This is the predicate the team discovered DURING round 2
--   and never made standing — here it is standing.
-- Contract: EXPECT ZERO unallowlisted rows. A hit is a function any authenticated user can call to mutate
--   data with no role gate. Allowlist ONLY entries verified semantic-safe against live pg_get_functiondef
--   (e.g. a function gated transitively by an in-transaction helper call, or an insert-only logging helper
--   with a deliberate no-gate disposition). NEVER allowlist a genuine escalation.
-- Known approximation: a function gated via a HELPER CALL (e.g. PERFORM require_admin_or_sales_rep()) whose
--   helper name doesn't contain the literal tokens above will be flagged — adjudicate via the live body and
--   confirm the helper runs in-transaction (so failure rolls back the mutation) before allowlisting.

SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS violation_key,
       p.proname
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND p.prokind = 'f'
  AND p.prorettype <> 'pg_catalog.trigger'::regtype
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND p.prosrc ~* '(insert\s+into|update\s+\S+\s+set|delete\s+from)'
  AND p.prosrc !~* 'auth\.uid'
  AND p.prosrc !~* 'require_admin'
  AND p.prosrc !~* 'is_admin'
  AND p.prosrc !~* 'is_sales_rep'
ORDER BY violation_key;

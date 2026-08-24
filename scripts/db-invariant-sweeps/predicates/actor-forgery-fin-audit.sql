-- predicate (i): actor-forgery into the financial audit log   (blind-spot closer for predicate (c))
-- Authenticated-executable SECDEF routines that reference a forgeable actor-shaped parameter
-- (p_%by / p_actor% / p_user%) INSIDE a financial_audit_log INSERT before an executable, uncaught
-- canonical ACTOR_MISMATCH refusal. financial_audit_log is append-only / immutable (a CLAUDE.md hard red line), so
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

WITH RECURSIVE cand AS (
  SELECT p.oid,
         p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosrc,
         a.argname,
         regexp_replace(a.argname, '([][(){}.*+?^$|\\])', '\\\1', 'g') AS argname_pattern,
         a.ordinality AS argument_position,
         a.argtype = 'pg_catalog.uuid'::regtype AS actor_is_uuid
  FROM pg_proc p
  CROSS JOIN LATERAL (
    SELECT named.argname,
           named.ordinality,
           typed.argtype
    FROM unnest(coalesce(p.proargnames, '{}'::text[])) WITH ORDINALITY AS named(argname, ordinality)
    JOIN unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS typed(argtype, ordinality)
      USING (ordinality)
  ) AS a
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind IN ('f', 'p')
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND coalesce(p.proargmodes[a.ordinality], 'i'::"char") IN ('i', 'b', 'v')
    AND a.argname ~* '^p_\w*by$|^p_actor|^p_user'
), lexer (
  oid, proname, args, prosrc, argname, argname_pattern,
  argument_position, actor_is_uuid, scan_pos, executable_src, lex_error
) AS (
  SELECT cand.*, 1, ''::text COLLATE "C", false
  FROM cand

  UNION ALL

  SELECT l.oid, l.proname, l.args, l.prosrc, l.argname, l.argname_pattern,
         l.argument_position, l.actor_is_uuid,
         CASE WHEN step.lex_error THEN char_length(l.prosrc) + 1
              ELSE l.scan_pos + step.consume END,
         l.executable_src || CASE WHEN step.mask_token
           THEN repeat(' ', step.consume)
           ELSE left(src.rest, step.consume)
         END,
         step.lex_error
  FROM lexer l
  CROSS JOIN LATERAL (
    SELECT substr(l.prosrc, l.scan_pos) AS rest
  ) src
  CROSS JOIN LATERAL (
    SELECT substring(src.rest FROM '^(--[^\r\n]*(?:\r\n|\r|\n|$))') AS line_token,
           (regexp_match(src.rest, '^(/\*.*?\*/)', 's'))[1] AS block_token,
           substring(src.rest FROM '^((?:[eE]|[uU]&)?''(?:[^''\\]|''''|\\.)*'')') AS string_token,
           substring(src.rest FROM '^(\$\$|\$[^0-9$[:space:]][^$[:space:]]*\$)') AS dollar_tag
  ) token
  CROSS JOIN LATERAL (
    SELECT CASE WHEN token.dollar_tag IS NULL THEN 0 ELSE
      position(token.dollar_tag IN substr(src.rest, length(token.dollar_tag) + 1))
    END AS dollar_close
  ) closing
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN token.line_token IS NOT NULL THEN length(token.line_token)
             WHEN token.block_token IS NOT NULL THEN length(token.block_token)
             WHEN token.string_token IS NOT NULL THEN length(token.string_token)
             WHEN token.dollar_tag IS NOT NULL AND closing.dollar_close > 0
               THEN (2 * length(token.dollar_tag)) + closing.dollar_close - 1
             ELSE 1
           END AS consume,
           token.line_token IS NOT NULL OR token.block_token IS NOT NULL OR
             (token.string_token IS NOT NULL AND NOT (
               upper(token.string_token) = '''ACTOR_MISMATCH'''
               AND l.executable_src ~* '\mRAISE\s+EXCEPTION\s*$'
             )) OR
             (token.dollar_tag IS NOT NULL AND closing.dollar_close > 0) AS mask_token,
           src.rest LIKE '*/%' OR
             (src.rest LIKE '/*%' AND token.block_token IS NULL) OR
             (src.rest ~ '^(?:[eE]|[uU]&)?''' AND token.string_token IS NULL) OR
             (token.dollar_tag IS NOT NULL AND closing.dollar_close = 0) AS lex_error
  ) step
  WHERE l.scan_pos <= char_length(l.prosrc)
    AND NOT l.lex_error
), lexed AS (
  SELECT oid, proname, args, prosrc, argname, argname_pattern,
         argument_position, actor_is_uuid, executable_src, lex_error
  FROM lexer
  WHERE lex_error OR scan_pos > char_length(prosrc)
), guarded AS (
  SELECT lexed.*,
         actor_is_uuid
         AND executable_src ~* (
           '^\s*\mDECLARE\M.*?\mv_actor\M\s+(?:pg_catalog\s*\.\s*)?uuid\M'
           || '(?:\s+NOT\s+NULL)?[^;]*;.*?\mBEGIN\M'
         )
         AND executable_src ~* (
           '\mv_actor\M\s*:=\s*auth\s*\.\s*uid\s*\(\s*\)\s*;.*?'
           || '\mIF\M[^;]*(?:\m' || argname_pattern || '\M|\$' || argument_position || '\M)'
           || '\s+IS\s+DISTINCT\s+FROM\s+v_actor\M[^;]*'
           || '\mTHEN\M\s*\mRAISE\s+EXCEPTION\s+''ACTOR_MISMATCH''[^;]*;'
         ) AS has_bound_local_refusal
  FROM lexed
), analyzed AS (
  SELECT guarded.*,
         CASE
           WHEN lex_error OR NOT actor_is_uuid OR executable_src ~* '\mEXCEPTION\s+WHEN\M'
             THEN executable_src
           ELSE regexp_replace(
             executable_src,
             '('
               || '\mIF\M[^;]*(?:\m' || argname_pattern || '\M|\$' || argument_position || '\M)'
               || '\s+IS\s+DISTINCT\s+FROM\s+auth\s*\.\s*uid\s*\(\s*\)[^;]*'
               || '\mTHEN\M\s*\mRAISE\s+EXCEPTION\s+''ACTOR_MISMATCH''[^;]*;'
               || CASE WHEN has_bound_local_refusal THEN
                    '|\mIF\M[^;]*(?:\m' || argname_pattern || '\M|\$' || argument_position || '\M)'
                    || '\s+IS\s+DISTINCT\s+FROM\s+v_actor\M[^;]*'
                    || '\mTHEN\M\s*\mRAISE\s+EXCEPTION\s+''ACTOR_MISMATCH''[^;]*;'
                  ELSE '' END
             || ').*$',
             '',
             'is'
           )
         END AS pre_refusal_src
  FROM guarded
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM analyzed
WHERE lex_error OR
      pre_refusal_src ~* ('financial_audit_log[^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
ORDER BY violation_key;

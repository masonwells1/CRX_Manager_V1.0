-- predicate (c): actor-forgery   (over-broad BY DESIGN — allowlist the semantic-safe ones)
-- authenticated-executable SECDEF routines that take an actor-shaped parameter (p_%by / p_actor% / p_user%)
-- AND appear to role-check, COALESCE, use that parameter in a MERGE, or forward it to another callable/operator
-- BEFORE raising the canonical ACTOR_MISMATCH token.
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
           -- A handler can catch a nested/outer refusal. Fail closed rather
           -- than trying to prove PL/pgSQL exception-block nesting in SQL.
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
      (pre_refusal_src ~* ('coalesce\s*\(\s*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('(\m' || argname_pattern || '\M|\$' || argument_position || '\M)\s*,\s*auth\.uid')
       OR pre_refusal_src ~* ('role[^;]{0,120}(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('(\m' || argname_pattern || '\M|\$' || argument_position || '\M)[^;]{0,120}role')
       OR pre_refusal_src ~* ('merge\s+into[^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('\m([[:alpha:]_][[:alnum:]_$]*\s*\.\s*)*[[:alpha:]_][[:alnum:]_$]*\s*\([^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('(\m' || argname_pattern || '\M|\$' || argument_position || '\M)[^;]{0,120}\mOPERATOR\s*\(')
       OR pre_refusal_src ~* ('\mOPERATOR\s*\([^;]{0,120}(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR EXISTS (
         SELECT 1
         FROM regexp_matches(
           pre_refusal_src,
           '(\m' || argname_pattern || '\M|\$' || argument_position || '\M)(?:\s*\)|\s*::\s*[[:alpha:]_"][[:alnum:]_$".]*|\s*\.\s*[[:alpha:]_"][[:alnum:]_$"]*|\s*\[[^;\]]*\]|\s+AS\s+[[:alpha:]_"][[:alnum:]_$".]*\s*\))*\s*([-+*/\\<>=~!@#%^&|`?]+)',
           'gi'
         ) AS actor_operator(parts)
       )
       OR EXISTS (
         SELECT 1
         FROM regexp_matches(
           pre_refusal_src,
           '([-+*/\\<>=~!@#%^&|`?]+)\s*(?:(?:CAST\s*)?\(\s*)*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)',
           'gi'
         ) AS operator_actor(parts)
       )
  )
ORDER BY violation_key;

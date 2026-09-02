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
), src_rows AS (
  -- Lex each routine ONCE. A routine with two actor-shaped parameters used to
  -- be lexed once per parameter, and the whole prosrc rode along in recursive
  -- state; both are dropped here.
  SELECT DISTINCT oid, prosrc FROM cand
), lexer (oid, src_len, scan_pos, executable_src, lex_error) AS (
  SELECT oid, char_length(prosrc), 1, ''::text COLLATE "C", false
  FROM src_rows

  UNION ALL

  SELECT l.oid, l.src_len,
         CASE WHEN step.lex_error THEN l.src_len + 1
              ELSE l.scan_pos + step.consume END,
         l.executable_src || CASE WHEN step.mask_token
           THEN repeat(' ', step.consume)
           ELSE left(src.rest, step.consume)
         END,
         step.lex_error
  FROM lexer l
  JOIN src_rows s ON s.oid = l.oid
  CROSS JOIN LATERAL (
    SELECT substr(s.prosrc, l.scan_pos) AS rest
  ) src
  CROSS JOIN LATERAL (
    -- A string's escape rules are decided by the token BEFORE its opening
    -- quote, not by re-reading a prefix at the quote. `RAISE NOTICE'x'` ends
    -- in E only because NOTICE does, so the prefix must not be word-adjacent.
    SELECT l.executable_src ~ '(?:^|[^[:alnum:]_$"])[eE]$' AS escape_prefix
  ) ctx
  CROSS JOIN LATERAL (
    SELECT substring(src.rest FROM '^(--[^\r\n]*(?:\r\n|\r|\n|$))') AS line_token,
           (regexp_match(src.rest, '^(/\*.*?\*/)', 's'))[1] AS block_token,
           -- Only E'...' honours backslash escapes. In an ordinary or U&
           -- string a trailing backslash is DATA, so `'ends with \'` closes at
           -- its own quote; applying the escape branch there swallowed the
           -- closing quote and masked every statement up to the next quote.
           CASE WHEN ctx.escape_prefix
                THEN substring(src.rest FROM '^(''(?:[^''\\]|''''|\\.)*'')')
                ELSE substring(src.rest FROM '^(''(?:[^'']|'''')*'')')
           END AS string_token,
           substring(src.rest FROM '^(\$\$|\$[^0-9$[:space:]][^$[:space:]]*\$)') AS dollar_tag,
           -- Maximal run of characters that cannot begin any token, so the
           -- recursion advances by words instead of one character at a time.
           substring(src.rest FROM '^[^''$/*-]+') AS plain_run
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
             WHEN token.plain_run IS NOT NULL THEN length(token.plain_run)
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
             (src.rest LIKE '''%' AND token.string_token IS NULL) OR
             (token.dollar_tag IS NOT NULL AND closing.dollar_close = 0) AS lex_error
  ) step
  WHERE l.scan_pos <= l.src_len
    AND NOT l.lex_error
), lexed AS (
  SELECT cand.oid, cand.proname, cand.args, cand.argname, cand.argname_pattern,
         cand.argument_position, cand.actor_is_uuid, l.executable_src, l.lex_error
  FROM lexer l
  JOIN cand ON cand.oid = l.oid
  WHERE l.lex_error OR l.scan_pos > l.src_len
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
         ) AS has_bound_local_refusal,
         -- A PL/pgSQL IN parameter is an ordinary writable local, so the
         -- canonical refusal proves nothing about the value that reached the
         -- sinks: stash the caller value in a local, overwrite the parameter
         -- with auth.uid(), raise a textually perfect ACTOR_MISMATCH that can
         -- never fire, then use the stash.
         --
         -- Pinned to STATEMENT position, and that is load-bearing rather than
         -- tidiness: PL/pgSQL named-argument syntax is lexically identical to
         -- assignment, so an unpinned match also flags the safe
         -- `PERFORM f(p_delivery_id := x, p_performed_by := v_actor)`. Live
         -- batch_cancel_deliveries is exactly that shape and binds its actor
         -- correctly. A named argument is always preceded by `(` or `,`; an
         -- assignment statement follows a terminator or a block opener.
         executable_src ~* (
           '(?:;|\mBEGIN\M|\mTHEN\M|\mELSE\M|\mLOOP\M|\mDECLARE\M|^)\s*(?:<<[^>]*>>\s*)?'
           || '\m' || argname_pattern || '\M\s*(?:\[[^\]]*\])?\s*:='
         ) AS has_actor_rebinding
  FROM lexed
), analyzed AS (
  SELECT guarded.*,
         CASE
           -- A handler can catch a nested/outer refusal. Fail closed rather
           -- than trying to prove PL/pgSQL exception-block nesting in SQL.
           --
           -- Rebinding also stops the refusal being credited, so the whole body
           -- is scanned rather than truncated at it. Note this is NOT on its own
           -- enough to report the routine: when the sink uses the stashed local
           -- instead of the parameter, no detection pattern below matches even
           -- with the full body in scope. `has_actor_rebinding` is therefore ALSO
           -- a reportable condition in its own right, in the final WHERE.
           WHEN lex_error OR NOT actor_is_uuid OR executable_src ~* '\mEXCEPTION\s+WHEN\M'
                OR has_actor_rebinding
             THEN executable_src
           -- The refusal is credited only when it is UNCONDITIONAL. Two ways it
           -- can fail to be, and both used to truncate the whole scanned body:
           --   * a block opened before it and still open at it -- checked by
           --     balancing IF/LOOP/CASE over the text preceding the match;
           --   * a block opened INSIDE the match. `[^;]*` reaches across any
           --     semicolon-free header, so `IF false THEN <refusal>` matches
           --     from the OUTER IF and leaves a balanced-looking prefix --
           --     checked by requiring the matched refusal statement to contain
           --     exactly one IF and no loop or CASE opener.
           -- A CASE *expression* before the refusal also reads as unclosed,
           -- which costs an extra finding and never hides one.
           WHEN stripped.prefix IS DISTINCT FROM executable_src
                AND NOT (blocks.if_tokens = 2 * blocks.end_if
                         AND blocks.loop_tokens = 2 * blocks.end_loop
                         AND blocks.case_tokens = 2 * blocks.end_case
                         AND blocks.stmt_if = 1
                         AND blocks.stmt_loop = 0
                         AND blocks.stmt_case = 0)
             THEN executable_src
           ELSE stripped.prefix
         END AS pre_refusal_src
  FROM guarded
  CROSS JOIN LATERAL (
    SELECT regexp_replace(
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
           ) AS prefix
  ) stripped
  CROSS JOIN LATERAL (
    -- The matched refusal statement: from where the strip began through the
    -- semicolon that ends it. The match itself is semicolon-free until then.
    SELECT coalesce(
             substring(substr(executable_src, char_length(stripped.prefix) + 1) FROM '^[^;]*;'),
             ''
           ) AS stmt
  ) refusal
  CROSS JOIN LATERAL (
    SELECT array_length(regexp_split_to_array(upper(stripped.prefix), '\mIF\M'), 1) - 1 AS if_tokens,
           array_length(regexp_split_to_array(upper(stripped.prefix), '\mEND\s+IF\M'), 1) - 1 AS end_if,
           array_length(regexp_split_to_array(upper(stripped.prefix), '\mLOOP\M'), 1) - 1 AS loop_tokens,
           array_length(regexp_split_to_array(upper(stripped.prefix), '\mEND\s+LOOP\M'), 1) - 1 AS end_loop,
           array_length(regexp_split_to_array(upper(stripped.prefix), '\mCASE\M'), 1) - 1 AS case_tokens,
           array_length(regexp_split_to_array(upper(stripped.prefix), '\mEND\s+CASE\M'), 1) - 1 AS end_case,
           array_length(regexp_split_to_array(upper(refusal.stmt), '\mIF\M'), 1) - 1 AS stmt_if,
           array_length(regexp_split_to_array(upper(refusal.stmt), '\mLOOP\M'), 1) - 1 AS stmt_loop,
           array_length(regexp_split_to_array(upper(refusal.stmt), '\mCASE\M'), 1) - 1 AS stmt_case
  ) blocks
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM analyzed
-- has_actor_rebinding reports on its own: a SECURITY DEFINER routine that
-- overwrites its own actor parameter cannot be cleared by reading the refusal,
-- and the value that reaches the sink may be a local this predicate does not
-- track. Over-broad by design, like every other arm here -- allowlist the ones
-- verified safe against live pg_get_functiondef.
WHERE lex_error OR has_actor_rebinding OR
      (pre_refusal_src ~* ('coalesce\s*\(\s*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('(\m' || argname_pattern || '\M|\$' || argument_position || '\M)\s*,\s*auth\.uid')
       OR pre_refusal_src ~* ('role[^;]{0,120}(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('(\m' || argname_pattern || '\M|\$' || argument_position || '\M)[^;]{0,120}role')
       OR pre_refusal_src ~* ('merge\s+into[^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
       OR pre_refusal_src ~* ('(?:(?:"(?:[^"]|"")*"|[[:alpha:]_][[:alnum:]_$]*)\s*\.\s*)*(?:"(?:[^"]|"")*"|[[:alpha:]_][[:alnum:]_$]*)\s*\([^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
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

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
    -- The name pattern alone is not a definition of "actor". `^p_\w*by$` also
    -- matches `p_group_by` -- a text grouping mode ('customer'/'product'/'month')
    -- in get_profitability_report and get_sales_summary_report -- and
    -- complete_delivery.p_signed_by, a signature NAME. Those are not identities
    -- and there is nothing about them to forge, but the type gate below is the
    -- honest reason to drop them rather than naming them one by one: this
    -- predicate's entire premise is a comparison against auth.uid(), which
    -- returns uuid, so a parameter that cannot be compared to it cannot be the
    -- actor this predicate reasons about.
    --
    -- uuid OR any user-defined type. The second half is load-bearing and must not
    -- be simplified away to `= uuid`: the operator-overload attack class works by
    -- giving the actor a COMPOSITE type whose `=` runs a mutating function, so
    -- restricting candidacy to uuid would blind this predicate to exactly the
    -- shape actor_overloaded_equality / actor_reverse_equality pin. What is
    -- excluded is only the remaining built-in scalars -- text, integer, date --
    -- which cannot carry an identity in this schema.
    --
    -- Trade-off, stated rather than hidden: a text-typed actor parameter written
    -- straight into an attribution column is now out of scope for this sweep.
    -- Actor columns in this schema are uuid foreign keys, so that shape does not
    -- exist today; if one is ever introduced, this gate is where it goes blind.
    AND (a.argtype = 'pg_catalog.uuid'::regtype
         OR (SELECT t.typnamespace <> 'pg_catalog'::regnamespace
             FROM pg_type t WHERE t.oid = a.argtype))
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
  -- Whitespace runs are collapsed to a single space ONCE, here, and every
  -- downstream test reads this collapsed text. The lexer masks each comment and
  -- string literal to a whitespace run of the SAME LENGTH as the original, so a
  -- large routine carries runs thousands of characters long. Every `\s*` sitting
  -- in front of a required token then lets the engine try each split of such a
  -- run at each candidate position; with the trailing 'ACTOR_MISMATCH' literal
  -- gone there is no longer a rare anchor making those positions fail on their
  -- first character, and the sweep timed out against the live catalog.
  --
  -- Collapsing is the fix rather than bounding every quantifier, because
  -- PostgreSQL caps the expansion of bounded repeats and a fully bounded refusal
  -- pattern is rejected outright with "invalid repetition count(s)".
  --
  -- Safe for every downstream consumer: masked machine content is already
  -- content-free, so a masked literal reading as one space rather than nine
  -- hundred changes nothing about which tokens are present. The IF/LOOP/CASE
  -- balance counts are token counts, and the refusal-statement slice indexes into
  -- this same collapsed text.
  SELECT cand.oid, cand.proname, cand.args, cand.argname, cand.argname_pattern,
         cand.argument_position, cand.actor_is_uuid,
         regexp_replace(l.executable_src, '\s+', ' ', 'g') AS executable_src,
         l.lex_error
  FROM lexer l
  JOIN cand ON cand.oid = l.oid
  WHERE l.lex_error OR l.scan_pos > l.src_len
  -- Fence: keeps the whitespace collapse above from being re-run per reference.
  OFFSET 0
), guarded AS (
  SELECT lexed.*,
         shape.refusal_authuid,
         shape.refusal_vactor,
         actor_is_uuid
         AND executable_src ~* (
           '^\s*\mDECLARE\M.*?\mv_actor\M\s+(?:pg_catalog\s*\.\s*)?uuid\M'
           || '(?:\s+NOT\s+NULL)?[^;]*;.*?\mBEGIN\M'
         )
         -- The actor local may be bound EITHER by a DECLARE initializer
         -- (`v_actor uuid := auth.uid();`) or by a separate assignment statement
         -- after BEGIN. Live code uses both, and requiring only the statement
         -- form left 17 correctly-guarded routines reported.
         --
         -- Ordering -- the binding must precede the refusal, or a v_actor
         -- assigned only afterwards would be compared as NULL -- is enforced by
         -- comparing MATCH POSITIONS rather than by joining the two patterns with
         -- `.*?`. That lazy bridge is quadratic: for every binding position the
         -- engine retries the refusal at every later offset.
         --
         -- These stay INLINE in the AND chain rather than moving to a LATERAL.
         -- A CROSS JOIN LATERAL is evaluated for every row, so hoisting them
         -- there ran the refusal scan against all 129 live candidates including a
         -- 75KB body, and the sweep timed out. In the AND chain the cheap tests
         -- gate the expensive ones, which is how the original stayed affordable.
         AND regexp_instr(executable_src, shape.binding_re, 1, 1, 0, 'i') > 0
         AND regexp_instr(executable_src, shape.refusal_vactor, 1, 1, 0, 'i')
             > regexp_instr(executable_src, shape.binding_re, 1, 1, 0, 'i')
           AS has_bound_local_refusal,
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
         -- `:?=` because PL/pgSQL accepts BOTH `:=` and plain `=` as the
         -- assignment operator; the write-time hook already treats the `=`
         -- spelling as a rebinding, and a sweep that matched only `:=` would
         -- have left the cheaper spelling open. Statement pinning is what makes
         -- accepting `=` safe: a bare `=` at statement position is an
         -- assignment, whereas the comparison `IF p_x = y THEN` is preceded by
         -- `IF`, and the named-argument `f(p_x => v)` by `(` or `,`.
         executable_src ~* (
           '(?:;|\mBEGIN\M|\mTHEN\M|\mELSE\M|\mLOOP\M|\mDECLARE\M|^)\s*(?:<<[^>]*>>\s*)?'
           || '\m' || argname_pattern || '\M\s*(?:\[[^\]]*\])?\s*:?='
         ) AS has_actor_rebinding
  FROM lexed
  CROSS JOIN LATERAL (
    SELECT '(?:\m' || argname_pattern || '\M|\$' || argument_position || '\M)' AS actor_ref
  ) ref
  CROSS JOIN LATERAL (
    -- Refusal SHAPE, deliberately message-agnostic (Mason's 2026-09-02 decision).
    -- The guard is credited for what it DOES -- compare the actor parameter to the
    -- caller identity and RAISE EXCEPTION when they differ -- not for one exact
    -- message literal. Live code uses at least four spellings ('ACTOR_MISMATCH',
    -- 'ACTOR_MISMATCH: <detail>', 'Actor mismatch', and 'p_performed_by does not
    -- match authenticated user'); demanding the bare canonical literal reported 13
    -- correctly-guarded routines as violations.
    --
    -- `RAISE EXCEPTION` then `[^;]*;` is safe against a message containing a
    -- semicolon because the lexer has already masked every string literal to
    -- equal-length whitespace -- there is no punctuation left inside the message
    -- to derail the statement terminator.
    --
    -- The optional `<actor> IS NOT NULL AND` prefix is the null-tolerant form:
    -- the parameter is attribution-only when omitted and must match the caller
    -- when supplied. It is a legitimate guard, and 10 live routines use it.
    -- `<>` and `!=` are accepted alongside IS DISTINCT FROM; on a NOT NULL-guarded
    -- operand they are equivalent, and the null-tolerant prefix is what makes that
    -- true.
    -- `[\s(]*` / `[\s)]*` rather than `\s*\(*\s*` / `\s*\)*\s*`: the old spelling
    -- is ambiguous -- two quantified groups that can each match the empty string
    -- around the same whitespace -- so every FAILED match position backtracks
    -- through the split. That was affordable while the trailing literal
    -- 'ACTOR_MISMATCH' anchored the match and made most positions fail on the
    -- first character. Message-agnostic matching removes that anchor, and the
    -- ambiguous form then times out on live. A single character class matches the
    -- same text with no split to reconsider.
    -- `[(\s]` not `[\s(]`, purely so the read guard's `identifier(` heuristic
    -- does not read the class's own `s` as a function name and refuse the
    -- statement. Identical character class, different member order.
    SELECT '\mIF\M[(\s]*'
           || '(?:' || ref.actor_ref || '\s+IS\s+NOT\s+NULL\s+AND[(\s]+)?'
           || ref.actor_ref
           || '(?:\s+IS\s+DISTINCT\s+FROM\s+|\s*(?:<>|!=)\s*)' AS refusal_head,
           '[\s)]*\mTHEN\M\s*\mRAISE\s+EXCEPTION\M[^;]*;' AS refusal_tail
  ) frag
  CROSS JOIN LATERAL (
    -- String assembly only -- no scanning happens here, so this stays a LATERAL.
    --
    -- `\M\s*(?:` rather than `\M(?:` in binding_re: the live-data read guard
    -- parses an identifier character immediately followed by `(` as a function
    -- call and refuses the whole statement, which would make this predicate
    -- unrunnable through the sanctioned MCP path. Same match, spelled so the
    -- character before the group is `*`.
    SELECT frag.refusal_head || 'auth\s*\.\s*uid\s*\(\s*\)' || frag.refusal_tail AS refusal_authuid,
           frag.refusal_head || '\mv_actor\M' || frag.refusal_tail AS refusal_vactor,
           '(?:\mv_actor\M\s+(?:pg_catalog\s*\.\s*)?uuid\M\s*(?:NOT\s+NULL\s*)?:=\s*auth\s*\.\s*uid\s*\(\s*\)\s*;'
           || '|\mv_actor\M\s*:=\s*auth\s*\.\s*uid\s*\(\s*\)\s*;)' AS binding_re
  ) shape
  -- Fence, same reason as the one at the end of `analyzed`: without it the
  -- refusal scans here are re-evaluated once per downstream reference.
  OFFSET 0
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
    -- Same shape fragments the credit test uses, so a refusal can never be
    -- accepted by one and rejected by the other.
    --
    -- Taking the text BEFORE the first refusal by match position, rather than
    -- `regexp_replace(src, '(RE).*$', '')`. Identical result -- both yield the
    -- prefix preceding the first match -- but the `.*$` form makes the engine
    -- carry a to-end-of-body match at every candidate position, which is the
    -- other half of the live timeout. `left(src, pos - 1)` costs one scan.
    SELECT CASE WHEN hit.pos > 0 THEN left(executable_src, hit.pos - 1)
                ELSE executable_src END AS prefix
    FROM (
      SELECT regexp_instr(
               executable_src,
               '(' || refusal_authuid
                   || CASE WHEN has_bound_local_refusal THEN '|' || refusal_vactor
                      ELSE '' END
               || ')',
               1, 1, 0, 'i'
             ) AS pos
    ) hit
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
  -- OPTIMIZATION FENCE -- load-bearing, not leftover debris.
  --
  -- `pre_refusal_src` is referenced by TEN separate arms in the final WHERE. A
  -- plain CTE is inlined by PostgreSQL 12+, and the inlined expression is then
  -- re-evaluated per reference -- so each row re-ran the refusal scan and the six
  -- IF/LOOP/CASE splits up to ten times. That was survivable while most routines
  -- matched the first cheap arm and stopped; once the shape fixes above began
  -- crediting real guards, correctly-guarded routines fell through EVERY arm and
  -- the sweep timed out against the live catalog. `OFFSET 0` is a no-op that
  -- blocks subquery pull-up, so the CASE is evaluated once per row.
  --
  -- `AS MATERIALIZED` is the clearer spelling and was the first choice, but the
  -- live-data read guard parses `MATERIALIZED (` as a function call and refuses
  -- the whole statement, which would make this predicate unrunnable through the
  -- MCP path that `run-sweeps.mjs` uses on Mason's machine. Same fence, no clash.
  OFFSET 0
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
       -- Plain `~*`, not `EXISTS (SELECT 1 FROM regexp_matches(..., 'gi'))`.
       -- Identical meaning -- both ask whether at least one match exists -- but
       -- the set-returning form with the `g` flag ENUMERATES EVERY MATCH in the
       -- body before EXISTS can stop, while `~*` returns on the first.
       --
       -- This became the dominant cost once the refusal shapes above began
       -- crediting real guards. Previously most routines were caught by one of
       -- the cheap arms higher in this OR chain and never reached here; now that
       -- correctly-guarded routines fall through every cheap arm, all of them
       -- arrive at these two, and enumerating every operator match across the
       -- live catalog timed the sweep out.
       OR pre_refusal_src ~* ('(\m' || argname_pattern || '\M|\$' || argument_position || '\M)(?:\s*\)|\s*::\s*[[:alpha:]_"][[:alnum:]_$".]*|\s*\.\s*[[:alpha:]_"][[:alnum:]_$"]*|\s*\[[^;\]]*\]|\s+AS\s+[[:alpha:]_"][[:alnum:]_$".]*\s*\))*\s*([-+*/\\<>=~!@#%^&|`?]+)')
       OR pre_refusal_src ~* ('([-+*/\\<>=~!@#%^&|`?]+)\s*(?:(?:CAST\s*)?\(\s*)*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')
  )
ORDER BY violation_key;

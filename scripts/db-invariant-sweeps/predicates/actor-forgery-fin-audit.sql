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
    -- Mirror of actor-forgery.sql: the name pattern is not a definition of
    -- "actor". uuid, OR a user-defined type (keeps the composite
    -- operator-overload class in scope -- never simplify to `= uuid`), OR any
    -- other type the body actually uses as an identity by casting it to uuid or
    -- comparing it to auth.uid(). That third arm answers the Codex HIGH on
    -- c1beab619: `p_user_id text` cast `p_user_id::uuid` into actor_user_id is a
    -- real forgery shape, and a blanket type exclusion dropped it from scope.
    -- What remains excluded is only a name ending in "by" that is never cast and
    -- never compared to the caller.
    AND (a.argtype = 'pg_catalog.uuid'::regtype
         OR (SELECT t.typnamespace <> 'pg_catalog'::regnamespace
             FROM pg_type t WHERE t.oid = a.argtype)
         OR p.prosrc ~* ('\m' || regexp_replace(a.argname, '([][(){}.*+?^$|\\])', '\\\1', 'g')
                         || '\M\s*(?:\)\s*)*::\s*(?:pg_catalog\s*\.\s*)?uuid\M')
         OR p.prosrc ~* ('\m' || regexp_replace(a.argname, '([][(){}.*+?^$|\\])', '\\\1', 'g')
                         || '\M[^;]{0,120}auth\s*\.\s*uid'))
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
  -- Whitespace runs collapsed to a single space ONCE, here (mirror of
  -- actor-forgery.sql). The lexer masks each comment and string literal to a
  -- whitespace run of the same LENGTH, and a message-agnostic refusal pattern
  -- backtracks across those runs badly enough to time the sweep out against the
  -- live catalog. Bounding the quantifiers instead is not available: PostgreSQL
  -- caps bounded-repeat expansion and rejects the pattern. Masked content is
  -- content-free, so collapsing it changes no token the analysis reads.
  SELECT cand.oid, cand.proname, cand.args, cand.argname, cand.argname_pattern,
         cand.argument_position, cand.actor_is_uuid,
         regexp_replace(l.executable_src, '\s+', ' ', 'g') AS executable_src,
         l.lex_error,
         -- Raw, unlexed source. Used ONLY for the sink-PRESENCE test below.
         -- The lexer masks string and dollar-quoted bodies, so a dynamic write
         -- (EXECUTE 'INSERT INTO financial_audit_log ...') vanishes from
         -- executable_src and the routine drops out of this predicate's scope
         -- entirely, while its actor parameter stays plainly visible. Scope must
         -- therefore be decided on raw source. Every ANALYSIS test keeps using
         -- the lexed source, so masked text still cannot forge a refusal.
         cand.prosrc AS raw_src
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
         -- Mirror of actor-forgery.sql: the actor local may be bound by a DECLARE
         -- initializer or by an assignment statement, and the binding must still
         -- precede the refusal -- enforced by comparing match POSITIONS, because
         -- bridging the two patterns with `.*?` is quadratic. Kept INLINE in the
         -- AND chain, not hoisted to a LATERAL: a LATERAL is evaluated for every
         -- row, which ran the refusal scan against all 129 live candidates
         -- including a 75KB body and timed the sweep out.
         AND regexp_instr(executable_src, shape.binding_re, 1, 1, 0, 'i') > 0
         AND regexp_instr(executable_src, shape.refusal_vactor, 1, 1, 0, 'i')
             > regexp_instr(executable_src, shape.binding_re, 1, 1, 0, 'i')
         -- Mirror of actor-forgery.sql: no re-assignment of v_actor between its
         -- auth.uid() binding and the refusal, or the refusal compares the actor
         -- against a caller-poisoned local and proves nothing. Codex P1.
         AND substr(
               executable_src,
               regexp_instr(executable_src, shape.binding_re, 1, 1, 1, 'i'),
               greatest(regexp_instr(executable_src, shape.refusal_vactor, 1, 1, 0, 'i')
                        - regexp_instr(executable_src, shape.binding_re, 1, 1, 1, 'i'), 0)
             ) !~* '\mv_actor\M\s*:?='
           AS has_bound_local_refusal,
         -- Mirror of actor-forgery.sql. A PL/pgSQL IN parameter is a writable
         -- local, so a stash-then-rebind makes the canonical refusal unfireable
         -- while the stashed caller value reaches the audit sink. Pinned to
         -- STATEMENT position because named-argument syntax is lexically
         -- identical to assignment (live batch_cancel_deliveries is that shape
         -- and is correctly bound).
         -- `:?=` because PL/pgSQL accepts both `:=` and plain `=` as the
         -- assignment operator. Statement pinning is what makes accepting `=`
         -- safe. Mirror of actor-forgery.sql.
         executable_src ~* (
           '(?:;|\mBEGIN\M|\mTHEN\M|\mELSE\M|\mLOOP\M|\mDECLARE\M|^)\s*(?:<<[^>]*>>\s*)?'
           || '\m' || argname_pattern || '\M\s*(?:\[[^\]]*\])?\s*:?='
         ) AS has_actor_rebinding
  FROM lexed
  CROSS JOIN LATERAL (
    SELECT '(?:\m' || argname_pattern || '\M|\$' || argument_position || '\M)' AS actor_ref
  ) ref
  CROSS JOIN LATERAL (
    -- Mirror of actor-forgery.sql. Refusal credited by SHAPE, not by one exact
    -- message literal (Mason's 2026-09-02 decision): live code uses four
    -- spellings and two binding forms. `[(\s]`/`[\s)]` rather than the ambiguous
    -- `\s*\(*\s*`, both to avoid catastrophic backtracking once the trailing
    -- literal no longer anchors the match, and so the read guard's `identifier(`
    -- heuristic does not read a class member as a function name.
    -- Mirror of actor-forgery.sql: `<>`/`!=` accepted ONLY behind an explicit
    -- `<actor> IS NOT NULL AND` guard, because a bare `p_actor <> auth.uid()`
    -- yields NULL for a NULL actor and the refusal never fires. `IS DISTINCT
    -- FROM` is NULL-safe and stays acceptable on its own.
    SELECT '\mIF\M[(\s]*'
           || '(?:'
           ||   '(?:' || ref.actor_ref || '\s+IS\s+NOT\s+NULL\s+AND[(\s]+' || ref.actor_ref
           ||     '(?:\s+IS\s+DISTINCT\s+FROM\s+|\s*(?:<>|!=)\s*))'
           ||   '|'
           ||   '(?:' || ref.actor_ref || '\s+IS\s+DISTINCT\s+FROM\s+)'
           || ')' AS refusal_head,
           '[\s)]*\mTHEN\M\s*\mRAISE\s+EXCEPTION\M[^;]*;' AS refusal_tail
  ) frag
  CROSS JOIN LATERAL (
    -- String assembly only -- no scanning happens here, so this stays a LATERAL.
    -- `\M\s*(?:` not `\M(?:` in binding_re so the live-data read guard does not
    -- parse the identifier-then-paren as a function call and refuse the statement.
    SELECT frag.refusal_head || 'auth\s*\.\s*uid\s*\(\s*\)' || frag.refusal_tail AS refusal_authuid,
           frag.refusal_head || '\mv_actor\M' || frag.refusal_tail AS refusal_vactor,
           '(?:\mv_actor\M\s+(?:pg_catalog\s*\.\s*)?uuid\M\s*(?:NOT\s+NULL\s*)?:=\s*auth\s*\.\s*uid\s*\(\s*\)\s*;'
           || '|\mv_actor\M\s*:=\s*auth\s*\.\s*uid\s*\(\s*\)\s*;)' AS binding_re
  ) shape
  -- Fence, same reason as the one at the end of `analyzed`.
  OFFSET 0
), analyzed AS (
  SELECT guarded.*,
         CASE
           -- Rebinding stops the refusal being credited, so the whole body is
           -- scanned. That alone does not report the routine when the sink uses
           -- a stashed local, so has_actor_rebinding is ALSO reportable on its
           -- own in the final WHERE. Mirrors actor-forgery.sql.
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
    -- accepted by one and rejected by the other. Prefix taken by match position
    -- rather than by `(RE).*$`, which forces a to-end-of-body match attempt at
    -- every candidate position -- the other half of the live timeout.
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
  -- OPTIMIZATION FENCE -- load-bearing (mirror of actor-forgery.sql).
  -- `pre_refusal_src` is referenced by several arms in the final WHERE. A plain
  -- CTE is inlined by PostgreSQL 12+ and the expression re-evaluated per
  -- reference, so each row re-ran the refusal scan and the six IF/LOOP/CASE
  -- splits once per arm. `AS MATERIALIZED` is the clearer spelling but the
  -- live-data read guard parses `MATERIALIZED (` as a function call and refuses
  -- the statement, which would make this predicate unrunnable through the MCP
  -- path `run-sweeps.mjs` uses. `OFFSET 0` is the same fence with no clash.
  OFFSET 0
)
SELECT DISTINCT proname || '(' || args || ')' AS violation_key,
       argname AS suspect_param
FROM analyzed
WHERE lex_error OR
      -- Reportable on its own, scoped to this predicate's audit-log remit: a
      -- routine that writes financial_audit_log AND overwrites its own actor
      -- parameter cannot be cleared by reading its refusal, and the value that
      -- reaches the sink may be a local this predicate does not track.
      -- Sink PRESENCE is decided on raw_src, never on the lexed source: a
      -- dynamic `EXECUTE 'INSERT INTO financial_audit_log ...'` is masked out of
      -- executable_src, which silently removed the routine from this predicate's
      -- scope while its actor parameter stayed visible.
      (raw_src ~* 'financial_audit_log' AND has_actor_rebinding) OR
      pre_refusal_src ~* ('financial_audit_log[^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)') OR
      -- RAW-SOURCE correlation, restored from the base predicate (Codex HIGH,
      -- exact-SHA review of c1beab619). The lexed arm above cannot see a DYNAMIC
      -- audit write, because the whole statement lives inside a string literal
      -- that the lexer masks:
      --
      --   EXECUTE 'INSERT INTO public.financial_audit_log(actor_user_id) VALUES ($1)'
      --     USING p_performed_by;
      --
      -- `financial_audit_log` vanishes from executable_src, and `USING
      -- p_performed_by` is not inside a callable expression, so neither the lexed
      -- arm nor the forwarding arm below fires and the routine is cleared. The
      -- base predicate on `main` reports it, because it correlates the table name
      -- and the actor on RAW source within one statement. That coverage was lost
      -- when the lexer arrived in PR #449 and is restored here rather than
      -- documented as a residual -- forged authorship reaching the immutable
      -- financial ledger is the exact class this predicate exists to catch.
      --
      -- Scoped to exactly that case: the sink is present in RAW source but absent
      -- from the LEXED body, which is only true when the write is hidden inside a
      -- masked literal. An ordinary `INSERT INTO financial_audit_log …` stays
      -- visible in executable_src and is handled by the arm above, on the correct
      -- side of the refusal.
      --
      -- Scoping matters and the first attempt got it wrong: an unconditional raw
      -- correlation also reported actor_safe_refusal_forward, which stamps its
      -- actor parameter AFTER a credited refusal that already proved the parameter
      -- equals auth.uid(). That is a legitimate pattern, and reporting it would
      -- have been a fresh false positive introduced while closing a false
      -- negative. When the sink IS invisible we cannot tell whether it sits before
      -- or after the refusal, so this arm fails closed and reports -- consistent
      -- with the rest of this predicate.
      --
      -- Costs nothing against the live catalog: measured read-only 2026-09-02,
      -- ZERO of the 131 candidate routines place an actor-shaped parameter inside
      -- a financial_audit_log statement (27 touch the table; all stamp from a
      -- bound local), and none writes the ledger dynamically.
      (raw_src ~* 'financial_audit_log'
       AND executable_src !~* 'financial_audit_log'
       AND raw_src ~* ('financial_audit_log[^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)')) OR
      (raw_src ~* 'financial_audit_log' AND
       pre_refusal_src ~* ('(?:(?:"(?:[^"]|"")*"|[[:alpha:]_][[:alnum:]_$]*)\s*\.\s*)*(?:"(?:[^"]|"")*"|[[:alpha:]_][[:alnum:]_$]*)\s*\([^;]*(\m' || argname_pattern || '\M|\$' || argument_position || '\M)'))
ORDER BY violation_key;

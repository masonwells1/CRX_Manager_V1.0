-- predicate: office-only pricing SECDEF gates survive
--
-- Standing regression guard for the 2026-07-27 SECDEF pricing-bypass audit, closed by
-- 20260728123224_secdef_pricing_reads_office_only (applied live 2026-07-28 under ledger version
-- 20260728182141 -- reconcile on `name`, not `version`).
--
-- Background: 20260727231652_quote_and_rate_reads_office_only restricted SELECT on quote_items /
-- quote_versions / customer_application_rates / rebate_programs to `is_admin() OR is_sales_rep()`.
-- SECURITY DEFINER bypasses RLS by design, so that table policy cannot reach a SECDEF reader -- the
-- role check has to live in the function body. An audit found 20 such readers; 18 were already
-- gated. The two that were not are pinned here:
--
--   compute_application_service_fee -- returned customer price (rate_per_acre_cents) AND internal
--   cost (cost_per_acre_cents) in one response to a real active `driver`, i.e. margin was one
--   subtraction away. It has no frontend caller, so the React route guard was never in the path.
--
--   get_program_completion -- returns per-customer farm names, quote numbers, acreage and
--   invoiced_amount_cents. Called from OfficeCockpit.tsx and ProgramTracker.tsx.
--
-- Why a standing sweep and not a postflight block inside the migration: a `DO $$ ... $$` postflight
-- runs exactly once, at apply time. The failure mode that actually matters here is a LATER
-- `CREATE OR REPLACE` re-emitting either body without the gate -- the pending-migration
-- overlap-clobber class -- which a one-shot postflight cannot see. This predicate re-checks on every
-- sweep run, so it catches the regression whenever it is introduced.
--
-- Rows returned = violations. Seven distinct failure modes, each with its own `reason`:
--   function_missing_or_signature_changed -- the pinned signature no longer resolves
--   missing_in_body_gate  -- the body lost the null-session test, the office-role predicate, the
--                            insufficient_privilege SQLSTATE, or the guard moved after the first read
--   not_secdef_or_no_search_path -- SECURITY DEFINER dropped, or search_path is no longer exactly
--                            `public, pg_temp`
--   duplicate_overload    -- a second signature appeared; callers may bind to the ungated one
--   authenticated_exec_restored -- the direct PostgREST route back into the fee calculator reopened
--   office_rpc_grant_lost -- INVERSE check: get_program_completion must KEEP EXECUTE for
--                            `authenticated`, or OfficeCockpit and ProgramTracker go offline for the
--                            office. Losing it is a worse outcome than the leak that was closed, and
--                            a sweep that only looked for excess access would never notice.
--   anon_exec_present     -- either function became callable by the unauthenticated role
--
-- Contract: exact-name, not heuristic -- it pins two named functions and their expected end state,
-- so a hit is a REAL regression. Do NOT allowlist a hit here. Re-apply the gate in a new,
-- later-dated migration instead. If either function is ever intentionally retired, delete its rows
-- from this predicate in the same change that retires it.
--
-- Verified against live 2026-07-28: zero rows, both functions resolved.
--
-- Mutation-tested against the live bodies the same date, so the zero above is not vacuous. Fifteen
-- mutations, each fired the correct arm, and the unmutated control fired neither:
--    1 null-session test removed          9 whole gate line-commented with `--`
--    2 office-role predicate weakened    10 whole gate wrapped in a /* */ block comment
--    3 SQLSTATE downgraded               11 gate DELETED, text parked in a single-quoted literal
--    4 error-label tokens kept, checks   12 gate DELETED, parked in `$lit$` (letters-only tag)
--      deleted                           13 SECURITY DEFINER dropped
--    5 guard relocated after the read    14 gate DELETED, parked in `$guard1$` (DIGIT in the tag)
--    6 search_path=attacker, pg_temp     15 gate DELETED, parked in `$phase3_x$` (repo-style tag)
--    7 non-canonical search_path spelling
--    8 proconfig dropped entirely
-- 9 and 10 motivated `exec_src`; 11 and 12 motivated `code_src`; 14 and 15 forced the dollar-quote tag
-- grammar to be widened -- both of them PASSED an earlier revision of this file that matched only
-- letters-and-underscore tags.
--
-- When re-running this set, capture the gate with a regex whose FIRST quantifier is non-greedy
-- (`'(IF auth\.uid\(\) IS NULL THEN.*?END IF;.*?END IF;)'`). A leading `\s+` silently makes the whole
-- match greedy -- it swallowed 1625 of 2464 body chars including the protected read, which made the
-- relocation mutation move the gate and the read TOGETHER and report a false clean. The bug was in the
-- test harness, not the predicate, which is exactly the kind of green that means nothing.
--
-- KNOWN LIMIT -- this is a regression ALARM, not a proof of enforcement. It reads catalog text, so it
-- establishes that the guard is present, correctly shaped, executable rather than inert, and positioned
-- ahead of the read; it cannot establish that the guard is REACHABLE. Guards neutered into comments or
-- into string literals ARE caught (see `exec_src` / `code_src` below), but a body that satisfies every
-- arm while burying the checks in a branch that never executes -- inside `IF false THEN`, or after an
-- unconditional RETURN -- would still pass. Static analysis cannot close that gap.
-- So: a green sweep is necessary, never sufficient. Whenever either body is re-emitted, prove the
-- gate the way the original fix was proven -- impersonate a real non-office JWT
-- (`set_config('request.jwt.claims', ...)` + `SET LOCAL ROLE authenticated`) and confirm SQLSTATE
-- 42501, with an active admin as the positive control. A service_role/postgres call proves nothing
-- here: `auth.uid()` is NULL for those, so both functions raise AUTH_REQUIRED for the wrong reason
-- and look blocked even with the office-role check deleted.

-- Resolve with `to_regprocedure('public.' || signature)`, NOT by comparing `oid::regprocedure::text`
-- and NOT against pg_get_function_identity_arguments.
--   pg_get_function_identity_arguments includes parameter NAMES ('p_service_id uuid, ...'), so a
--   signature-only comparison against it never matches and every check below would report a
--   spurious missing function.
--   `oid::regprocedure::text` renders search_path-dependently: it drops the schema only when the
--   function is visible on the current path, and schema-qualifies it otherwise. A sweep session that
--   does not expose `public` (a hardened `SET search_path = pg_catalog` runner, for instance) would
--   render 'public.compute_application_service_fee(...)', miss the comparison, and raise a false
--   `function_missing_or_signature_changed`. Explicit qualification resolves the same OID on any
--   path; verified live -- both signatures resolve to the identical OID either way.
-- `read_pattern` locates the first read of the RLS-restricted table each body pulls pricing from. It
-- exists so the gate can be checked for POSITION, not just presence: a rewrite that leaves the guard
-- behind as a trailing comment or as dead code after the read would satisfy a presence-only check
-- while leaking. The gate must appear BEFORE the first read.
--
-- It matches `FROM`/`JOIN <table>` rather than the bare table name on purpose. A bare-name strpos
-- lands on the gate's OWN explanatory comment, which names the table it protects -- observed live,
-- where that put the "read" at offset 293 and the guard at 574 and reported a false violation.
-- Comment stripping now removes that particular collision on its own; the anchor stays anyway, because
-- it also keeps the position check off table names appearing in string literals or column aliases.
WITH target(signature, needs_authenticated_exec, read_pattern) AS (
  VALUES
    ('compute_application_service_fee(uuid,uuid,numeric,integer)', false,
     '(?:from|join)\s+(?:public\.)?customer_application_rates'),
    ('get_program_completion(integer)', true,
     '(?:from|join)\s+(?:public\.)?quote_items')
),
-- No body check below runs against raw prosrc. Text that LOOKS like the guard but cannot execute --
-- because it sits in a comment, or inside a string literal -- would otherwise satisfy every regex and
-- every position check while the leak is fully reopened. Both are cheap ways to disable the gate while
-- leaving the alarm green, so two derived texts are computed instead, and each check reads the one that
-- is correct for it:
--
--   exec_src -- comments stripped. Block comments first, then line comments, so a `--` inside a /* */
--     span cannot leave a dangling tail. This is what the SQLSTATE check reads, and ONLY the SQLSTATE
--     check, because 'insufficient_privilege' is itself a string literal: stripping literals would make
--     that arm unsatisfiable and the predicate would false-alarm forever on a perfectly healthy body.
--     Verified live -- literal-stripping turns the SQLSTATE arm false on both untouched functions.
--
--   code_src -- exec_src with dollar-quoted then single-quoted string literals also blanked. Everything
--     structural reads this: the null-session test, the office-role predicate, and both positions. The
--     guard's own code contains no string literals, so this costs the real gate nothing, while a body
--     that deletes the gate and parks its text in a literal ahead of the read scores guard_pos = 0 and
--     fires. Dollar-quoted first, since a `'` inside a $tag$ span would otherwise unbalance the pass.
--
--     Two details of `'\$([^$]*?)\$.*?\$\1\$'` are load-bearing, both learned the hard way:
--       The tag class is `[^$]`, not `[A-Za-z_]`. A dollar-quote tag follows identifier rules, so it may
--       contain DIGITS after the first character -- this repo already ships `$phase3_reversal_preflight$`
--       -- and a letters-only class leaves `$guard1$ ...gate text... $guard1$` unstripped, reopening the
--       exact bypass this CTE exists to close. Proven live: with the letters-only class, a gate parked in
--       `$guard1$` or `$phase3_x$` passed every check; with `[^$]` both fire. The class is deliberately
--       wider than the real grammar (over-stripping is the safe direction), and `\1` requiring the
--       closing tag to EQUAL the opener is what keeps that width from running away -- verified live that
--       `'mismatch $a$ x $b$ tail'` is left untouched, and that nesting collapses correctly.
--
--       The tag quantifier is `*?`, not `*`. Postgres POSIX regex decides greediness for the WHOLE
--       expression from its FIRST quantifier, so a leading greedy tag class makes the following `.*?`
--       greedy too and the strip runs from the first `$tag$` to the LAST one, blanking unrelated code
--       between two separate literals. Demonstrated live: 'keep1 $a$ lit1 $a$ MIDDLE $b$ lit2 $b$ keep2'
--       collapses to 'keep1 ~ keep2' with `*` and to 'keep1 ~ MIDDLE ~ keep2' with `*?`. The same trap
--       applies to the /* */ strip above, which is already safe because `.*?` is its first quantifier.
--
-- Both strips are deliberately naive and may over-blank. That is the safe direction: over-stripping can
-- only DELETE a guard match and raise a false alarm, never manufacture a guard that is not there. A
-- false alarm costs one investigation; a missed leak costs customer pricing. If either strip is ever
-- refined, re-run the mutation set and keep that asymmetry -- and note that the SQLSTATE arm depends on
-- exec_src RETAINING literals, so it is not a candidate for the same treatment.
resolved_raw AS (
  SELECT t.signature,
         t.needs_authenticated_exec,
         t.read_pattern,
         p.oid,
         p.prosecdef,
         p.proconfig,
         regexp_replace(
           regexp_replace(coalesce(p.prosrc, ''), '/\*.*?\*/', ' ', 'gs'),
           '--[^\n]*', ' ', 'g')                                     AS exec_src,
         (SELECT count(*) FROM pg_proc p2
           WHERE p2.pronamespace = 'public'::regnamespace
             AND p2.proname = split_part(t.signature, '(', 1)) AS overloads
  FROM target t
  LEFT JOIN pg_proc p
         ON p.oid = to_regprocedure('public.' || t.signature)
),
resolved AS (
  SELECT r.signature,
         r.needs_authenticated_exec,
         r.oid,
         r.exec_src,
         c.code_src,
         r.prosecdef,
         r.proconfig,
         r.overloads,
         -- Position of the office-role call vs the first guarded-table read, both in executable code.
         -- regexp_instr returns 0 when there is no match; requires PG 15+ (live is 17.6).
         strpos(c.code_src, 'is_sales_rep()')                        AS guard_pos,
         regexp_instr(c.code_src, r.read_pattern, 1, 1, 0, 'i')      AS read_pos
  FROM resolved_raw r
  CROSS JOIN LATERAL (
    SELECT regexp_replace(
             regexp_replace(r.exec_src, '\$([^$]*?)\$.*?\$\1\$', ' ', 'gs'),
             '''(?:[^'']|'''')*''', ' ', 'g') AS code_src
  ) c
),
violation AS (
  -- The function vanished or changed signature: every downstream check below would be
  -- vacuously true against a NULL row, so surface it explicitly.
  SELECT signature AS violation_key,
         'function_missing_or_signature_changed' AS reason
  FROM resolved WHERE oid IS NULL

  UNION ALL
  -- Checks the guard's SHAPE, not its error labels. A presence-only test for the strings
  -- 'AUTH_REQUIRED' / 'INSUFFICIENT_ROLE' is satisfied by a rewrite that keeps those tokens while
  -- deleting the real checks, so all four conditions below are structural: the null-session test, the
  -- office-role predicate, the SQLSTATE the callers see, and the guard's position ahead of the first
  -- guarded-table read. The three structural conditions and both positions read `code_src`, so none can
  -- be satisfied by commented-out text or by guard text parked in a string literal; the SQLSTATE
  -- condition reads `exec_src` because the value it matches IS a literal (see the note above).
  SELECT signature, 'missing_in_body_gate'
  FROM resolved
  WHERE oid IS NOT NULL
    AND (
         code_src !~* 'auth\.uid\(\)\s*IS\s+NULL'
      OR code_src !~* 'NOT\s*\(\s*(public\.)?is_admin\(\)\s*OR\s*(public\.)?is_sales_rep\(\)\s*\)'
      OR exec_src !~* 'ERRCODE\s*=\s*''insufficient_privilege'''
      OR guard_pos = 0
      OR (read_pos > 0 AND guard_pos > read_pos)
    )

  UNION ALL
  -- Exact search_path, not a substring match. '%pg_temp%' would also accept
  -- 'search_path=attacker, pg_temp' -- an attacker-writable schema resolving BEFORE public, which is
  -- the classic SECURITY DEFINER hijack. Only the approved value passes.
  --
  -- The exact string is safe to pin because Postgres normalizes proconfig itself: whatever spacing
  -- the migration writes, a list GUC is stored joined with ', '. Confirmed live -- all 480 public
  -- functions carrying a pg_temp search_path store the identical 'search_path=public, pg_temp',
  -- with zero spacing variants. Do NOT relax this to a LIKE.
  SELECT signature, 'not_secdef_or_no_search_path'
  FROM resolved
  WHERE oid IS NOT NULL
    AND (NOT prosecdef
         OR proconfig IS NULL
         OR NOT (proconfig @> ARRAY['search_path=public, pg_temp']))

  UNION ALL
  SELECT signature, 'duplicate_overload'
  FROM resolved
  WHERE oid IS NOT NULL AND overloads <> 1

  UNION ALL
  -- The fee calculator must stay off the direct PostgREST route.
  SELECT signature, 'authenticated_exec_restored'
  FROM resolved
  WHERE oid IS NOT NULL
    AND NOT needs_authenticated_exec
    AND has_function_privilege('authenticated', oid, 'EXECUTE')

  UNION ALL
  -- INVERSE: the office RPC must keep its grant.
  SELECT signature, 'office_rpc_grant_lost'
  FROM resolved
  WHERE oid IS NOT NULL
    AND needs_authenticated_exec
    AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')

  UNION ALL
  SELECT signature, 'anon_exec_present'
  FROM resolved
  WHERE oid IS NOT NULL
    AND has_function_privilege('anon', oid, 'EXECUTE')
)
SELECT violation_key, reason
FROM violation
ORDER BY violation_key, reason;

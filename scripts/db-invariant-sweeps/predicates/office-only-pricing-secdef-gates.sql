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
-- Mutation-tested against the live bodies the same date, so the zero above is not vacuous. Nine
-- mutations, each fired the correct arm, and the unmutated control fired neither: null-session test
-- removed, office-role predicate weakened, SQLSTATE downgraded, error-label tokens retained while the
-- checks were deleted, guard moved after the read, `search_path=attacker, pg_temp`, a non-canonical
-- search_path spelling, and proconfig dropped entirely.
--
-- KNOWN LIMIT -- this is a regression ALARM, not a proof of enforcement. It reads catalog text, so it
-- establishes that the guard is present, correctly shaped, and positioned ahead of the read; it
-- cannot establish that the guard is REACHABLE. A body that satisfies every arm while burying the
-- checks in a branch that never executes would still pass. Static analysis cannot close that gap.
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
WITH target(signature, needs_authenticated_exec, read_pattern) AS (
  VALUES
    ('compute_application_service_fee(uuid,uuid,numeric,integer)', false,
     '(?:from|join)\s+(?:public\.)?customer_application_rates'),
    ('get_program_completion(integer)', true,
     '(?:from|join)\s+(?:public\.)?quote_items')
),
resolved AS (
  SELECT t.signature,
         t.needs_authenticated_exec,
         p.oid,
         p.prosrc,
         p.prosecdef,
         p.proconfig,
         -- Position of the office-role call vs the first guarded-table read.
         -- regexp_instr returns 0 when there is no match; requires PG 15+ (live is 17.6).
         strpos(p.prosrc, 'is_sales_rep()')                          AS guard_pos,
         regexp_instr(p.prosrc, t.read_pattern, 1, 1, 0, 'i')        AS read_pos,
         (SELECT count(*) FROM pg_proc p2
           WHERE p2.pronamespace = 'public'::regnamespace
             AND p2.proname = split_part(t.signature, '(', 1)) AS overloads
  FROM target t
  LEFT JOIN pg_proc p
         ON p.oid = to_regprocedure('public.' || t.signature)
),
violation AS (
  -- The function vanished or changed signature: every downstream check below would be
  -- vacuously true against a NULL row, so surface it explicitly.
  SELECT signature AS violation_key,
         'function_missing_or_signature_changed' AS reason
  FROM resolved WHERE oid IS NULL

  UNION ALL
  -- Checks the guard's SHAPE, not its error labels. A presence-only test for the strings
  -- 'AUTH_REQUIRED' / 'INSUFFICIENT_ROLE' is satisfied by a rewrite that leaves those tokens in a
  -- comment or in dead code while deleting the real checks, so all four conditions below are
  -- structural: the null-session test, the office-role predicate, the SQLSTATE the callers see, and
  -- the guard's position ahead of the first guarded-table read.
  SELECT signature, 'missing_in_body_gate'
  FROM resolved
  WHERE oid IS NOT NULL
    AND (
         prosrc !~* 'auth\.uid\(\)\s*IS\s+NULL'
      OR prosrc !~* 'NOT\s*\(\s*(public\.)?is_admin\(\)\s*OR\s*(public\.)?is_sales_rep\(\)\s*\)'
      OR prosrc !~* 'ERRCODE\s*=\s*''insufficient_privilege'''
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

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
-- Rows returned = violations. Five distinct failure modes, each with its own `reason`:
--   missing_in_body_gate  -- the body lost its AUTH_REQUIRED / INSUFFICIENT_ROLE pair
--   not_secdef_or_no_search_path -- SECURITY DEFINER or the pinned search_path was dropped
--   duplicate_overload    -- a second signature appeared; callers may bind to the ungated one
--   authenticated_exec_restored -- the direct PostgREST route back into the fee calculator reopened
--   office_rpc_grant_lost -- INVERSE check: get_program_completion must KEEP EXECUTE for
--                            `authenticated`, or OfficeCockpit and ProgramTracker go offline for the
--                            office. Losing it is a worse outcome than the leak that was closed, and
--                            a sweep that only looked for excess access would never notice.
--
-- Contract: exact-name, not heuristic -- it pins two named functions and their expected end state,
-- so a hit is a REAL regression. Do NOT allowlist a hit here. Re-apply the gate in a new,
-- later-dated migration instead. If either function is ever intentionally retired, delete its rows
-- from this predicate in the same change that retires it.
--
-- Verified against live 2026-07-28: zero rows.

-- Match on `oid::regprocedure::text`, NOT pg_get_function_identity_arguments -- the latter includes
-- parameter NAMES ('p_service_id uuid, ...'), so a signature-only comparison against it never
-- matches and every check below would report a spurious missing function.
WITH target(signature, needs_authenticated_exec) AS (
  VALUES
    ('compute_application_service_fee(uuid,uuid,numeric,integer)', false),
    ('get_program_completion(integer)',                            true)
),
resolved AS (
  SELECT t.signature,
         t.needs_authenticated_exec,
         p.oid,
         p.prosrc,
         p.prosecdef,
         array_to_string(p.proconfig, ',') AS config,
         (SELECT count(*) FROM pg_proc p2
           WHERE p2.pronamespace = 'public'::regnamespace
             AND p2.proname = split_part(t.signature, '(', 1)) AS overloads
  FROM target t
  LEFT JOIN pg_proc p
         ON p.pronamespace = 'public'::regnamespace
        AND p.oid::regprocedure::text = t.signature
),
violation AS (
  -- The function vanished or changed signature: every downstream check below would be
  -- vacuously true against a NULL row, so surface it explicitly.
  SELECT signature AS violation_key,
         'function_missing_or_signature_changed' AS reason
  FROM resolved WHERE oid IS NULL

  UNION ALL
  SELECT signature, 'missing_in_body_gate'
  FROM resolved
  WHERE oid IS NOT NULL
    AND (prosrc NOT LIKE '%AUTH_REQUIRED%' OR prosrc NOT LIKE '%INSUFFICIENT_ROLE%')

  UNION ALL
  SELECT signature, 'not_secdef_or_no_search_path'
  FROM resolved
  WHERE oid IS NOT NULL
    AND (NOT prosecdef OR coalesce(config, '') NOT LIKE '%search_path=%pg_temp%')

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

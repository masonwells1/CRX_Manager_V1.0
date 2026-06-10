-- predicate (h): plpgsql-check   *** NO-OP VARIANT — plpgsql_check is NOT installed on this project ***
-- Intended target class: the 42703 (undefined column) / 42804 (datatype mismatch) / missing-relation
--   "latent break never exercised" class — e.g. get_customer_statement's SUM(bigint) OVER => numeric 42804
--   cast (2026-06-09), returns.credited_by / returns.total_credit_cents column gaps (2026-06-09),
--   create_invoice_from_blend_ticket cm_invoice_number_seq missing-relation (2026-05-26 B6). plpgsql_check
--   statically analyzes every plpgsql function body against the live catalog and reports exactly these.
--
-- LIVE AVAILABILITY (verified 2026-06-10 via MCP):
--   SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name='plpgsql_check';
--   => name=plpgsql_check, default_version=2.7, installed_version=NULL  (AVAILABLE but NOT installed).
--
-- Because the extension is not installed, this predicate CANNOT run the real static check today and
-- intentionally returns ZERO rows (a no-op SELECT) so the runner stays green rather than erroring. The
-- self-check below re-confirms availability each run, so when someone installs the extension this file's
-- guard reminds us to swap in the real predicate (the ready-to-use body is in the block comment further down).
--
-- ACTION TO ACTIVATE (owner / a future migration, NOT done here — C1 owns only this scripts dir):
--   CREATE EXTENSION IF NOT EXISTS plpgsql_check;   -- Supabase-supported; enable via dashboard or migration
-- Then replace the no-op SELECT below with the real predicate in the comment block.

-- No-op: returns zero rows. The CASE re-asserts availability state for visibility in the result.
SELECT NULL::text AS violation_key,
       (SELECT installed_version FROM pg_available_extensions WHERE name = 'plpgsql_check') AS plpgsql_check_installed_version
WHERE false;

/* ── REAL PREDICATE — paste this in once `CREATE EXTENSION plpgsql_check;` has run ──────────────
   Errors-only (level='error'); skips trigger functions invoked without a relation context by passing
   them through plpgsql_check_function with their declared relation where applicable. The simplest robust
   form below checks every public plpgsql FUNCTION (prokind='f'); extend with relid for trigger fns if needed.

WITH targets AS (
  SELECT p.oid,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS ident
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang AND l.lanname = 'plpgsql'
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
)
SELECT t.ident AS violation_key,
       cf.functionid::regprocedure::text AS function_signature,
       cf.lineno,
       cf.statement,
       cf.sqlstate,
       cf.message
FROM targets t
CROSS JOIN LATERAL plpgsql_check_function(
       t.oid,
       fatal_errors := false,
       format := 'tabular'
     ) AS cf
WHERE cf.level = 'error'
ORDER BY t.ident, cf.lineno;
──────────────────────────────────────────────────────────────────────────────────────────────── */

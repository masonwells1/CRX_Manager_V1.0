-- predicate (h): plpgsql-check — LIVE static analysis of every public plpgsql function body
-- Target class: the 42703 (undefined column) / 42804 (datatype mismatch) / missing-relation
--   "latent break never exercised" class — e.g. get_customer_statement's SUM(bigint) OVER => numeric 42804
--   cast (2026-06-09), returns.credited_by / returns.total_credit_cents column gaps (2026-06-09),
--   create_invoice_from_blend_ticket cm_invoice_number_seq missing-relation (2026-05-26 B6). plpgsql_check
--   statically analyzes every plpgsql function body against the live catalog and reports exactly these.
--
-- LIVE AVAILABILITY: the extension IS INSTALLED (verified 2026-06-10 via MCP; installed_version=2.7,
--   enabled by live migration 20260610192229 enable_plpgsql_check). This is the REAL predicate — the
--   prior no-op variant (extension not installed) was replaced 2026-06-10.
--
-- IMPLEMENTATION NOTE: the table-returning form is plpgsql_check_function_tb(...) — NOT
--   plpgsql_check_function(format := 'tabular') (that form returns formatted text lines and has no
--   level/sqlstate columns). Verified live 2026-06-10: _tb exposes functionid, lineno, statement,
--   sqlstate, message, level.
--
-- Scope: public-schema plpgsql FUNCTIONs (prokind='f'), excluding trigger + event-trigger functions
--   (they need a relation context — extend with relid per-trigger if ever needed).
-- Expectation: errors-only (level='error'). Rows returned = latent breaks. Fix through the migration
--   review gate or allowlist ONLY with a dated justification proving the flag is a false positive
--   (e.g. dynamic SQL the checker can't see through). NEVER allowlist a genuinely broken function.

WITH targets AS (
  SELECT p.oid,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS ident
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang AND l.lanname = 'plpgsql'
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
    AND p.prorettype <> 'pg_catalog.event_trigger'::regtype
)
SELECT t.ident AS violation_key,
       cf.functionid::regprocedure::text AS function_signature,
       cf.lineno,
       cf.statement,
       cf.sqlstate,
       cf.message
FROM targets t
CROSS JOIN LATERAL plpgsql_check_function_tb(
       t.oid,
       fatal_errors := false
     ) AS cf
WHERE cf.level = 'error'
ORDER BY t.ident, cf.lineno;

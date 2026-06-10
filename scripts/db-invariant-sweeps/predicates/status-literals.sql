-- predicate (g): status-literals   (practical approximation — read the false-positive/negative modes below)
-- For every column governed by a `col = ANY (ARRAY[...])` CHECK constraint (status enums + similar
--   enum-shaped columns), finds function bodies that ASSIGN a string literal to that column which is NOT in
--   the constraint's allowed set. This is the class behind: 'void'/'voided' (status-enum-check hook),
--   'system' vs 'batch' on financial_audit_log.entity_type (2026-05-30 batch_apply_all_prepayments),
--   void_order writing a draft-invoice status the CHECK rejected (2026-05-29), and the entity_type CHECK
--   silently breaking reopen_accounting_period/revert_quote_status audit inserts (2026-06-09).
-- Contract: EXPECT ZERO rows. A hit is a function that writes a literal the live CHECK will reject at
--   runtime (a latent break on the first un-exercised call). Investigate; allowlist ONLY a verified
--   false positive citing the live body.
--
-- APPROXIMATION — this is regex over prosrc, NOT a parser. Known modes:
--   * Allowed-value set is UNIONED PER COLUMN NAME across all tables. A literal valid for tableA.status
--     but written to tableB.status (where it's invalid) is a FALSE NEGATIVE here — the per-migration
--     status-enum-check hook + schema-registry cover that cross-table case at write time. Accepted tradeoff.
--   * Only ASSIGNMENT forms are matched: `SET col = 'lit'` / `, col = 'lit'` (UPDATE) and `col := 'lit'`
--     (PL/pgSQL). `WHERE col = 'lit'` reads are deliberately EXCLUDED (the column must sit directly after
--     SET or a comma, or use the := operator) — this is what suppresses the void_payment
--     `WHERE source_type='overpayment'` false positive.
--   * INSERT ... VALUES positional literals are NOT matched (FALSE NEGATIVE) — positional-to-column mapping
--     isn't recoverable by regex. Covered at write time by the status-enum-check hook.
--   * Dynamic/variable writes (`SET col = v_status`) are invisible (no literal). Accepted.

WITH enum_checks AS (
  SELECT regexp_replace(pg_get_constraintdef(c.oid), '^CHECK \(\((\w+) = ANY.*$', '\1') AS col,
         pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ~ '^CHECK \(\(\w+ = ANY \(ARRAY\['
),
allowed AS (
  SELECT col, array_agg(DISTINCT m[1]) AS vals
  FROM enum_checks ec,
       LATERAL regexp_matches(ec.def, '''([^'']+)''::text', 'g') AS m
  GROUP BY col
),
fns AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosrc
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
),
set_writes AS (
  -- `SET col = 'lit'` or `, col = 'lit'` — column is a direct UPDATE assignment target (not a WHERE read).
  SELECT f.proname, f.args, a.col, lit[1] AS literal_written
  FROM fns f
  JOIN allowed a ON TRUE
  CROSS JOIN LATERAL regexp_matches(
      f.prosrc,
      '(?:\mset\M|,)\s*' || a.col || '\s*=\s*''([^'']+)''',
      'gi') AS lit
),
assign_writes AS (
  -- PL/pgSQL `col := 'lit'` assignment.
  SELECT f.proname, f.args, a.col, lit[1] AS literal_written
  FROM fns f
  JOIN allowed a ON TRUE
  CROSS JOIN LATERAL regexp_matches(
      f.prosrc,
      '\m' || a.col || '\M\s*:=\s*''([^'']+)''',
      'gi') AS lit
),
all_writes AS (
  SELECT * FROM set_writes
  UNION ALL
  SELECT * FROM assign_writes
)
SELECT DISTINCT
       w.proname || '(' || w.args || ')' AS violation_key,
       w.col,
       w.literal_written
FROM all_writes w
JOIN allowed a ON a.col = w.col
WHERE NOT (w.literal_written = ANY (a.vals))
ORDER BY violation_key, w.col, w.literal_written;

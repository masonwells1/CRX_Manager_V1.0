-- =============================================================================
-- fin-commission-split-sum.sql — commission splits must sum to 100
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- IDENTITY
--   Every non-empty commission_split JSON on orders.commission_split,
--   quotes.commission_split, and customers.default_commission_split must
--   satisfy the documented save_customer rule, enforced at write time by
--   validate_commission_split_json (live body transcribed):
--     * shape: object with a 'splits' array ({"splits":[{recipient,percentage}]});
--     * each recipient: non-empty after btrim, unique case-insensitively;
--     * each percentage: numeric, > 0 and <= 100;
--     * ABS(SUM(percentage) - 100) <= 0.01.
--   An empty splits array is valid (means "no split") and is not flagged.
--
-- WOULD HAVE CAUGHT
--   Pre-validator rows that the write-time check can never retroactively fix —
--   commissions are computed from these JSONs, so a 95% or 200% total is a
--   silent mis-payment. This is the standing-data sweep for the rule the RPCs
--   only enforce going forward (the exact class C9 exists for: the write path
--   validates, the historical rows do not).
--
-- EXPECTED RESULT
--   Zero rows. Every row is a violation (one row per entity, reasons
--   aggregated). First column = stable identity key
--   ('order:<uuid>' | 'quote:<uuid>' | 'customer:<uuid>').
--
-- KNOWN FALSE-POSITIVE MODES
--   * Soft-deleted orders/quotes are excluded (deleted_at IS NOT NULL) — their
--     splits no longer drive commission math. Inactive customers are INCLUDED:
--     default_commission_split is copied onto future quotes if reactivated.
--   * Percentages are parsed from JSON text; scientific notation (e.g. "1e2")
--     is numerically valid and accepted by ::numeric, so it is not flagged.
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   orders(id, order_number, customer_id, commission_split jsonb, deleted_at)
--   quotes(id, quote_number, customer_id, commission_split jsonb, deleted_at)
--   customers(id, farm_name, default_commission_split jsonb, is_active)
--   Live sample shape: {"splits":[{"recipient":"Mason Wells","percentage":100}]}
--   Validator: public.validate_commission_split_json (tolerance 0.01, recipient
--   required, dup check on lower(btrim(recipient)), pct in (0,100]).
-- =============================================================================
WITH targets AS (
  SELECT 'order:' || o.id::text AS identity_key, 'order'::text AS entity_type,
         o.id AS entity_id, o.customer_id, o.order_number AS entity_ref,
         o.commission_split AS cs
  FROM orders o
  WHERE o.commission_split IS NOT NULL
    AND o.commission_split <> 'null'::jsonb
    AND o.deleted_at IS NULL

  UNION ALL

  SELECT 'quote:' || q.id::text, 'quote', q.id, q.customer_id, q.quote_number,
         q.commission_split
  FROM quotes q
  WHERE q.commission_split IS NOT NULL
    AND q.commission_split <> 'null'::jsonb
    AND q.deleted_at IS NULL

  UNION ALL

  SELECT 'customer:' || c.id::text, 'customer', c.id, c.id, c.farm_name,
         c.default_commission_split
  FROM customers c
  WHERE c.default_commission_split IS NOT NULL
    AND c.default_commission_split <> 'null'::jsonb
),
shaped AS (
  SELECT t.*,
         (jsonb_typeof(t.cs) = 'object'
          AND t.cs ? 'splits'
          AND jsonb_typeof(t.cs -> 'splits') = 'array') AS well_formed
  FROM targets t
),
elems AS (
  SELECT s.identity_key,
         btrim(COALESCE(e.value ->> 'recipient', ''))                          AS recipient,
         e.value ->> 'percentage'                                              AS pct_text,
         CASE WHEN (e.value ->> 'percentage') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
              THEN (e.value ->> 'percentage')::numeric
              ELSE NULL END                                                    AS pct
  FROM shaped s
  CROSS JOIN LATERAL jsonb_array_elements(s.cs -> 'splits') e
  WHERE s.well_formed
    AND jsonb_array_length(s.cs -> 'splits') > 0
),
elem_rollup AS (
  SELECT
    identity_key,
    COUNT(*)                                                                   AS n_splits,
    SUM(pct)                                                                   AS sum_pct,
    COUNT(*) FILTER (WHERE recipient = '')                                     AS n_empty_recipient,
    COUNT(*) FILTER (WHERE pct IS NULL)                                        AS n_non_numeric_pct,
    COUNT(*) FILTER (WHERE pct IS NOT NULL AND (pct <= 0 OR pct > 100))        AS n_pct_out_of_range,
    (COUNT(*) - COUNT(DISTINCT lower(recipient)))                              AS n_duplicate_recipients
  FROM elems
  GROUP BY identity_key
)
SELECT
  s.identity_key,
  'commission_split_invalid'::text                                             AS violation_type,
  s.customer_id,
  100.00::numeric                                                              AS expected_pct,
  r.sum_pct                                                                    AS actual_pct,
  s.entity_type || ' ' || COALESCE(s.entity_ref, s.entity_id::text) || ': '
    || CASE WHEN NOT s.well_formed THEN 'malformed shape (expected object with splits array); '
            ELSE '' END
    || CASE WHEN r.sum_pct IS NOT NULL AND ABS(r.sum_pct - 100) > 0.01
            THEN 'percentages sum to ' || r.sum_pct::text || '; ' ELSE '' END
    || CASE WHEN COALESCE(r.n_empty_recipient, 0) > 0
            THEN r.n_empty_recipient::text || ' empty recipient(s); ' ELSE '' END
    || CASE WHEN COALESCE(r.n_non_numeric_pct, 0) > 0
            THEN r.n_non_numeric_pct::text || ' non-numeric percentage(s); ' ELSE '' END
    || CASE WHEN COALESCE(r.n_pct_out_of_range, 0) > 0
            THEN r.n_pct_out_of_range::text || ' percentage(s) outside (0,100]; ' ELSE '' END
    || CASE WHEN COALESCE(r.n_duplicate_recipients, 0) > 0
            THEN r.n_duplicate_recipients::text || ' duplicate recipient(s); ' ELSE '' END
    || 'raw=' || s.cs::text                                                    AS detail
FROM shaped s
LEFT JOIN elem_rollup r ON r.identity_key = s.identity_key
WHERE
  NOT s.well_formed
  OR (
    r.identity_key IS NOT NULL  -- non-empty splits array
    AND (
      r.sum_pct IS NULL                       -- some percentage unparsable
      OR ABS(r.sum_pct - 100) > 0.01
      OR r.n_empty_recipient > 0
      OR r.n_non_numeric_pct > 0
      OR r.n_pct_out_of_range > 0
      OR r.n_duplicate_recipients > 0
    )
  )
ORDER BY identity_key;

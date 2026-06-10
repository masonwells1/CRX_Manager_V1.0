-- =============================================================================
-- fin-quote-override-survival.sql — price overrides must survive save_quote
-- C9 financial identity suite (docs/audits/2026-06-10-error-prevention-review.md §4)
--
-- IDENTITY
--   save_quote's server-authoritative recalc (live body, 2026-06-10) sets
--     price_per_unit = COALESCE(price_override, <tier price>)
--   where <tier price> for the quote's tier is (transcribed exactly):
--     tier 1 -> COALESCE(products.tier1_price, 0)
--     tier 2 -> COALESCE(products.tier2_price, products.tier1_price, 0)
--     else   -> COALESCE(products.tier3_price, products.tier1_price, 0)
--   Therefore for every persisted quote_items row with price_override IS NOT
--   NULL, price_per_unit MUST equal price_override. A row where price_per_unit
--   instead equals the computed tier price (and differs from the override) is
--   the exact P1A shape: the user's override was silently rewritten back to
--   tier pricing somewhere between UI and persistence.
--
-- WOULD HAVE CAUGHT
--   P1A — save_quote silently discarding price overrides. This predicate is
--   the standing detector for the rewrite-after-persist variant. NOTE its
--   structural blind spot: if a regression DROPS price_override before insert
--   (the original P1A failure — override never lands in the DB at all), the
--   column is NULL and no data predicate can see it; that variant is owned by
--   the C9 seeded round-trip fixture (save -> reload -> compare), not by this
--   sweep.
--
-- EXPECTED RESULT
--   Zero rows. Per the C9 spec this file emits ONLY AGGREGATES PER QUOTE
--   (no per-line rows): one violation row per quote that has at least one
--   override-bearing item whose price_per_unit no longer equals its
--   price_override. First column = stable identity key 'quote:<uuid>'.
--
-- KNOWN FALSE-POSITIVE MODES
--   * Override coincidentally equal to the tier price: indistinguishable from
--     a rewrite by value comparison. Such items are counted in
--     n_ambiguous_override_equals_tier (context column) and NEVER flag a quote
--     on their own — when override == tier == price_per_unit the identity
--     holds either way, so no violation is emitted. Documented, by design.
--   * Products repriced AFTER the quote was last saved can make
--     n_rewritten_to_tier undercount (price_per_unit matches the OLD tier
--     price, not the current one) — the row still flags via the primary
--     price_per_unit <> price_override test, so no violations are lost; only
--     the tier-match attribution column can be stale.
--   * Soft-deleted quotes are excluded (deleted_at IS NOT NULL).
--
-- SCHEMA FACTS (verified live 2026-06-10 against rhyzpcqhnizqbxphqdkr pg_catalog)
--   quotes(id, quote_number, customer_id, tier integer, deleted_at)
--   quote_items(id, quote_id, product_id, price_per_unit numeric,
--     price_override numeric NULLable, calc_mode, total_price)
--   products(id, product_name, tier1_price, tier2_price, tier3_price numeric)
--   save_quote recalc keys off quotes.tier (NOT customers.assigned_tier).
-- =============================================================================
WITH override_items AS (
  SELECT
    q.id                                            AS quote_id,
    q.quote_number,
    q.customer_id,
    q.tier,
    qi.id                                           AS quote_item_id,
    qi.price_per_unit,
    qi.price_override,
    CASE q.tier
      WHEN 1 THEN COALESCE(p.tier1_price, 0)
      WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
      ELSE        COALESCE(p.tier3_price, p.tier1_price, 0)
    END                                             AS computed_tier_price
  FROM quotes q
  JOIN quote_items qi ON qi.quote_id = q.id
  JOIN products p     ON p.id = qi.product_id
  WHERE q.deleted_at IS NULL
    AND qi.price_override IS NOT NULL
),
per_quote AS (
  SELECT
    quote_id,
    MIN(quote_number)                                                          AS quote_number,
    MIN(customer_id::text)::uuid                                               AS customer_id,
    COUNT(*)                                                                   AS n_override_items,
    COUNT(*) FILTER (
      WHERE price_per_unit IS DISTINCT FROM price_override
    )                                                                          AS n_override_lost,
    COUNT(*) FILTER (
      WHERE price_per_unit IS DISTINCT FROM price_override
        AND price_per_unit = computed_tier_price
        AND price_override <> computed_tier_price
    )                                                                          AS n_rewritten_to_tier,
    COUNT(*) FILTER (
      WHERE price_override = computed_tier_price
    )                                                                          AS n_ambiguous_override_equals_tier
  FROM override_items
  GROUP BY quote_id
)
SELECT
  'quote:' || pq.quote_id::text                     AS identity_key,
  'price_override_not_survived'::text               AS violation_type,
  pq.customer_id,
  pq.n_override_items                               AS n_override_items,
  pq.n_override_lost                                AS n_override_lost,
  pq.n_rewritten_to_tier                            AS n_rewritten_to_tier,
  pq.n_ambiguous_override_equals_tier               AS n_ambiguous_override_equals_tier,
  'quote ' || COALESCE(pq.quote_number, pq.quote_id::text)
    || ': ' || pq.n_override_lost::text || ' of ' || pq.n_override_items::text
    || ' overridden item(s) persisted with price_per_unit <> price_override ('
    || pq.n_rewritten_to_tier::text || ' exactly back at tier price — the P1A shape)' AS detail
FROM per_quote pq
WHERE pq.n_override_lost > 0
ORDER BY identity_key;

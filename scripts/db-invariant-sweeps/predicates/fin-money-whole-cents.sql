-- =============================================================================
-- fin-money-whole-cents.sql — numeric-dollar money columns must hold whole cents
-- Owner decision: Mason, 2026-08-08 (docs/manual/DECISION_LOG.md)
-- Source finding: docs/audits/2026-08-08-foundation-ultra-review.md §3 M3
--
-- IDENTITY
--   order_items.total_price and commissions.commission_amount are `numeric`
--   dollars — the documented historical exception to the money-is-bigint-cents
--   rule. Their VALUES must still be exact whole cents:
--     value = ROUND(value, 2)
--   Mason settled the canonical rounding as two decimal places, half-up
--   ($5,245.195 -> $5,245.20). PostgreSQL ROUND(numeric, 2) is half-up away
--   from zero, so ROUND is the decision, not an approximation of it.
--
-- WOULD HAVE CAUGHT
--   The 2026-08-08 audit found 46 order_items.total_price rows and 3
--   commissions.commission_amount rows carrying fractional cents, including a
--   $5,245.195 commission that was PENDING PAYOUT. Whoever pays a sub-cent
--   liability rounds at an unspecified moment, so the amount paid and the
--   amount recorded can disagree by a cent per row. These columns are products
--   of price x fractional units, so the drift is generated silently by ordinary
--   business math rather than by a bug in one writer.
--
--   Migration 20260809170800 installs BEFORE-write triggers that round every
--   new write, so this predicate is the standing-data half of the same rule:
--   the trigger fixes the future, this sweep proves the past was repaired.
--   (That migration was re-issued from 20260808150400 on 2026-08-09 to clear the
--   applied-migration high-water mark; the SQL is unchanged.)
--
-- NOT COVERED YET — order_items.profit
--   20260809170900 extends the same trigger to round order_items.profit, but
--   this predicate deliberately still checks total_price only. Adding profit
--   here would report a second, larger set of historical rows before the repair
--   of the first set has been authorised. Extend it in the same change that
--   authorises the repair, not before.
--
-- EXPECTED RESULT
--   Zero rows ONCE the 49 historical rows have been repaired. Until that
--   repair is approved and run, this predicate is EXPECTED TO REPORT THEM —
--   that is the point. Do NOT allowlist them to silence the sweep; repairing
--   live money is a separate approval, and the commented-out repair statements
--   are recorded at the bottom of migration 20260809170800.
--
--   First column = stable identity key ('order_item:<uuid>' |
--   'commission:<uuid>').
--
-- KNOWN FALSE-POSITIVE MODES
--   * NULL values are not violations and are excluded — a missing amount is a
--     different problem from a mis-rounded one.
--   * Soft-deleted commissions are excluded (deleted_at IS NOT NULL): they no
--     longer drive a payout. order_items has no deleted_at column, so every
--     row is checked; a line on a cancelled order is still reported, which is
--     deliberate — cancelled orders still carry historical money used by
--     reporting.
--   * This checks the SCALE of the stored value, not whether the value is
--     arithmetically correct. A cleanly-rounded but wrong total passes here and
--     is the job of the margin/AR predicates.
--
-- SCHEMA FACTS (re-verified live 2026-08-09 against rhyzpcqhnizqbxphqdkr via
-- information_schema.columns)
--   order_items
--     id                 uuid    NOT NULL DEFAULT gen_random_uuid()
--     order_id           uuid    NOT NULL
--     product_id         uuid    NOT NULL
--     total_price        numeric NOT NULL DEFAULT 0   <- checked by this predicate
--     profit             numeric NOT NULL DEFAULT 0   <- money, NOT checked yet (see above)
--     net_margin         numeric NOT NULL DEFAULT 0   <- a PERCENTAGE, never checked here
--     quantity_remaining numeric NOT NULL DEFAULT 0
--   commissions
--     id                uuid    NOT NULL DEFAULT gen_random_uuid()
--     order_id          uuid    NULL
--     commission_amount numeric NOT NULL DEFAULT 0    <- checked by this predicate
--     status            text    NOT NULL DEFAULT 'pending'
--     deleted_at        timestamptz NULL
--   is_generated = NEVER on every column listed above, so all of them are plain
--   writable columns and the BEFORE-write triggers can assign to them.
--   purchase_orders.total_cost_cents is GENERATED ... round(total_cost * 100),
--   so the AP side already rounds at this same precision.
-- =============================================================================
SELECT
  'order_item:' || oi.id::text                                                 AS violation_key,
  'money_not_whole_cents'::text                                                AS violation_type,
  o.customer_id,
  ROUND(oi.total_price, 2)                                                     AS expected_value,
  oi.total_price                                                               AS actual_value,
  'order_items.total_price on order ' || COALESCE(o.order_number, o.id::text)
    || ' holds ' || oi.total_price::text || ' (sub-cent); canonical value is '
    || ROUND(oi.total_price, 2)::text                                          AS detail
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.total_price IS NOT NULL
  AND oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2)

UNION ALL

SELECT
  'commission:' || c.id::text,
  'money_not_whole_cents',
  o.customer_id,
  ROUND(c.commission_amount, 2),
  c.commission_amount,
  'commissions.commission_amount (status=' || COALESCE(c.status, 'null')
    || ') on order ' || COALESCE(o.order_number, c.order_id::text)
    || ' holds ' || c.commission_amount::text || ' (sub-cent); canonical value is '
    || ROUND(c.commission_amount, 2)::text
FROM commissions c
LEFT JOIN orders o ON o.id = c.order_id
WHERE c.commission_amount IS NOT NULL
  AND c.deleted_at IS NULL
  AND c.commission_amount IS DISTINCT FROM ROUND(c.commission_amount, 2)

ORDER BY violation_key;

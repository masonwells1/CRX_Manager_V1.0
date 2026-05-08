# Holds Historical Inflation Cleanup — Design Notes

**Created:** 2026-05-07 (logged from final-wave-review F7)
**Status:** TODO — design pass required before any cleanup migration is written
**Severity:** HIGH (production data integrity)
**Companion code fix:** [supabase/migrations/20260507210000_fix_holds_no_phantom_restoration.sql](../../supabase/migrations/20260507210000_fix_holds_no_phantom_restoration.sql) (already stops the bleeding; this doc covers draining the wound)

---

## What this is

Three SQL functions added an unaccounted-for `quantity_available + v_hold.quantity` UPDATE to the `inventory` table whenever a planned-quote hold was deactivated (declined/expired/cancelled-order):

1. `release_holds_on_quote_status_change` — defined in `20260316100001`, live since 2026-03-16
2. `auto_expire_quotes` — same migration, same date
3. `cancel_order` — defined in `20260316100001`, latest definition `20260332000000`

The corresponding hold-creation paths (`create_planned_holds` and the new `create_inventory_hold`) do NOT decrement `quantity_available`. The accepted-quote branch of the trigger correctly skips restoration; the declined/expired/cancelled paths do not. Net effect since 2026-03-16: every declined or expired planned quote has inflated `inventory.quantity_available` by the hold's quantity.

The companion code-fix migration (`20260507210000_fix_holds_no_phantom_restoration.sql`) removes the restoration UPDATE from all three functions. **It does not undo the existing inflation.** That's what this doc is for.

---

## What's hard about cleanup

There is no `inventory_transactions` audit trail for the bogus increments. The trigger / RPCs UPDATE `inventory` directly without writing a transaction row. Reconstructing the per-product inflation from `inventory_transactions` is therefore **not possible** — the audit trail is silent on these increments by design.

The only durable evidence is the `inventory_holds` table itself. Every hold that fired one of the three buggy paths now has `is_active = false` AND was originally linked to a quote that ended up declined/expired (or to an order that got cancelled).

## Diagnostic queries (read-only)

Run these against production BEFORE writing any cleanup migration. Sanity-check the numbers against current `quantity_available` and physical stock counts.

### Q1 — Per-product inflation estimate (declined / expired path)

```sql
-- Sums hold quantities for every PLANNED hold (source_id = quote_id)
-- whose source quote ended up declined or expired. Each such hold ran
-- the trigger's restoration UPDATE once.
WITH inflated AS (
  SELECT ih.product_id, SUM(ih.quantity) AS bogus_increment
  FROM inventory_holds ih
  JOIN quotes q ON q.id = ih.source_id
  WHERE ih.is_active = false
    AND ih.created_at >= '2026-03-16'
    AND q.status IN ('declined', 'expired')
  GROUP BY ih.product_id
)
SELECT i.id, i.product_id, p.product_name,
       i.quantity_available AS current_available,
       inf.bogus_increment,
       i.quantity_available - inf.bogus_increment AS proposed_corrected_available
FROM inflated inf
JOIN inventory i ON i.product_id = inf.product_id AND i.location = 'Main Warehouse'
JOIN products p ON p.id = inf.product_id
ORDER BY inf.bogus_increment DESC;
```

### Q2 — Per-product inflation estimate (cancelled-order path)

```sql
-- Sums hold quantities where the originating quote's order was later cancelled.
-- These holds fired the cancel_order restoration UPDATE.
WITH inflated AS (
  SELECT ih.product_id, SUM(ih.quantity) AS bogus_increment
  FROM inventory_holds ih
  JOIN quotes q ON q.id = ih.source_id
  JOIN orders o ON o.quote_id = q.id
  WHERE ih.is_active = false
    AND ih.created_at >= '2026-03-16'
    AND o.status = 'cancelled'
  GROUP BY ih.product_id
)
SELECT i.id, i.product_id, p.product_name,
       i.quantity_available AS current_available,
       inf.bogus_increment,
       i.quantity_available - inf.bogus_increment AS proposed_corrected_available
FROM inflated inf
JOIN inventory i ON i.product_id = inf.product_id AND i.location = 'Main Warehouse'
JOIN products p ON p.id = inf.product_id
ORDER BY inf.bogus_increment DESC;
```

### Q3 — Combined (Q1 + Q2 — but watch for double-counting)

If a quote was BOTH `declined`-or-`expired` AND had an order that was cancelled (very unusual but not impossible — a quote could be accepted, an order created, then the order cancelled, then via some weird flow the quote re-flagged), the same hold could be counted in both Q1 and Q2. Verify with:

```sql
-- Holds that match BOTH paths (should be 0 or near-0 in practice)
SELECT ih.id, ih.product_id, ih.quantity, q.status AS quote_status, o.status AS order_status
FROM inventory_holds ih
JOIN quotes q ON q.id = ih.source_id
JOIN orders o ON o.quote_id = q.id
WHERE ih.is_active = false
  AND ih.created_at >= '2026-03-16'
  AND q.status IN ('declined', 'expired')
  AND o.status = 'cancelled';
```

### Q4 — Physical-stock spot check

For the top 10 products by `bogus_increment`, eyeball the count against physical:

```sql
-- Top 10 most-inflated products with current available + recent activity
SELECT i.id, p.product_name,
       i.quantity_available, i.quantity_prebooked,
       i.updated_at AS inventory_last_updated,
       (SELECT MAX(created_at) FROM inventory_transactions
        WHERE product_id = i.product_id) AS last_real_transaction
FROM inventory i
JOIN products p ON p.id = i.product_id
WHERE i.location = 'Main Warehouse'
  AND i.product_id IN (
    -- product_ids from Q1 + Q2 results, top 10 by bogus_increment
    /* paste UUIDs here */
  );
```

Mason should physically count or check warehouse against these before the cleanup migration runs. If physical stock is HIGHER than `quantity_available - bogus_increment`, there's another untracked inflation source we haven't identified and the cleanup should pause.

---

## Decision points (BEFORE writing the cleanup migration)

1. **Apply per-product or as one big batch?** Per-product (one UPDATE per row) is auditable in `financial_audit_log` but slow. Batch UPDATE with a CTE is fast but harder to verify. Lean per-product with explicit logging.

2. **Reverse the inflation or just zero out and reseed from physical counts?** The diagnostic queries give a *computed* corrected value. If physical counts disagree, reseed-from-physical is safer but requires Mason to actually go count. Default plan: use the computed value, ask Mason to spot-check the top 10 products, abort if any of those 10 disagree with physical by more than 5%.

3. **Inventory_transactions row?** Yes — write one `transaction_type = 'adjusted'` row per affected product with a notes string like "Backout of phantom holds-restoration (2026-03-16 → 2026-05-07). Adjustment = -X units." This gives the audit trail the original bug never had.

4. **Run during a quiet window?** YES. Do it during a closed accounting period or on a weekend. The inventory rows take a brief lock; concurrent quote / delivery / receive operations would block.

5. **Rollback plan?** Snapshot `inventory` to `inventory_holds_cleanup_backup_20260508` before the UPDATE. If anything looks wrong post-apply, restore from the backup table.

---

## Proposed cleanup migration shape (DRAFT — needs Mason's review)

```sql
-- 20260508100000_drain_phantom_holds_inflation.sql

-- 1. Snapshot
CREATE TABLE inventory_holds_cleanup_backup_20260508 AS
SELECT id, product_id, location, quantity_available, quantity_prebooked,
       quantity_on_order, updated_at, NOW() AS snapshot_taken_at
FROM inventory;

-- 2. Compute deltas (one row per affected product)
WITH bogus AS (
  SELECT ih.product_id, SUM(ih.quantity) AS total_bogus
  FROM inventory_holds ih
  LEFT JOIN quotes q ON q.id = ih.source_id
  LEFT JOIN orders o ON o.quote_id = q.id
  WHERE ih.is_active = false
    AND ih.created_at >= '2026-03-16'
    AND (q.status IN ('declined', 'expired') OR o.status = 'cancelled')
  GROUP BY ih.product_id
)
-- 3. Apply per-product (with audit row)
-- 4. Verify post-apply: each row's quantity_available should match
--    its corrected value (current - total_bogus) within rounding.
-- 5. Insert one inventory_transactions row per product with
--    transaction_type = 'adjusted' and a descriptive notes string.
```

The full migration is NOT written yet — see decision points above. Mason needs to approve the approach before this gets coded.

---

## Mason's go-no-go checklist

- [ ] Run Q1 + Q2 + Q3 against production read replica. Capture results to a `.sql` file or screenshot for the migration's commit message.
- [ ] Pick the top 10 products by `bogus_increment` from Q4 and physically count them. If any are off by more than 5%, this design is wrong and we need a reseed-from-physical approach.
- [ ] Confirm there's no other code path (some old migration, a one-off script, a manual UPDATE) that ALSO inflates `quantity_available` — otherwise the cleanup will under- or over-correct.
- [ ] Pick a quiet window to apply (after-hours or a Sunday).
- [ ] Approve the migration shape above OR revise.

Once these are green, a follow-up Claude Code session can write `20260508100000_drain_phantom_holds_inflation.sql` and apply it under supervision.

---

## References

- Trigger function: `release_holds_on_quote_status_change` defined in `supabase/migrations/20260316100001_inventory_hold_restoration.sql` (now fixed in `20260507210000_fix_holds_no_phantom_restoration.sql`).
- E2E test that catches this bug: `tests/e2e/holds-cleanup-paths.spec.ts` Path B asserts `endQty === startQty`. Will fail until cleanup is applied (the code fix alone doesn't unwind existing inflation).
- Final-wave-review finding F7 in [docs/audits/2026-05-07-final-wave-review-prompt.md](../audits/2026-05-07-final-wave-review-prompt.md).
- Wave 3 anomaly that first surfaced this: `SESSION_FINAL_WAVE_3.md` § Anomalies.

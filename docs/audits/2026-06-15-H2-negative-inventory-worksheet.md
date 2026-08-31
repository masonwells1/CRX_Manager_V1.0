# H2 — Negative Inventory Worksheet & Gated Repair Template (2026-06-15)

**Status: NEEDS MASON — physical counts required before any repair. Nothing has been applied.**

Foundation Ultra Review H2: 17 `inventory` rows have negative `quantity_available`. No inventory
transactions exist after 2026-06-10 for these products, so this is **historical data cleanup**
(most likely from early-season bulk-import seeding where deliveries/applications drew down stock
that was never received into inventory) — **not an active writer bug**. The fix is a one-time
**re-base to physical counts**, per the audit's recommended route (physical count + admin re-base).

## How to use this

1. **Walk the warehouse** and write the real on-hand quantity for each product in the
   **"Physical Count"** column below (in the listed unit).
2. Send the filled counts back. I will drop them into the template at the bottom, run it through
   the `/ship` review gate (rls + drift reviewers) + a rolled-back smoke test, then apply it live
   **only with your explicit go** (same gate as the other live changes this session).
3. The repair sets `quantity_available` to your counted value and records an `adjusted`
   inventory-ledger transaction for the difference (so the ledger stays continuous and auditable).
   `quantity_prebooked` is left untouched.

> If a product is genuinely **0 on hand**, write `0` (not blank). **Blank = "I didn't count it yet"**
> and that row is skipped by the template.

## The 17 rows (all at `Main Warehouse`)

| # | Product | Unit | Current qty_available | Prebooked | Last txn | inventory_id | **Physical Count** |
|---|---------|------|----------------------:|----------:|----------|--------------|:------------------:|
| 1 | Water W/ D-Chlorinator | — | **-2345.00** | 0 | 2026-03-25 | `bc717981-6d7e-4001-9326-6f29898c6cce` | ____ |
| 2 | HumiK Bio WSP - 55LB | Lb | **-1870** | 0 | 2026-04-30 | `64e74de4-b5c2-4b37-9c90-dbfdf8122763` | ____ |
| 3 | Black Strap Molasses Sugar - Bulk | Gal | **-1325** | 0 | 2026-03-21 | `b21be5d0-3cd4-4ca9-b47d-7b5668d2a777` | ____ |
| 4 | Gen Liberty: Higher Quality (Interline, Inflame) - Bulk | Gal | **-530** | 0 | 2026-04-30 | `cd2cdede-c832-49ff-8cc5-d3fd5de02c4a` | ____ |
| 5 | PeKacid 0-60-20 | Lb | **-275** | 0 | 2026-03-27 | `b93edc48-d08a-48bb-b1d2-455069cee1ad` | ____ |
| 6 | COC XL - Bulk | Gal | **-265** | 0 | 2026-03-24 | `62f4c4a7-f676-4fbf-945a-26bbc3936ab1` | ____ |
| 7 | Gen Dual S Moc: (Visor S Moc II, Medal II, …) | Gal | **-265.00** | 235 | 2026-03-24 | `7065aaa8-b776-4a71-9fd9-19d406aba6df` | ____ |
| 8 | Ultramate LQ - Tote | Gal | **-202.5** | 260 | 2026-04-03 | `3ec5ff62-40fa-4c62-acf8-0658620f458f` | ____ |
| 9 | Pinzola EC | — | **-175** | 0 | 2026-03-23 | `2259502e-b7ee-439b-999c-6ef2dc8247c0` | ____ |
| 10 | Boron 10% - Tote | Gal | **-150** | 87.5 | 2026-03-27 | `1fc5454f-f6eb-4a46-acfb-ed2ccb07c74e` | ____ |
| 11 | Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal | Gal | **-100** | 0 | 2026-03-25 | `df28e1a4-887f-4e8e-a257-32c29dea059c` | ____ |
| 12 | Warrant - Bulk | Gal | **-57** | 0 | 2026-04-30 | `733a9db6-21af-43c8-893a-ac70328208ba` | ____ |
| 13 | MagnifySi - 2.5 Gal | Gal | **-32.5** | 85 | 2026-04-30 | `759b1572-093f-4121-afa2-27639ecdc1b6` | ____ |
| 14 | Copper 7.5% - 2.5G | Gal | **-22.96** | 31.90 | 2026-04-03 | `f5cb97a2-54ba-4e71-8da0-62798300828c` | ____ |
| 15 | Gen Sencor: (Metriclude DF, Metribuzin, …) - 5 | Lb | **-15** | 0 | 2026-03-21 | `7dd9c9c9-ccc4-4e03-afd1-c8db537b3f50` | ____ |
| 16 | Gen Callisto: High Quality (Explorer, Incinerate) - 1 Gal | Gal | **-15** | 133.5 | 2026-04-30 | `115334cc-7d08-411e-8034-90bd106ae943` | ____ |
| 17 | MSO 84 - Bulk | Gal | **-11** | 0 | 2026-03-21 | `bceabe38-b218-4142-be5d-6dac6ff16f4d` | ____ |

## Gated repair template (DRAFT — DO NOT APPLY until counts are filled + reviewed)

Replace each `NULL` with the physical count. Rows left `NULL` are skipped. `p_actor` should be an
active admin profile id (e.g. Mason Wells `22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f`). This will be
moved into `supabase/migrations/` and run through the `/ship` gate + rolled-back smoke test before
any live apply.

```sql
-- H2 negative-inventory re-base to physical counts (Foundation Ultra Review).
-- Re-bases each listed inventory row to the counted on-hand value and records an
-- 'adjusted' ledger transaction for the delta. quantity_prebooked is untouched.
DO $$
DECLARE
  v_actor uuid := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';  -- TODO confirm admin actor
  r record;
  v_delta numeric;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('bc717981-6d7e-4001-9326-6f29898c6cce'::uuid, NULL::numeric),  -- 1  Water W/ D-Chlorinator (cur -2345.00)
      ('64e74de4-b5c2-4b37-9c90-dbfdf8122763'::uuid, NULL::numeric),  -- 2  HumiK Bio WSP - 55LB (cur -1870)
      ('b21be5d0-3cd4-4ca9-b47d-7b5668d2a777'::uuid, NULL::numeric),  -- 3  Black Strap Molasses Sugar - Bulk (cur -1325)
      ('cd2cdede-c832-49ff-8cc5-d3fd5de02c4a'::uuid, NULL::numeric),  -- 4  Gen Liberty - Bulk (cur -530)
      ('b93edc48-d08a-48bb-b1d2-455069cee1ad'::uuid, NULL::numeric),  -- 5  PeKacid 0-60-20 (cur -275)
      ('62f4c4a7-f676-4fbf-945a-26bbc3936ab1'::uuid, NULL::numeric),  -- 6  COC XL - Bulk (cur -265)
      ('7065aaa8-b776-4a71-9fd9-19d406aba6df'::uuid, NULL::numeric),  -- 7  Gen Dual S Moc (cur -265.00)
      ('3ec5ff62-40fa-4c62-acf8-0658620f458f'::uuid, NULL::numeric),  -- 8  Ultramate LQ - Tote (cur -202.5)
      ('2259502e-b7ee-439b-999c-6ef2dc8247c0'::uuid, NULL::numeric),  -- 9  Pinzola EC (cur -175)
      ('1fc5454f-f6eb-4a46-acfb-ed2ccb07c74e'::uuid, NULL::numeric),  -- 10 Boron 10% - Tote (cur -150)
      ('df28e1a4-887f-4e8e-a257-32c29dea059c'::uuid, NULL::numeric),  -- 11 Gen Capture LFR - 2.5 Gal (cur -100)
      ('733a9db6-21af-43c8-893a-ac70328208ba'::uuid, NULL::numeric),  -- 12 Warrant - Bulk (cur -57)
      ('759b1572-093f-4121-afa2-27639ecdc1b6'::uuid, NULL::numeric),  -- 13 MagnifySi - 2.5 Gal (cur -32.5)
      ('f5cb97a2-54ba-4e71-8da0-62798300828c'::uuid, NULL::numeric),  -- 14 Copper 7.5% - 2.5G (cur -22.96)
      ('7dd9c9c9-ccc4-4e03-afd1-c8db537b3f50'::uuid, NULL::numeric),  -- 15 Gen Sencor - 5 (cur -15)
      ('115334cc-7d08-411e-8034-90bd106ae943'::uuid, NULL::numeric),  -- 16 Gen Callisto - 1 Gal (cur -15)
      ('bceabe38-b218-4142-be5d-6dac6ff16f4d'::uuid, NULL::numeric)   -- 17 MSO 84 - Bulk (cur -11)
    ) AS t(inventory_id, physical_count)
  LOOP
    IF r.physical_count IS NULL THEN CONTINUE; END IF;  -- not counted yet → skip
    SELECT (r.physical_count - i.quantity_available) INTO v_delta
      FROM inventory i WHERE i.id = r.inventory_id;
    IF v_delta IS NULL OR v_delta = 0 THEN CONTINUE; END IF;
    UPDATE inventory
       SET quantity_available = r.physical_count, updated_at = now()
     WHERE id = r.inventory_id;
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, performed_by, notes)
    SELECT i.product_id, 'adjusted', v_delta, i.location, v_actor,
           'H2 physical-count re-base (Foundation Ultra Review 2026-06-15)'
      FROM inventory i WHERE i.id = r.inventory_id;
  END LOOP;
END $$;
```

**Notes for the apply session:** confirm `inventory` has an `updated_at` column (it does); confirm
`'adjusted'` is in the `inventory_transactions.transaction_type` CHECK (it is); the smoke test should
verify zero rows remain with `quantity_available < 0` among the counted set and that one `adjusted`
ledger row was written per re-based product.

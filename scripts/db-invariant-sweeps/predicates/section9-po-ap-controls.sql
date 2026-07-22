-- predicate: section9-po-ap-controls
-- Section 9 HIGH controls: PO on-order cache equals authoritative open
-- remainder at Main Warehouse; browser roles cannot mutate vendors; active
-- bills cannot reference draft/cancelled POs; and the three remediated AP RPCs
-- retain their fail-closed body controls.
-- Historical catch: 2026-07-22 Live Foundation Gauntlet Section 9.
-- Contract: EXPECT ZERO rows.

WITH expected_on_order AS (
  SELECT
    poi.product_id,
    SUM(GREATEST(
      poi.quantity_ordered - COALESCE(poi.quantity_received, 0),
      0
    )) AS expected
  FROM public.purchase_order_items poi
  JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
  WHERE po.status IN ('submitted', 'partially_received')
  GROUP BY poi.product_id
),
ap_functions AS (
  SELECT p.proname, p.prosrc
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN (
      'create_vendor_bill',
      'get_ap_aging',
      'update_vendor_bill'
    )
)
SELECT
  'inventory:on-order:' || COALESCE(i.product_id, e.product_id)::text
    AS violation_key,
  'Main Warehouse quantity_on_order differs from open PO remainder' AS reason
FROM expected_on_order e
FULL JOIN public.inventory i
  ON i.product_id = e.product_id
 AND i.location = 'Main Warehouse'
WHERE COALESCE(i.quantity_on_order, 0)
      IS DISTINCT FROM COALESCE(e.expected, 0)

UNION ALL

SELECT
  'vendors:browser-mutation-privilege' AS violation_key,
  'anon/authenticated retains direct vendor mutation privilege' AS reason
WHERE has_table_privilege('authenticated', 'public.vendors', 'INSERT')
   OR has_table_privilege('authenticated', 'public.vendors', 'UPDATE')
   OR has_table_privilege('authenticated', 'public.vendors', 'DELETE')
   OR has_table_privilege('authenticated', 'public.vendors', 'TRUNCATE')
   OR has_table_privilege('anon', 'public.vendors', 'INSERT')
   OR has_table_privilege('anon', 'public.vendors', 'UPDATE')
   OR has_table_privilege('anon', 'public.vendors', 'DELETE')
   OR has_table_privilege('anon', 'public.vendors', 'TRUNCATE')

UNION ALL

SELECT
  'vendors:browser-mutation-policy' AS violation_key,
  'vendors retains an INSERT/UPDATE/DELETE/FOR ALL browser policy' AS reason
WHERE EXISTS (
  SELECT 1
  FROM pg_policy p
  WHERE p.polrelid = 'public.vendors'::regclass
    AND p.polcmd IN ('a', 'w', 'd', '*')
)

UNION ALL

SELECT
  'vendor_bills:invalid-po:' || vb.id::text AS violation_key,
  'active vendor bill references a draft or cancelled purchase order' AS reason
FROM public.vendor_bills vb
JOIN public.purchase_orders po ON po.id = vb.purchase_order_id
WHERE vb.deleted_at IS NULL
  AND vb.status <> 'voided'
  AND po.status IN ('draft', 'cancelled')

UNION ALL

SELECT
  'create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'
    AS violation_key,
  'create_vendor_bill lacks PO lock/status serialization' AS reason
WHERE NOT EXISTS (
  SELECT 1
  FROM ap_functions
  WHERE proname = 'create_vendor_bill'
    AND prosrc LIKE '%FROM public.purchase_orders%FOR UPDATE%'
    AND prosrc LIKE '%PO_NOT_BILLABLE%'
    AND prosrc LIKE '%submitted%partially_received%fully_received%'
)

UNION ALL

SELECT
  'get_ap_aging(date)' AS violation_key,
  'get_ap_aging does not fail closed for unsupported historical dates' AS reason
WHERE NOT EXISTS (
  SELECT 1
  FROM ap_functions
  WHERE proname = 'get_ap_aging'
    AND prosrc LIKE '%p_as_of_date IS DISTINCT FROM%'
    AND prosrc LIKE '%clock_timestamp() AT TIME ZONE ''America/Chicago''%'
    AND prosrc LIKE '%HISTORICAL_AP_UNAVAILABLE%'
    AND prosrc LIKE '%vb.bill_date <= p_as_of_date%'
)

UNION ALL

SELECT
  'update_vendor_bill(uuid,bigint,bigint,date,date,text,text)'
    AS violation_key,
  'update_vendor_bill does not lock before checking old and new periods' AS reason
WHERE NOT EXISTS (
  SELECT 1
  FROM ap_functions
  WHERE proname = 'update_vendor_bill'
    AND strpos(prosrc, 'FOR UPDATE') > 0
    AND strpos(prosrc, 'check_period_open(v_bill.bill_date)')
        > strpos(prosrc, 'FOR UPDATE')
    AND strpos(prosrc, 'check_period_open(p_bill_date)')
        > strpos(prosrc, 'FOR UPDATE')
);

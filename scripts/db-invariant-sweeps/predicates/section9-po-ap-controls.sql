-- predicate: section9-po-ap-controls
-- Section 9 HIGH controls: PO on-order cache equals authoritative open
-- remainder at Main Warehouse; browser roles cannot mutate vendors; active
-- bills cannot reference deleted vendors or draft/cancelled POs; and the three
-- remediated AP RPCs retain their fail-closed body controls.
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
  SELECT p.oid, p.proname, p.prosrc
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.oid IN (
      to_regprocedure('public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)'),
      to_regprocedure('public._section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'),
      to_regprocedure('public._section9_create_vendor_bill_intent_impl_20260826(uuid,uuid,text,date,date,text,bigint,bigint,text,text)'),
      to_regprocedure('public.get_ap_aging(date)'),
      to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)'),
      to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)'),
      to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260826(uuid,bigint,bigint,date,date,text,text)')
    )
),
ap_controls AS (
  SELECT
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)')
    ) AS create_wrapper,
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public._section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)')
    ) AS create_intent_wrapper,
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public._section9_create_vendor_bill_intent_impl_20260826(uuid,uuid,text,date,date,text,bigint,bigint,text,text)')
    ) AS create_impl,
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public.get_ap_aging(date)')
    ) AS ap_aging,
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)')
    ) AS update_wrapper,
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)')
    ) AS update_intent_wrapper,
    MAX(prosrc) FILTER (
      WHERE oid = to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260826(uuid,bigint,bigint,date,date,text,text)')
    ) AS update_impl
  FROM ap_functions
)
SELECT
  'inventory:on-order:' || COALESCE(i.product_id, e.product_id)::text
    AS violation_key,
  'Main Warehouse quantity_on_order differs from open PO remainder' AS reason
FROM expected_on_order e
FULL JOIN (
  SELECT product_id, quantity_on_order
  FROM public.inventory
  WHERE location = 'Main Warehouse'
) i ON i.product_id = e.product_id
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
  'vendor_bills:browser-mutation-privilege' AS violation_key,
  'anon/authenticated retains direct vendor-bill mutation privilege' AS reason
WHERE has_table_privilege('authenticated', 'public.vendor_bills', 'INSERT')
   OR has_table_privilege('authenticated', 'public.vendor_bills', 'UPDATE')
   OR has_table_privilege('authenticated', 'public.vendor_bills', 'DELETE')
   OR has_table_privilege('authenticated', 'public.vendor_bills', 'TRUNCATE')
   OR has_table_privilege('anon', 'public.vendor_bills', 'INSERT')
   OR has_table_privilege('anon', 'public.vendor_bills', 'UPDATE')
   OR has_table_privilege('anon', 'public.vendor_bills', 'DELETE')
   OR has_table_privilege('anon', 'public.vendor_bills', 'TRUNCATE')

UNION ALL

SELECT
  'vendor_bills:deleted-vendor:' || vb.id::text AS violation_key,
  'active vendor bill references a soft-deleted vendor' AS reason
FROM public.vendor_bills vb
JOIN public.vendors v ON v.id = vb.vendor_id
WHERE vb.deleted_at IS NULL
  AND vb.status NOT IN ('paid', 'voided')
  AND v.deleted_at IS NOT NULL

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
  'create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)'
    AS violation_key,
  'create_vendor_bill wrapper chain lacks cumulative guard, intent binding, or vendor/PO status serialization' AS reason
FROM ap_controls
WHERE create_wrapper IS NULL
   OR create_intent_wrapper IS NULL
   OR create_wrapper NOT LIKE '%_section9_create_vendor_bill_cumulative_impl%'
   OR create_wrapper !~
      'FROM public\.vendors v[[:space:]]+WHERE v\.id = p_vendor_id[[:space:]]+AND v\.deleted_at IS NULL[[:space:]]+FOR UPDATE'
   OR create_wrapper NOT LIKE '%FROM public.purchase_orders po%FOR UPDATE%'
   OR (
     create_impl IS NULL
     AND (
       create_intent_wrapper NOT LIKE '%PO_NOT_BILLABLE%'
       OR create_intent_wrapper NOT LIKE '%submitted%partially_received%fully_received%'
     )
   )
   OR (
     create_impl IS NOT NULL
     AND (
       create_intent_wrapper NOT LIKE '%_section9_create_vendor_bill_intent_impl_20260826%'
       OR create_impl NOT LIKE '%PO_NOT_BILLABLE%'
       OR create_impl NOT LIKE '%submitted%partially_received%fully_received%'
     )
   )

UNION ALL

SELECT
  'get_ap_aging(date)' AS violation_key,
  'get_ap_aging does not fail closed for unsupported historical dates' AS reason
FROM ap_controls
WHERE ap_aging IS NULL
   OR ap_aging NOT LIKE '%p_as_of_date IS DISTINCT FROM%'
   OR ap_aging NOT LIKE '%transaction_timestamp() AT TIME ZONE ''America/Chicago''%'
   OR ap_aging NOT LIKE '%HISTORICAL_AP_UNAVAILABLE%'
   OR ap_aging NOT LIKE '%vb.bill_date <= p_as_of_date%'

UNION ALL

SELECT
  'update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)'
    AS violation_key,
  'update_vendor_bill wrapper chain does not preserve intent binding and lock before checking old and new periods' AS reason
FROM ap_controls
WHERE update_wrapper IS NULL
   OR update_intent_wrapper IS NULL
   OR update_wrapper NOT LIKE '%_section9_update_vendor_bill_intent_impl_20260831%'
   OR strpos(update_wrapper, 'FOR UPDATE') = 0
   OR strpos(update_wrapper, 'check_period_open(v_bill.bill_date)')
        <= strpos(update_wrapper, 'FOR UPDATE')
   OR strpos(update_wrapper, 'check_period_open(p_bill_date)')
        <= strpos(update_wrapper, 'FOR UPDATE')
   OR (
     update_impl IS NULL
     AND (
       strpos(update_intent_wrapper, 'FOR UPDATE') = 0
       OR strpos(update_intent_wrapper, 'check_period_open(v_bill.bill_date)')
            <= strpos(update_intent_wrapper, 'FOR UPDATE')
       OR strpos(update_intent_wrapper, 'check_period_open(p_bill_date)')
            <= strpos(update_intent_wrapper, 'FOR UPDATE')
     )
   )
   OR (
     update_impl IS NOT NULL
     AND (
       update_intent_wrapper NOT LIKE '%_section9_update_vendor_bill_intent_impl_20260826%'
       OR strpos(update_impl, 'FOR UPDATE') = 0
       OR strpos(update_impl, 'check_period_open(v_bill.bill_date)')
            <= strpos(update_impl, 'FOR UPDATE')
       OR strpos(update_impl, 'check_period_open(p_bill_date)')
            <= strpos(update_impl, 'FOR UPDATE')
     )
   );

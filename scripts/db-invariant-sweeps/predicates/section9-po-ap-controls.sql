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
-- has_table_privilege() with a role NAME raises `role "<name>" does not exist`
-- when that role is absent. The error aborts the whole statement, so every other
-- arm of this UNION ALL returns nothing and the sweep reports a false CLEAN.
--
-- An `EXISTS (...) AND has_table_privilege('name', ...)` guard is NOT enough: SQL
-- does not promise left-to-right AND evaluation, so the planner may still evaluate
-- the privilege call and raise. Pass the role's OID from a scalar subquery instead.
-- has_table_privilege is strict, so an absent role yields NULL — never TRUE, never
-- an error — which is the correct outcome: a role that does not exist holds nothing.
WHERE has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendors', 'INSERT')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendors', 'UPDATE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendors', 'DELETE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendors', 'TRUNCATE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendors', 'INSERT')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendors', 'UPDATE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendors', 'DELETE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendors', 'TRUNCATE')

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
-- Same absent-role abort risk as the vendors arm above; guard identically via OID.
WHERE has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendor_bills', 'INSERT')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendor_bills', 'UPDATE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendor_bills', 'DELETE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'authenticated'), 'public.vendor_bills', 'TRUNCATE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendor_bills', 'INSERT')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendor_bills', 'UPDATE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendor_bills', 'DELETE')
   OR has_table_privilege(
         (SELECT r.oid
            FROM pg_roles r
           WHERE r.rolname = 'anon'), 'public.vendor_bills', 'TRUNCATE')

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
   -- The reason string above names a cumulative guard and intent binding, but
   -- until these arms landed the predicate asserted NEITHER — only delegation,
   -- the two FOR UPDATE locks, and the billable-status list on the delegated
   -- impl. Both financial controls live in THIS wrapper body, so either could
   -- have been deleted outright and the sweep would still have returned zero
   -- rows: a green light that proved nothing about the thing it claimed to
   -- prove. Every literal below is verified present in the applied body of
   -- 20260831161000 (ledger 20260903024550).
   --
   -- strpos(...) = 0 rather than NOT LIKE: these token names are underscore
   -- heavy and `_` is a LIKE single-character wildcard, so a LIKE pattern would
   -- match names that are not these.
   OR strpos(create_wrapper, 'check_idempotency_intent') = 0
   OR strpos(create_wrapper, 'IDEMPOTENCY_RECEIPT_MISSING') = 0
   OR strpos(create_wrapper, 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED') = 0
   OR strpos(create_wrapper, 'PO_CUMULATIVE_BILLING_REASON_REQUIRED') = 0
   -- Naming the two exception tokens alone is not enough: a body could raise
   -- them from a condition that never fires. Pin the arithmetic that decides
   -- WHEN they fire — the cumulative sum's composition, the source it is summed
   -- from, and the 105%-of-PO threshold — so widening the gate is a red row
   -- rather than a silent policy change.
   OR strpos(create_wrapper, 'COALESCE(SUM(vb.total_cents), 0)::bigint') = 0
   OR strpos(create_wrapper, 'v_cumulative_total := v_active_billed_total + v_candidate_total') = 0
   OR strpos(create_wrapper, 'v_cumulative_total * 100 > v_po_total * 105') = 0
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
   -- "preserve intent binding" was in the reason string but in none of the
   -- assertions: the arm checked delegation, the row lock and the two period
   -- checks only. check_idempotency_intent is what makes a replayed key answer
   -- only the same actor with the same payload; deleting it would downgrade the
   -- RPC to key-only replay (a different actor's edit returning someone else's
   -- receipt) with the sweep still green. Verified present in the applied body
   -- of 20260831233000. strpos(...) = 0 rather than NOT LIKE because `_` is a
   -- LIKE single-character wildcard and these names are underscore-heavy.
   OR strpos(update_wrapper, 'check_idempotency_intent') = 0
   -- The binding is only real if the receipt is actually stamped with the actor
   -- and fingerprint that a later replay is compared against, and if a missing
   -- stamp is fatal rather than ignored.
   OR strpos(update_wrapper, 'request_actor_id = v_actor') = 0
   OR strpos(update_wrapper, 'IDEMPOTENCY_RECEIPT_MISSING') = 0
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

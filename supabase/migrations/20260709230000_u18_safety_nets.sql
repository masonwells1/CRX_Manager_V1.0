-- U18-DB: safety nets for negative stock, quote expiry, morning notifications,
-- delivery action categories, and customer prepay visibility in AR.
--
-- Re-emit bases (newest prior CREATE OR REPLACE for each function):
--   get_inventory_position          20260702177000_layer2_inventory_position_job_column.sql
--   get_dashboard_action_items      20260707020000_assignment_unification.sql
--   auto_expire_quotes              20260614143649_auto_expire_quotes_skip_planned_and_schedule.sql
--   get_ar_aging                    20260702161000_a8_aging_basis_unification.sql
--   get_ar_reminder_candidates      20260702162000_ar_reminder_configurable_threshold.sql

-- ============================================================================
-- Part 1: negative on-hand is always low stock in get_inventory_position.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_inventory_position()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    v_season_start := DATE_TRUNC('year', CURRENT_DATE)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(poi.quantity_ordered - poi.quantity_received) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ),
    holds AS (
      SELECT ih.product_id,
             SUM(ih.quantity) AS qty,
             -- LAYER2<<< job-type subset broken out as its own column (§4B.2 #1)
             SUM(ih.quantity) FILTER (WHERE ih.hold_type = 'job') AS job_qty
             -- >>>LAYER2
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      -- LAYER2<<< quantity-aware dedup (§4B.2 #2): unreserved remainder per booking line.
      -- Codex A+B round-2 P2: AGGREGATE the booking per (quote, product) FIRST, THEN
      -- subtract the product-level hold/draws ONCE. Subtracting them inside a per-line
      -- SUM over-deducts when a product appears on multiple quote lines (two 50-unit
      -- lines with a 60-unit job draw and no hold would report 0 instead of 40 unreserved).
      SELECT pq.product_id, SUM(pq.remainder) AS qty
      FROM (
        SELECT b.quote_id, b.product_id,
               GREATEST(
                 b.booked
                   - COALESCE(lh.linked_hold, 0)
                   - COALESCE(od.order_drawn, 0)
                   - COALESCE(jd.job_drawn, 0),
                 0) AS remainder
        FROM (
          SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
          FROM quote_items qi
          JOIN quotes q ON q.id = qi.quote_id
          WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
          GROUP BY qi.quote_id, qi.product_id
        ) b
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ih.quantity), 0) AS linked_hold
          FROM inventory_holds ih
          WHERE ih.source_id = b.quote_id
            AND ih.product_id = b.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        ) lh ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(qpd.quantity_drawn), 0) AS order_drawn
          FROM quote_product_draws qpd
          WHERE qpd.quote_id = b.quote_id
            AND qpd.product_id = b.product_id
        ) od ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jpd.quantity_drawn), 0) AS job_drawn
          FROM job_product_draws jpd
          WHERE jpd.quote_id = b.quote_id
            AND jpd.product_id = b.product_id
        ) jd ON true
      ) pq
      GROUP BY pq.product_id
      -- >>>LAYER2
    ),
    delivered_ytd AS (
      SELECT it.product_id, SUM(it.quantity) AS qty
      FROM inventory_transactions it
      WHERE it.transaction_type = 'delivered' AND it.created_at >= v_season_start
      GROUP BY it.product_id
    ),
    base AS (
      SELECT
        p.id AS product_id, p.product_name, p.inventory_unit,
        p.container_size, p.container_type, p.vendor, p.current_cost,
        i.id AS inventory_id, i.location, i.unit_size,
        COALESCE(i.quantity_available, 0) AS quantity_available,
        COALESCE(i.quantity_prebooked, 0) AS quantity_prebooked,
        COALESCE(i.reorder_point, 0) AS reorder_point,
        COALESCE(i.min_stock_level, 0) AS min_stock_level
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.is_active = true
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.product_name), '[]'::jsonb)
    FROM (
      SELECT
        b.inventory_id, b.product_id, b.product_name, b.inventory_unit,
        b.container_size, b.container_type, b.vendor, b.current_cost,
        b.location, b.unit_size,
        b.quantity_available, b.quantity_prebooked,
        COALESCE(oo.qty, 0) AS quantity_on_order,
        COALESCE(h.qty, 0)  AS holds_qty,
        COALESCE(h.job_qty, 0) AS job_holds_qty,   -- LAYER2: new column
        COALESCE(pq.qty, 0) AS planned_qty,
        COALESCE(dy.qty, 0) AS delivered_ytd,
        (b.quantity_available - b.quantity_prebooked + COALESCE(oo.qty, 0)) AS net_position,
        b.reorder_point, b.min_stock_level,
        -- U18 #90: negative on-hand is always a stock problem, reorder_point set or not.
        ((b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) OR b.quantity_available < 0) AS is_low_stock
      FROM base b
      LEFT JOIN on_order       oo ON oo.product_id = b.product_id
      LEFT JOIN holds          h  ON h.product_id  = b.product_id
      LEFT JOIN planned_quotes pq ON pq.product_id = b.product_id
      LEFT JOIN delivered_ytd  dy ON dy.product_id = b.product_id
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_inventory_position() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_position() TO authenticated, service_role;

-- ============================================================================
-- Part 2: dashboard alignment plus due-today and unbilled-delivery categories.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_today date := current_date;
BEGIN
  -- 1. Overdue Invoices
  SELECT jsonb_agg(row_to_json(t))
  INTO v_result
  FROM (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
    ORDER BY (v_today - i.due_date) DESC
    LIMIT p_limit
  ) t;

  v_result := jsonb_build_object('overdue_invoices', COALESCE(v_result, '[]'::jsonb));

  -- 2. Cancelled Orders with Posted Invoices
  v_result := v_result || jsonb_build_object('cancelled_posted', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        o.id,
        o.order_number AS primary_text,
        c.farm_name AS secondary_text,
        i.invoice_number
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN invoices i ON i.order_id = o.id AND i.status = 'posted'
      WHERE o.status = 'cancelled'
      ORDER BY o.created_at DESC
      LIMIT p_limit
    ) t
  ));

  -- 3. Overdue Deliveries
  v_result := v_result || jsonb_build_object('overdue_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        (v_today - d.scheduled_date) AS days_overdue
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status IN ('scheduled', 'in_progress')
        AND d.scheduled_date < v_today
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- 4. Low Stock Items
  v_result := v_result || jsonb_build_object('low_stock', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        p.id,
        p.product_name AS primary_text,
        p.category AS secondary_text,
        COALESCE(inv.quantity_available, 0) AS current_qty,
        COALESCE(inv.reorder_point, 0) AS reorder_point
      FROM products p
      JOIN inventory inv ON inv.product_id = p.id
      WHERE p.is_active = true
        AND (
          (inv.reorder_point IS NOT NULL
            AND inv.reorder_point > 0
            AND COALESCE(inv.quantity_available, 0) < inv.reorder_point)
          OR COALESCE(inv.quantity_available, 0) < 0
        )
      ORDER BY (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) ASC
      LIMIT p_limit
    ) t
  ));

  -- 5. Expiring Quotes (within 7 days)
  v_result := v_result || jsonb_build_object('expiring_quotes', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        q.id,
        q.quote_number AS primary_text,
        c.farm_name AS secondary_text,
        (q.expires_at::date - v_today) AS days_until_expiry
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE q.status IN ('sent', 'revised')
        AND q.is_planned = false
        AND q.expires_at IS NOT NULL
        AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
      ORDER BY q.expires_at ASC
      LIMIT p_limit
    ) t
  ));

  -- 6. Unassigned Deliveries
  v_result := v_result || jsonb_build_object('unassigned_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'scheduled'
        AND d.assigned_driver IS NULL
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- U13<<< 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no
  -- currently-active per-location dispatch — neither the wizard's per-location
  -- assignment NOR (indirectly, via the sync triggers above) a whole-job
  -- applicator has reached the field crew. deleted_at IS NULL mirrors the other
  -- job reads.
  v_result := v_result || jsonb_build_object('unassigned_jobs', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        j.id,
        j.job_number AS primary_text,
        c.farm_name AS secondary_text,
        j.job_date AS scheduled_date
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.status = 'scheduled'
        AND j.deleted_at IS NULL
        -- Codex R1 P2: a job with a legacy WHOLE-JOB applicator is assigned,
        -- not "unassigned" — pre-trigger jobs have no dispatch rows yet (no
        -- backfill: business-data writes are outside this run's additive-only
        -- mandate; rows materialize via the triggers on the next edit, and
        -- FieldView already surfaces legacy assignments client-side).
        AND j.applicator_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM job_location_dispatches d
          WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
        )
      ORDER BY j.job_date ASC
      LIMIT p_limit
    ) t
  ));
  -- >>>U13

  -- 8. Due-today deliveries that have not been started.
  v_result := v_result || jsonb_build_object('due_today_not_started', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.scheduled_date = v_today
        AND d.status = 'scheduled'
        AND d.deleted_at IS NULL
      ORDER BY d.delivery_number ASC
      LIMIT p_limit
    ) t
  ));

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice.
  v_result := v_result || jsonb_build_object('unbilled_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'completed'
        AND d.deleted_at IS NULL
        AND d.order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM invoices i
          WHERE i.order_id = d.order_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
        )
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_dashboard_action_items(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_action_items(int) TO authenticated, service_role;

-- ============================================================================
-- Part 3: make the auto-expire activity row FK-safe and notify quote creators.
-- The existing auto-expire-quotes cron schedule is intentionally untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_quote record;
  v_expired_count integer := 0;
  v_holds_released integer := 0;
  v_hold_count integer;
  v_actor uuid;
BEGIN
  FOR v_quote IN
    SELECT q.* FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status IN ('sent', 'revised')
      AND q.deleted_at IS NULL
      -- A5 (2026-06-10): a quote with partial draw-downs is an open season
      -- booking — being past its quote-expiry date is normal business, not an
      -- expired quote. Never auto-expire it (the undrawn balance would be
      -- destroyed: 'expired' is terminal and releases the booking's holds).
      AND NOT EXISTS (
        SELECT 1 FROM public.quote_product_draws d
        WHERE d.quote_id = q.id AND d.quantity_drawn > 0
      )
      -- #5 (2026-06-13, owner gate G-AE = Option 1): Planned Programs are
      -- deliberate season commitments that reserve inventory on purpose — never
      -- silently auto-expire them (that would release the booking's holds out
      -- from under the forecast). Staff close planned quotes by hand if needed.
      AND q.is_planned = false
    FOR UPDATE SKIP LOCKED
  LOOP
    -- M1 (2026-06-10): release holds BEFORE the status flip so the AFTER
    -- UPDATE trigger finds 0 active holds and its FK-fragile log insert does
    -- not run. End state identical.
    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;
    v_holds_released := v_holds_released + v_hold_count;

    UPDATE public.quotes SET status = 'expired', updated_at = now() WHERE id = v_quote.id;
    v_expired_count := v_expired_count + 1;

    INSERT INTO public.notifications (
      user_id, title, message, notification_type, related_entity_type, related_entity_id
    )
    SELECT
      v_quote.created_by,
      'Quote expired',
      'Quote ' || v_quote.quote_number || ' expired',
      'quote_expired',
      'quote',
      v_quote.id
    FROM public.profiles p
    WHERE v_quote.created_by IS NOT NULL
      AND p.id = v_quote.created_by
      AND p.is_active = true;
  END LOOP;

  IF v_expired_count > 0 THEN
    v_actor := (
      SELECT id
      FROM public.profiles
      WHERE role = 'admin' AND is_active = true
      ORDER BY created_at
      LIMIT 1
    );

    -- Best-effort summary row using a real active admin actor when one exists;
    -- logging must never cancel the expiry work it summarizes.
    IF v_actor IS NOT NULL THEN
      BEGIN
        INSERT INTO public.activity_feed (event_type, description, performed_by)
        VALUES (
          'quotes_auto_expired',
          'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
          v_actor
        );
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('expired_count', v_expired_count, 'holds_released', v_holds_released);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_expire_quotes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_expire_quotes() TO service_role;

-- ============================================================================
-- Part 4: daily 06:20 low-stock and expiring-quote notification safety net.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.run_morning_notification_checks()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Port of checkLowStockNotifications: one alert per active admin and product,
  -- with the same low_stock type and a rolling 24-hour entity-level dedup.
  WITH low_stock_products AS (
    SELECT DISTINCT ON (p.id)
      p.id AS product_id,
      p.product_name,
      COALESCE(inv.quantity_available, 0) AS quantity_available,
      COALESCE(inv.reorder_point, 0) AS reorder_point
    FROM public.products p
    JOIN public.inventory inv ON inv.product_id = p.id
    WHERE p.is_active = true
      AND (
        (inv.reorder_point > 0 AND inv.quantity_available <= inv.reorder_point)
        OR inv.quantity_available < 0
      )
    ORDER BY p.id, COALESCE(inv.quantity_available, 0) ASC
  )
  INSERT INTO public.notifications (
    user_id, title, message, notification_type, related_entity_type, related_entity_id
  )
  SELECT
    admin.id,
    'Low Stock Alert',
    lsp.product_name || ' is low — ' || lsp.quantity_available
      || ' units available (reorder point: ' || lsp.reorder_point || ')',
    'low_stock',
    'product',
    lsp.product_id
  FROM low_stock_products lsp
  CROSS JOIN public.profiles admin
  WHERE admin.role = 'admin'
    AND admin.is_active = true
    AND NOT EXISTS (
      SELECT 1
      FROM public.notifications n
      WHERE n.related_entity_type = 'product'
        AND n.related_entity_id = lsp.product_id
        AND n.notification_type = 'low_stock'
        AND n.created_at >= now() - interval '24 hours'
    );

  -- Port of checkExpiringQuoteNotifications: sent/revised ad-hoc quotes only,
  -- with the same quote_expiring type and rolling 24-hour entity-level dedup.
  WITH expiring_quotes AS (
    SELECT
      q.id AS quote_id,
      q.quote_number,
      q.created_by,
      q.expires_at,
      c.farm_name,
      (q.expires_at::date - CURRENT_DATE) AS days_left
    FROM public.quotes q
    JOIN public.customers c ON c.id = q.customer_id
    WHERE q.status IN ('sent', 'revised')
      AND q.is_planned = false
      AND q.deleted_at IS NULL
      AND q.expires_at BETWEEN now() AND now() + interval '7 days'
  )
  INSERT INTO public.notifications (
    user_id, title, message, notification_type, related_entity_type, related_entity_id
  )
  SELECT
    eq.created_by,
    'Quote Expiring Soon',
    'Quote ' || eq.quote_number || ' for ' || eq.farm_name
      || ' expires in ' || eq.days_left || ' day'
      || CASE WHEN eq.days_left <> 1 THEN 's' ELSE '' END,
    'quote_expiring',
    'quote',
    eq.quote_id
  FROM expiring_quotes eq
  JOIN public.profiles creator ON creator.id = eq.created_by AND creator.is_active = true
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.notifications n
    WHERE n.related_entity_type = 'quote'
      AND n.related_entity_id = eq.quote_id
      AND n.notification_type = 'quote_expiring'
      AND n.created_at >= now() - interval '24 hours'
  );

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.run_morning_notification_checks() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'morning-notification-checks') THEN
    PERFORM cron.unschedule('morning-notification-checks');
  END IF;
  PERFORM cron.schedule(
    'morning-notification-checks',
    '20 6 * * *',
    'SELECT public.run_morning_notification_checks()'
  );
END
$cron$;

-- ============================================================================
-- Part 5: expose customer prepay balances in AR aging/reminder results.
-- ============================================================================

-- The final OUT column changes the return type, so the exact old identity
-- signature must be dropped before the additive replacement is created.
DROP FUNCTION public.get_ar_aging(date);

CREATE OR REPLACE FUNCTION public.get_ar_aging(p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(customer_id uuid, farm_name text, current_amount numeric, days_30 numeric, days_60 numeric, days_90 numeric, over_90 numeric, total_outstanding numeric, prepay_balance_cents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'Admin access required for AR aging report';
  END IF;
  RETURN QUERY
  SELECT c.id AS customer_id, c.farm_name,
    COALESCE(SUM(CASE WHEN age_days <= 29 THEN balance END), 0) AS current_amount,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 30 AND 59 THEN balance END), 0) AS days_30,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 60 AND 89 THEN balance END), 0) AS days_60,
    COALESCE(SUM(CASE WHEN age_days BETWEEN 90 AND 119 THEN balance END), 0) AS days_90,
    COALESCE(SUM(CASE WHEN age_days >= 120 THEN balance END), 0) AS over_90,
    COALESCE(SUM(balance), 0) AS total_outstanding,
    c.prepay_balance_cents
  FROM customers c
  INNER JOIN (
    SELECT i.customer_id, (i.balance_cents::numeric / 100) AS balance, (p_as_of_date - COALESCE(i.due_date, i.invoice_date)::date) AS age_days
    FROM invoices i WHERE i.status IN ('posted', 'overdue') AND i.balance_cents > 0 AND i.deleted_at IS NULL
  ) ar ON ar.customer_id = c.id
  GROUP BY c.id, c.farm_name, c.prepay_balance_cents HAVING SUM(balance) > 0 ORDER BY SUM(balance) DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_ar_aging(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_aging(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
  _role  text;
  v_setting_raw text;
  v_num numeric;
  v_threshold int;
BEGIN
  _role := COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'user_role',
    (SELECT role FROM public.profiles WHERE id = auth.uid())
  );
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  -- Configurable threshold (Settings > app_settings.ar_reminder_days). Robust: take the LEADING
  -- integer part (so '30', '30.0', ' 45 ' all read as 30/30/45 — NOT digit-stripping, which would
  -- turn '30.0'->300 or '1e2'->12), default 30 on blank/garbage/missing, clamp 1..3650 so a bad
  -- value can never break the report.
  SELECT setting_value INTO v_setting_raw FROM app_settings WHERE setting_key = 'ar_reminder_days';
  v_num := (regexp_match(COALESCE(v_setting_raw, ''), '^\s*(\d+)'))[1]::numeric;
  v_threshold := CASE WHEN v_num IS NULL THEN 30 ELSE LEAST(GREATEST(v_num, 1), 3650)::int END;

  SELECT COALESCE(jsonb_agg(row_to_json(cust_agg)::jsonb), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      c.prepay_balance_cents,
      MAX(EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int) AS max_days_past_due,
      COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0) / 100.0 AS total_balance,
      jsonb_agg(jsonb_build_object(
        'invoice_id', i.id,
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'balance_cents', i.balance_cents,
        'days_past_due', EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int
      ) ORDER BY i.invoice_date) AS invoices
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int > v_threshold
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email, c.prepay_balance_cents
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_ar_reminder_candidates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_reminder_candidates() TO authenticated, service_role;

-- ============================================================================
-- Part 6: fail the migration if overloads, ACLs, behavior markers, or cron drift.
-- ============================================================================

DO $post_check$
DECLARE
  v_name text;
  v_count integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'get_inventory_position',
    'get_dashboard_action_items',
    'get_ar_aging',
    'get_ar_reminder_candidates',
    'run_morning_notification_checks',
    'auto_expire_quotes'
  ]
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_name;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'U18 post-check: expected one public.% overload, found %', v_name, v_count;
    END IF;

    SELECT count(*) INTO v_count
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = v_name
      AND has_function_privilege('anon', p.oid, 'EXECUTE');

    IF v_count <> 0 THEN
      RAISE EXCEPTION 'U18 post-check: anon retains EXECUTE on public.%', v_name;
    END IF;
  END LOOP;

  IF has_function_privilege(
    'authenticated',
    'public.run_morning_notification_checks()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: authenticated retains EXECUTE on run_morning_notification_checks';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'get_inventory_position'
      AND p.prosrc LIKE '%quantity_available < 0%'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: get_inventory_position negative-stock marker missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'get_dashboard_action_items'
      AND p.prosrc LIKE '%COALESCE(inv.quantity_available, 0) < 0%'
      AND p.prosrc LIKE '%q.status IN (''sent'', ''revised'')%'
      AND p.prosrc LIKE '%q.is_planned = false%'
      AND p.prosrc LIKE '%due_today_not_started%'
      AND p.prosrc LIKE '%unbilled_deliveries%'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: dashboard behavior marker missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'auto_expire_quotes'
      AND p.prosrc LIKE '%quote_expired%'
      AND p.prosrc LIKE '%WHERE role = ''admin'' AND is_active = true%'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: auto-expire notification/activity marker missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'run_morning_notification_checks'
      AND p.prosrc LIKE '%low_stock%'
      AND p.prosrc LIKE '%quote_expiring%'
      AND p.prosrc LIKE '%interval ''24 hours''%'
      AND p.prosrc LIKE '%q.status IN (''sent'', ''revised'')%'
      AND p.prosrc LIKE '%q.is_planned = false%'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: morning notification marker missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'get_ar_aging'
      AND p.prosrc LIKE '%prepay_balance_cents%'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: get_ar_aging prepay marker missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'get_ar_reminder_candidates'
      AND p.prosrc LIKE '%prepay_balance_cents%'
  ) THEN
    RAISE EXCEPTION 'U18 post-check: AR reminder prepay marker missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM cron.job
  WHERE jobname = 'morning-notification-checks';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'U18 post-check: expected one morning-notification-checks cron job, found %', v_count;
  END IF;
END
$post_check$;

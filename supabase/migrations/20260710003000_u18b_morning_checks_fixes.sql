-- U18b: fix morning notification expiry window and per-recipient dedup.

CREATE OR REPLACE FUNCTION public.run_morning_notification_checks()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Port of checkLowStockNotifications: one alert per active admin and product,
  -- with the same low_stock type and a rolling 24-hour per-recipient dedup.
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
        AND n.user_id = admin.id
        AND n.created_at >= now() - interval '24 hours'
    );

  -- Port of checkExpiringQuoteNotifications: sent/revised ad-hoc quotes only,
  -- with a same-day-inclusive date window, the same quote_expiring type, and a
  -- rolling 24-hour per-recipient dedup.
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
      AND q.expires_at::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
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
      AND n.user_id = eq.created_by
      AND n.created_at >= now() - interval '24 hours'
  );

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.run_morning_notification_checks() FROM PUBLIC, anon, authenticated;

DO $post_check$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'run_morning_notification_checks';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'U18b post-check: expected one public.run_morning_notification_checks overload, found %', v_count;
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.run_morning_notification_checks()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'U18b post-check: authenticated retains EXECUTE on run_morning_notification_checks';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'run_morning_notification_checks'
      AND p.prosrc LIKE '%expires_at::date BETWEEN CURRENT_DATE%'
      AND p.prosrc LIKE '%n.user_id = admin.id%'
  ) THEN
    RAISE EXCEPTION 'U18b post-check: morning notification fix marker missing';
  END IF;
END;
$post_check$;

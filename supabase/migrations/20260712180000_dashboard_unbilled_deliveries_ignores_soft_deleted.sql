-- Money+Inventory night hunt 2026-07-10, cycle 4 (finding #9c), Codex-gated.
-- get_dashboard_action_items item #9 (unbilled_deliveries) treated a SOFT-DELETED
-- invoice as active coverage: its NOT EXISTS(...) subquery filtered only on
-- status NOT IN ('voided','cancelled') and delivery/order match, but delete_invoices
-- soft-deletes a draft/unposted invoice (sets deleted_at) while LEAVING status='draft',
-- so a delivery whose only invoice was soft-deleted was wrongly judged "covered" and
-- dropped off the dashboard "unbilled deliveries" action item — the office never
-- learned it still needed billing. Companion to migration 20260712170000 (the
-- create_invoice_for_unbilled_delivery guard) and the OfficeCockpit tile fix.
--
-- Fix: add `AND i.deleted_at IS NULL` to item #9's NOT EXISTS subquery. Body is
-- otherwise byte-identical to the live function (corrected-body md5 ==
-- a9e0872a5e84c9889863989c822867af).

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
            AND i.deleted_at IS NULL
        )
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  RETURN v_result;
END;
$function$;

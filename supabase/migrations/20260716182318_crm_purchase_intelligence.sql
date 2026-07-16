-- CRM relationship-intelligence Phase 2: read-only purchase and prep-card RPCs.

CREATE OR REPLACE FUNCTION public.get_customer_purchase_summary(
  p_customer_id uuid,
  p_season text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := COALESCE(p_season::integer, public.current_season());
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (
        public.is_admin()
        OR (
          public.is_sales_rep()
          AND EXISTS (
            SELECT 1 FROM public.customers c
            WHERE c.id = p_customer_id
              AND c.assigned_sales_rep = auth.uid()
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN jsonb_build_object(
    'season', v_season::text,
    'total_invoiced_cents', COALESCE((
      SELECT SUM(i.total_amount_cents)::bigint
      FROM public.invoices i
      WHERE i.customer_id = p_customer_id
        AND i.season = v_season
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ), 0),
    'invoice_count', (
      SELECT COUNT(*)
      FROM public.invoices i
      WHERE i.customer_id = p_customer_id
        AND i.season = v_season
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ),
    'top_products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_name', ranked.product_name,
        'total_qty', ranked.total_qty,
        'total_revenue_cents', ranked.total_revenue_cents
      ) ORDER BY ranked.total_revenue_cents DESC, ranked.product_name)
      FROM (
        SELECT
          COALESCE(p.product_name, ii.description) AS product_name,
          SUM(ii.quantity) AS total_qty,
          SUM(ii.extended_cents)::bigint AS total_revenue_cents
        FROM public.invoices i
        JOIN public.invoice_items ii ON ii.invoice_id = i.id
        LEFT JOIN public.products p ON p.id = ii.product_id
        WHERE i.customer_id = p_customer_id
          AND i.season = v_season
          AND i.deleted_at IS NULL
          AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
          AND i.status IN ('posted', 'paid', 'overdue')
        GROUP BY ii.product_id, COALESCE(p.product_name, ii.description)
        ORDER BY SUM(ii.extended_cents) DESC, COALESCE(p.product_name, ii.description)
        LIMIT 10
      ) ranked
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_customer_lapsed_products(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := public.current_season();
  v_last_season integer := v_season - 1;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.id = p_customer_id AND c.assigned_sales_rep = auth.uid()
      )))
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN jsonb_build_object(
    'season', v_season::text,
    'last_season', v_last_season::text,
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_name', lapsed.product_name,
        'last_season_qty', lapsed.last_season_qty,
        'last_season_revenue_cents', lapsed.last_season_revenue_cents
      ) ORDER BY lapsed.last_season_revenue_cents DESC, lapsed.product_name)
      FROM (
        SELECT
          ii.product_id,
          COALESCE(p.product_name, ii.description) AS product_name,
          SUM(ii.quantity) AS last_season_qty,
          SUM(ii.extended_cents)::bigint AS last_season_revenue_cents
        FROM public.invoices i
        JOIN public.invoice_items ii ON ii.invoice_id = i.id
        LEFT JOIN public.products p ON p.id = ii.product_id
        WHERE i.customer_id = p_customer_id
          AND i.season = v_last_season
          AND i.deleted_at IS NULL
          AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
          AND i.status IN ('posted', 'paid', 'overdue')
          AND ii.product_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.invoices current_invoice
            JOIN public.invoice_items current_item ON current_item.invoice_id = current_invoice.id
            WHERE current_invoice.customer_id = p_customer_id
              AND current_invoice.season = v_season
              AND current_invoice.deleted_at IS NULL
              AND COALESCE(current_invoice.invoice_type, 'invoice') <> 'credit_memo'
              AND current_invoice.status IN ('posted', 'paid', 'overdue')
              AND current_item.product_id = ii.product_id
          )
        GROUP BY ii.product_id, COALESCE(p.product_name, ii.description)
      ) lapsed
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_customer_prep_card(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.id = p_customer_id AND c.assigned_sales_rep = auth.uid()
      )))
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'customer_id', c.id,
      'farm_name', c.farm_name,
      'contacts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', cc.id, 'name', cc.name, 'role', cc.role,
          'phone_display', cc.phone_display, 'phone_e164', cc.phone_e164,
          'preferred_contact_method', cc.preferred_contact_method
        ) ORDER BY cc.is_primary DESC, cc.name)
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id AND (cc.is_primary OR cc.is_active)
      ), '[]'::jsonb),
      'balance_credit', jsonb_build_object(
        'credit_limit_cents', COALESCE(c.credit_limit_cents, 0),
        'prepay_balance_cents', COALESCE(c.prepay_balance_cents, 0),
        'open_ar_cents', COALESCE((
          SELECT SUM(i.balance_cents)::bigint FROM public.invoices i
          WHERE i.customer_id = c.id AND i.deleted_at IS NULL
            AND i.status IN ('posted', 'overdue')
        ), 0)
      ),
      'last_invoice', (
        SELECT jsonb_build_object('date', i.invoice_date, 'total_cents', i.total_amount_cents)
        FROM public.invoices i
        WHERE i.customer_id = c.id AND i.deleted_at IS NULL
          AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
          AND i.status IN ('posted', 'paid', 'overdue')
        ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT 1
      ),
      'last_interaction', (
        SELECT jsonb_build_object(
          'occurred_at', ci.occurred_at, 'type', ci.interaction_type,
          'outcome', ci.outcome, 'summary', ci.summary, 'contact_name', cc.name
        )
        FROM public.customer_interactions ci
        LEFT JOIN public.customer_contacts cc ON cc.id = ci.contact_id
        WHERE ci.customer_id = c.id
        ORDER BY ci.occurred_at DESC LIMIT 1
      ),
      'open_follow_ups_count', (
        SELECT COUNT(*) FROM public.team_notes tn
        WHERE tn.linked_entity_type = 'customer' AND tn.linked_entity_id = c.id
          AND tn.note_type = 'todo' AND NOT tn.is_completed AND tn.deleted_at IS NULL
      ),
      'top_verified_facts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'category', facts.category, 'fact_key', facts.fact_key,
          'value_text', facts.value_text, 'value_json', facts.value_json
        ) ORDER BY facts.reviewed_at DESC)
        FROM (
          SELECT cf.category, cf.fact_key, cf.value_text, cf.value_json, cf.reviewed_at
          FROM public.customer_facts cf
          WHERE cf.customer_id = c.id AND cf.status = 'verified'
            AND cf.superseded_at IS NULL AND (cf.expires_at IS NULL OR cf.expires_at > now())
          ORDER BY cf.reviewed_at DESC LIMIT 6
        ) facts
      ), '[]'::jsonb),
      'acres_tier', jsonb_build_object(
        'total_acres', c.total_acres, 'corn_acres', c.corn_acres,
        'soybean_acres', c.soybean_acres, 'other_acres', c.other_acres,
        'assigned_tier', c.assigned_tier
      )
    )
    FROM public.customers c WHERE c.id = p_customer_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_rep_customer_purchase_flags(p_season text DEFAULT NULL)
RETURNS TABLE(
  customer_id uuid,
  farm_name text,
  this_season_cents bigint,
  last_season_cents bigint,
  lapsed boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := COALESCE(p_season::integer, public.current_season());
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.farm_name,
    COALESCE(SUM(i.total_amount_cents) FILTER (
      WHERE i.season = v_season AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ), 0)::bigint,
    COALESCE(SUM(i.total_amount_cents) FILTER (
      WHERE i.season = v_season - 1 AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ), 0)::bigint,
    COALESCE(SUM(i.total_amount_cents) FILTER (
      WHERE i.season = v_season - 1 AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ), 0) > 0
    AND COALESCE(SUM(i.total_amount_cents) FILTER (
      WHERE i.season = v_season AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ), 0) = 0
  FROM public.customers c
  LEFT JOIN public.invoices i ON i.customer_id = c.id
  WHERE public.is_admin() OR c.assigned_sales_rep = auth.uid()
  GROUP BY c.id, c.farm_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_purchase_summary(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_customer_lapsed_products(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_customer_prep_card(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_rep_customer_purchase_flags(text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_customer_purchase_summary(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_lapsed_products(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_prep_card(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_rep_customer_purchase_flags(text) TO authenticated;

COMMENT ON FUNCTION public.get_customer_purchase_summary(uuid, text) IS
  'Returns one authorized customer''s seasonal invoiced total, count, and ten highest-revenue products.';
COMMENT ON FUNCTION public.get_customer_lapsed_products(uuid) IS
  'Returns authorized customer products purchased last season but not this season.';
COMMENT ON FUNCTION public.get_customer_prep_card(uuid) IS
  'Returns one authorized customer prep-card snapshot: contacts, balances, recency, follow-ups, facts, acres, and tier.';
COMMENT ON FUNCTION public.get_rep_customer_purchase_flags(text) IS
  'Returns seasonal versus prior-season purchase flags for all customers an active caller may access.';

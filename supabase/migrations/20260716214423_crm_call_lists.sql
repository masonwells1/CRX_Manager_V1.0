-- CRM relationship-intelligence Phase 3.1: read-only seasonal call lists.
-- All money exposed by these RPCs is returned as integer cents.

CREATE OR REPLACE FUNCTION public.get_call_list_prepay_prospects(
  p_rep_id uuid DEFAULT NULL,
  p_min_prior_spend_cents bigint DEFAULT 100000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := public.current_season();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  RETURN (
    WITH prior_spend AS (
      SELECT i.customer_id, SUM(i.total_amount_cents)::bigint AS prior_season_spend_cents
      FROM public.invoices i
      WHERE i.season = v_season - 1
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
      GROUP BY i.customer_id
    ),
    current_prepay AS (
      SELECT pc.customer_id, SUM(pc.balance_cents)::bigint AS current_season_prepay_cents
      FROM public.prepay_credits pc
      WHERE pc.season = v_season
        AND pc.balance_cents > 0
      GROUP BY pc.customer_id
    )
    SELECT jsonb_build_object(
      'success', true,
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'prior_season_spend_cents', rows.prior_season_spend_cents,
        'current_season_prepay_cents', rows.current_season_prepay_cents
      ) ORDER BY rows.prior_season_spend_cents DESC, rows.farm_name, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        ps.prior_season_spend_cents,
        COALESCE(cp.current_season_prepay_cents, 0)::bigint AS current_season_prepay_cents
      FROM public.customers c
      JOIN prior_spend ps ON ps.customer_id = c.id
      LEFT JOIN current_prepay cp ON cp.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND ps.prior_season_spend_cents >= p_min_prior_spend_cents
        AND COALESCE(cp.current_season_prepay_cents, 0) = 0
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY ps.prior_season_spend_cents DESC, c.farm_name, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_no_recent_contact(
  p_rep_id uuid DEFAULT NULL,
  p_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  IF p_days < 0 THEN
    RAISE EXCEPTION 'CALL_LIST_INVALID_DAYS';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'days_since_last_interaction', rows.days_since_last_interaction
      ) ORDER BY rows.last_interaction_at NULLS FIRST, rows.farm_name, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        -- Same rolling-clock boundary as the WHERE filter below: a row shown with
        -- days_since >= p_days is always one the filter admitted (Codex M2).
        CASE
          WHEN interaction.last_interaction_at IS NULL THEN NULL
          ELSE floor(EXTRACT(epoch FROM (now() - interaction.last_interaction_at)) / 86400)::int
        END AS days_since_last_interaction
      FROM public.customers c
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND (
          interaction.last_interaction_at IS NULL
          OR interaction.last_interaction_at < now() - make_interval(days => p_days)
        )
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY interaction.last_interaction_at NULLS FIRST, c.farm_name, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_stale_quotes(
  p_rep_id uuid DEFAULT NULL,
  p_days integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  IF p_days < 0 THEN
    RAISE EXCEPTION 'CALL_LIST_INVALID_DAYS';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'quote_id', rows.quote_id,
        'quote_number', rows.quote_number,
        'quote_total_cents', rows.quote_total_cents,
        'quote_updated_at', rows.quote_updated_at,
        'quote_age_days', rows.quote_age_days
      ) ORDER BY rows.quote_updated_at, rows.quote_number, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        q.id AS quote_id,
        q.quote_number,
        ROUND(q.total_price * 100)::bigint AS quote_total_cents,
        q.updated_at AS quote_updated_at,
        (CURRENT_DATE - q.updated_at::date) AS quote_age_days
      FROM public.quotes q
      JOIN public.customers c ON c.id = q.customer_id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND q.deleted_at IS NULL
        AND q.status IN ('draft', 'sent', 'revised')
        AND q.updated_at < now() - make_interval(days => p_days)
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY q.updated_at, q.quote_number, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_lapsed_products(
  p_rep_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer := public.current_season();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  RETURN (
    -- Authorization scope comes FIRST so the invoice-item aggregation below only
    -- ever runs over customers the caller may see (Codex gate finding: aggregating
    -- all customers' items before the rep filter wastes work at scale).
    WITH authorized_customers AS (
      SELECT c.id, c.farm_name, c.assigned_sales_rep
      FROM public.customers c
      WHERE c.is_active
        AND (
          (public.is_admin() AND (p_rep_id IS NULL OR c.assigned_sales_rep = p_rep_id))
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
    ),
    lapsed_products AS (
      SELECT
        i.customer_id,
        ii.product_id,
        COALESCE(p.product_name, ii.description) AS product_name,
        SUM(ii.extended_cents)::bigint AS prior_revenue_cents
      FROM public.invoices i
      JOIN authorized_customers ac ON ac.id = i.customer_id
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
      LEFT JOIN public.products p ON p.id = ii.product_id
      WHERE i.season = v_season - 1
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
        AND ii.product_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.invoices current_invoice
          JOIN public.invoice_items current_item ON current_item.invoice_id = current_invoice.id
          WHERE current_invoice.customer_id = i.customer_id
            AND current_invoice.season = v_season
            AND current_invoice.deleted_at IS NULL
            AND COALESCE(current_invoice.invoice_type, 'invoice') <> 'credit_memo'
            AND current_invoice.status IN ('posted', 'paid', 'overdue')
            AND current_item.product_id = ii.product_id
        )
      GROUP BY i.customer_id, ii.product_id, COALESCE(p.product_name, ii.description)
    ),
    ranked_lapsed_products AS (
      SELECT
        lp.*,
        ROW_NUMBER() OVER (
          PARTITION BY lp.customer_id
          ORDER BY lp.prior_revenue_cents DESC, lp.product_name, lp.product_id
        ) AS product_rank
      FROM lapsed_products lp
    ),
    lapsed_accounts AS (
      SELECT
        rlp.customer_id,
        COUNT(*)::integer AS lapsed_count,
        MAX(rlp.product_name) FILTER (WHERE rlp.product_rank = 1) AS top_lapsed_product_name,
        MAX(rlp.prior_revenue_cents) FILTER (WHERE rlp.product_rank = 1)::bigint
          AS top_lapsed_product_prior_revenue_cents
      FROM ranked_lapsed_products rlp
      GROUP BY rlp.customer_id
    )
    SELECT jsonb_build_object(
      'success', true,
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'lapsed_count', rows.lapsed_count,
        'top_lapsed_product_name', rows.top_lapsed_product_name,
        'top_lapsed_product_prior_revenue_cents', rows.top_lapsed_product_prior_revenue_cents
      ) ORDER BY rows.lapsed_count DESC, rows.top_lapsed_product_prior_revenue_cents DESC, rows.farm_name, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        la.lapsed_count,
        la.top_lapsed_product_name,
        la.top_lapsed_product_prior_revenue_cents
      FROM lapsed_accounts la
      JOIN authorized_customers c ON c.id = la.customer_id
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      ORDER BY la.lapsed_count DESC, la.top_lapsed_product_prior_revenue_cents DESC, c.farm_name, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_call_list_unassigned_accounts(
  p_rep_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (public.is_admin() OR public.is_sales_rep())
  ) OR (
    public.is_sales_rep()
    AND p_rep_id IS NOT NULL
    AND p_rep_id <> auth.uid()
  ) THEN
    RAISE EXCEPTION 'CALL_LIST_ACCESS_DENIED';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'success', true,
      'rows', COALESCE(jsonb_agg(jsonb_build_object(
        'customer_id', rows.customer_id,
        'farm_name', rows.farm_name,
        'assigned_sales_rep', rows.assigned_sales_rep,
        'primary_contact_name', rows.primary_contact_name,
        'phone_display', rows.phone_display,
        'phone_e164', rows.phone_e164,
        'last_interaction_at', rows.last_interaction_at,
        'account_created_at', rows.account_created_at
      ) ORDER BY rows.account_created_at DESC, rows.customer_id), '[]'::jsonb)
    )
    FROM (
      SELECT
        c.id AS customer_id,
        c.farm_name,
        c.assigned_sales_rep,
        contact.name AS primary_contact_name,
        contact.phone_display,
        contact.phone_e164,
        interaction.last_interaction_at,
        c.created_at AS account_created_at
      FROM public.customers c
      LEFT JOIN LATERAL (
        SELECT cc.name, cc.phone_display, cc.phone_e164
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id
          AND cc.is_primary
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ci.occurred_at) AS last_interaction_at
        FROM public.customer_interactions ci
        WHERE ci.customer_id = c.id
      ) interaction ON true
      WHERE c.is_active
        AND c.assigned_sales_rep IS NULL
        AND (
          (public.is_admin() AND p_rep_id IS NULL)
          OR (public.is_sales_rep() AND c.assigned_sales_rep = auth.uid())
        )
      ORDER BY c.created_at DESC, c.id
      LIMIT 200
    ) rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_call_list_prepay_prospects(uuid, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_call_list_no_recent_contact(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_call_list_stale_quotes(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_call_list_lapsed_products(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_call_list_unassigned_accounts(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_call_list_prepay_prospects(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_list_no_recent_contact(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_list_stale_quotes(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_list_lapsed_products(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_call_list_unassigned_accounts(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_call_list_prepay_prospects(uuid, bigint) IS
  'Returns authorized active customers with qualifying prior-season invoiced spend and no positive current-season prepay credit.';
COMMENT ON FUNCTION public.get_call_list_no_recent_contact(uuid, integer) IS
  'Returns authorized active customers with no interaction in the requested number of days, including never-contacted customers.';
COMMENT ON FUNCTION public.get_call_list_stale_quotes(uuid, integer) IS
  'Returns authorized active customers with open draft, sent, or revised quotes untouched for the requested number of days.';
COMMENT ON FUNCTION public.get_call_list_lapsed_products(uuid) IS
  'Returns authorized active customers summarized by products invoiced last season but not this season.';
COMMENT ON FUNCTION public.get_call_list_unassigned_accounts(uuid) IS
  'Returns active unassigned customers to administrators; sales representatives receive no unassigned accounts.';

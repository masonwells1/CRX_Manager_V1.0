-- CRM relationship-intelligence follow-up: add a by-QUANTITY top-products list
-- to the customer prep card, alongside the existing by-revenue list that
-- get_customer_purchase_summary.top_products already returns.
--
-- This re-emits get_customer_prep_card VERBATIM from migration
-- 20260716182318_crm_purchase_intelligence.sql (the live definition; grep
-- confirms no other migration re-emits it) with EXACTLY ONE addition: the
-- 'top_products_by_quantity' payload key. Signature, SECDEF/STABLE/search_path,
-- and the anon-lockout/GRANT posture are unchanged.

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
      -- Open workflow counts (Sol amendment 8): what is in flight right now.
      'open_workflow_counts', jsonb_build_object(
        'quotes', (
          SELECT COUNT(*) FROM public.quotes q
          WHERE q.customer_id = c.id AND q.deleted_at IS NULL
            AND q.status IN ('draft', 'sent', 'revised')
        ),
        'orders', (
          SELECT COUNT(*) FROM public.orders o
          WHERE o.customer_id = c.id AND o.deleted_at IS NULL
            AND o.status IN ('confirmed', 'partially_fulfilled')
        ),
        'deliveries', (
          SELECT COUNT(*) FROM public.deliveries d
          WHERE d.customer_id = c.id AND d.deleted_at IS NULL
            AND d.status IN ('scheduled', 'in_progress')
        )
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
      -- ONLY addition vs the live 20260716182318 body: top products ranked by
      -- QUANTITY. Grouped per (product, unit) so a sum NEVER mixes units: a
      -- product invoiced in two units appears as two separate lines, each
      -- labeled with its own unit ("unit" is NULL when the invoice lines carry
      -- none -- the UI renders the quantity bare in that case). Units still
      -- differ ACROSS products (gal vs lb vs AC), so line magnitudes are not
      -- directly comparable -- the UI displays the unit on every line. Same
      -- invoice scope/filters/period as
      -- get_customer_purchase_summary.top_products (current season,
      -- posted|paid|overdue, non-credit, not-deleted, product lines only) and
      -- the same LIMIT 10.
      'top_products_by_quantity', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'product_id', ranked_qty.product_id,
          'product_name', ranked_qty.product_name,
          'total_quantity', ranked_qty.total_quantity,
          'unit', ranked_qty.unit
        ) ORDER BY ranked_qty.total_quantity DESC, ranked_qty.product_name, ranked_qty.unit, ranked_qty.product_id)
        FROM (
          SELECT
            ii.product_id AS product_id,
            p.product_name AS product_name,
            SUM(ii.quantity) AS total_quantity,
            -- Unit shown next to quantity on the invoice PDF line:
            -- invoice_items.unit_size, falling back to invoice_items.rate_unit.
            -- Part of the GROUP BY, so each output row is single-unit.
            COALESCE(NULLIF(ii.unit_size, ''), NULLIF(ii.rate_unit, '')) AS unit
          FROM public.invoices i
          JOIN public.invoice_items ii ON ii.invoice_id = i.id
          JOIN public.products p ON p.id = ii.product_id
          WHERE i.customer_id = c.id
            AND i.season = public.current_season()
            AND i.deleted_at IS NULL
            AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
            AND i.status IN ('posted', 'paid', 'overdue')
            -- Products only: service-fee / misc lines have no product_id and
            -- must not rank in "top products".
            AND ii.product_id IS NOT NULL
          GROUP BY ii.product_id, p.product_name,
            COALESCE(NULLIF(ii.unit_size, ''), NULLIF(ii.rate_unit, ''))
          ORDER BY SUM(ii.quantity) DESC, p.product_name,
            COALESCE(NULLIF(ii.unit_size, ''), NULLIF(ii.rate_unit, '')),
            ii.product_id
          LIMIT 10
        ) ranked_qty
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

-- Preserve the anon-lockout / authenticated-only posture verbatim.
REVOKE ALL ON FUNCTION public.get_customer_prep_card(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_prep_card(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_customer_prep_card(uuid) IS
  'Returns one authorized customer prep-card snapshot: contacts, balances, recency, follow-ups, facts, top products by quantity, acres, and tier.';

-- Sprint 7: Quote Templates
-- Allows saving quote structures as reusable templates
-- and creating new quotes from templates

CREATE TABLE IF NOT EXISTS quote_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  description text,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES profiles(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quote_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read templates"
  ON quote_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin and sales can manage templates"
  ON quote_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'sales_rep')));

-- RPC: save_quote_template
-- Snapshots a quote's structure (sections + items) as a reusable template
CREATE OR REPLACE FUNCTION public.save_quote_template(
  p_quote_id uuid,
  p_template_name text,
  p_description text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sections jsonb;
  v_template_id uuid;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (key, entity_type, entity_id)
    VALUES (p_idempotency_key, 'quote_template', p_quote_id);
  END IF;

  -- Build sections snapshot (strips customer-specific data like prices)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'section_name', qs.section_name,
      'sort_order', qs.sort_order,
      'section_notes', qs.section_notes,
      'section_header_notes', qs.section_header_notes,
      'items', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'product_id', qi.product_id,
            'product_name', p.product_name,
            'sku', p.sku,
            'sort_order', qi.sort_order,
            'notes', qi.notes,
            'suggested_rate', qi.suggested_rate,
            'actual_rate', qi.actual_rate,
            'rate_unit', qi.rate_unit,
            'calc_mode', qi.calc_mode
          ) ORDER BY qi.sort_order
        ), '[]'::jsonb)
        FROM quote_items qi
        JOIN products p ON p.id = qi.product_id
        WHERE qi.section_id = qs.id
      )
    ) ORDER BY qs.sort_order
  ), '[]'::jsonb) INTO v_sections
  FROM quote_sections qs WHERE qs.quote_id = p_quote_id;

  INSERT INTO quote_templates (template_name, description, sections, created_by)
  VALUES (p_template_name, p_description, v_sections, p_performed_by)
  RETURNING id INTO v_template_id;

  RETURN jsonb_build_object('status', 'created', 'template_id', v_template_id);
END;
$$;

-- RPC: create_quote_from_template
-- Creates a new draft quote from a template, applying customer tier pricing
CREATE OR REPLACE FUNCTION public.create_quote_from_template(
  p_template_id uuid,
  p_customer_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_template quote_templates%ROWTYPE;
  v_customer customers%ROWTYPE;
  v_quote_id uuid;
  v_quote_number text;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_tier_price numeric;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (key, entity_type, entity_id)
    VALUES (p_idempotency_key, 'quote_from_template', p_template_id);
  END IF;

  SELECT * INTO v_template FROM quote_templates WHERE id = p_template_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template not found: %', p_template_id; END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  -- Generate quote number
  SELECT generate_quote_number() INTO v_quote_number;

  -- Create quote
  INSERT INTO quotes (quote_number, customer_id, created_by, tier, status, valid_days,
    commission_split)
  VALUES (v_quote_number, p_customer_id, p_performed_by, v_customer.assigned_tier, 'draft', 15,
    v_customer.default_commission_split)
  RETURNING id INTO v_quote_id;

  -- Create sections and items from template
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_template.sections)
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_quote_id, v_section->>'section_name', (v_section->>'sort_order')::integer,
      v_section->>'section_notes', v_section->>'section_header_notes')
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      -- Get tier price for this product
      SELECT CASE v_customer.assigned_tier
        WHEN 1 THEN COALESCE(tier1_price, 0)
        WHEN 2 THEN COALESCE(tier2_price, tier1_price, 0)
        WHEN 3 THEN COALESCE(tier3_price, tier1_price, 0)
        ELSE COALESCE(tier1_price, 0)
      END INTO v_tier_price
      FROM products WHERE id = (v_item->>'product_id')::uuid;

      INSERT INTO quote_items (quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit, calc_mode)
      VALUES (v_quote_id, v_section_id, (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer, v_item->>'notes',
        v_tier_price,
        (SELECT current_cost FROM products WHERE id = (v_item->>'product_id')::uuid),
        v_item->>'suggested_rate', (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit', v_item->>'calc_mode');
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'quote_id', v_quote_id, 'quote_number', v_quote_number);
END;
$$;

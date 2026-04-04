-- Fix global_search: escape ILIKE wildcards (%, _, \) in user input
-- Without this, typing "%" matches every row in every table

CREATE OR REPLACE FUNCTION public.global_search(
  p_query text,
  p_limit int DEFAULT 5
)
RETURNS TABLE(
  entity_type text,
  id uuid,
  primary_text text,
  secondary_text text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pattern text;
  v_escaped text;
BEGIN
  IF length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  -- Escape ILIKE metacharacters before wrapping in wildcards
  v_escaped := regexp_replace(trim(p_query), '([%_\\])', E'\\\\\\1', 'g');
  v_pattern := '%' || v_escaped || '%';

  RETURN QUERY
  (
    SELECT
      'customer'::text AS entity_type,
      c.id,
      c.farm_name AS primary_text,
      COALESCE(c.contact_name, '')::text AS secondary_text
    FROM customers c
    WHERE c.is_active = true
      AND (c.farm_name ILIKE v_pattern OR c.contact_name ILIKE v_pattern OR c.account_number ILIKE v_pattern)
    ORDER BY c.farm_name
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'order'::text AS entity_type,
      o.id,
      o.order_number AS primary_text,
      COALESCE(c2.farm_name, '')::text AS secondary_text
    FROM orders o
    LEFT JOIN customers c2 ON c2.id = o.customer_id
    WHERE o.order_number ILIKE v_pattern
    ORDER BY o.created_at DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'invoice'::text AS entity_type,
      i.id,
      i.invoice_number AS primary_text,
      COALESCE(c3.farm_name, '')::text AS secondary_text
    FROM invoices i
    LEFT JOIN customers c3 ON c3.id = i.customer_id
    WHERE i.invoice_number ILIKE v_pattern
    ORDER BY i.created_at DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'delivery'::text AS entity_type,
      d.id,
      d.delivery_number AS primary_text,
      COALESCE(c4.farm_name, '')::text AS secondary_text
    FROM deliveries d
    LEFT JOIN customers c4 ON c4.id = d.customer_id
    WHERE d.delivery_number ILIKE v_pattern
    ORDER BY d.created_at DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'product'::text AS entity_type,
      p.id,
      p.product_name AS primary_text,
      COALESCE(p.category, '')::text AS secondary_text
    FROM products p
    WHERE p.is_active = true
      AND (p.product_name ILIKE v_pattern OR p.sku ILIKE v_pattern)
    ORDER BY p.product_name
    LIMIT p_limit
  );
END;
$$;

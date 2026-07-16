-- Preserve an existing purchase-order line's cost when an edit payload omits
-- both cost representations. The integer-cents save function intentionally
-- defaults missing costs to zero for new lines, so this wrapper hydrates only
-- recognized existing lines before the internal writer performs immutability,
-- header-total, and line-update calculations.

DO $guard$
BEGIN
  IF to_regprocedure('public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Expected save_purchase_order(uuid,jsonb,jsonb,uuid,text)';
  END IF;
  IF to_regprocedure('public._save_purchase_order_cost_input_impl(uuid,jsonb,jsonb,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '_save_purchase_order_cost_input_impl already exists';
  END IF;
END
$guard$;

ALTER FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  RENAME TO _save_purchase_order_cost_input_impl;

REVOKE ALL ON FUNCTION public._save_purchase_order_cost_input_impl(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_hydrated_items jsonb;
BEGIN
  IF p_po_id IS NULL THEN
    v_hydrated_items := p_items;
  ELSE
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN poi.id IS NOT NULL
               AND NOT (item.value ? 'unit_cost')
               AND NOT (item.value ? 'unit_cost_cents')
            THEN item.value || jsonb_build_object('unit_cost_cents', poi.unit_cost_cents)
          ELSE item.value
        END
        ORDER BY item.ordinality
      ),
      '[]'::jsonb
    )
      INTO v_hydrated_items
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, ordinality)
      LEFT JOIN public.purchase_order_items poi
        ON poi.purchase_order_id = p_po_id
       AND poi.id::text = item.value->>'id';
  END IF;

  RETURN public._save_purchase_order_cost_input_impl(
    p_po_id,
    p_po_payload,
    v_hydrated_items,
    p_performed_by,
    p_idempotency_key
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text)
  IS 'Saves a purchase order while preserving stored integer-cent cost when an existing line edit omits cost fields.';

DO $verify$
DECLARE
  v_config text[];
  v_source text;
BEGIN
  SELECT proconfig, prosrc
    INTO v_config, v_source
    FROM pg_proc
   WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure;

  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'save_purchase_order must keep fixed public, pg_temp search_path';
  END IF;
  IF v_source NOT LIKE '%unit_cost_cents%'
     OR v_source NOT LIKE '%NOT (item.value ? ''unit_cost'')%'
     OR v_source NOT LIKE '%poi.purchase_order_id = p_po_id%' THEN
    RAISE EXCEPTION 'save_purchase_order must hydrate omitted existing-line cost from the same purchase order';
  END IF;
  IF has_function_privilege('anon', 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public._save_purchase_order_cost_input_impl(uuid,jsonb,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Purchase-order cost wrapper grants are too broad';
  END IF;
END
$verify$;

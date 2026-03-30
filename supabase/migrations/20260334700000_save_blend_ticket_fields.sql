-- Save blend ticket field assignments (delete + re-insert pattern)
CREATE OR REPLACE FUNCTION save_blend_ticket_fields(
  p_blend_ticket_id uuid,
  p_fields jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_field jsonb;
  v_count integer := 0;
  v_existing text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  DELETE FROM blend_ticket_fields WHERE blend_ticket_id = p_blend_ticket_id;

  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres, sort_order)
    VALUES (
      p_blend_ticket_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'customer_id')::uuid,
      (v_field->>'planned_acres')::numeric,
      v_count
    );
    v_count := v_count + 1;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_blend_ticket_fields', jsonb_build_object('fields_saved', v_count));
  END IF;

  RETURN jsonb_build_object('fields_saved', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION save_blend_ticket_fields(uuid, jsonb, uuid, text) TO authenticated;

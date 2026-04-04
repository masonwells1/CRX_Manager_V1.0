-- Batch reject blend tickets RPC
-- Mirrors batch_approve_blend_tickets for the reject flow
-- Used by BlendTickets bulk action bar

CREATE OR REPLACE FUNCTION public.batch_reject_blend_tickets(
  p_ticket_ids uuid[],
  p_rejected_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer := 0;
  v_existing text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  UPDATE blend_tickets
  SET review_status = 'rejected',
      reviewed_by = p_rejected_by,
      reviewed_at = now()
  WHERE id = ANY(p_ticket_ids)
    AND status = 'completed'
    AND review_status = 'unreviewed'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_reject_blend_tickets', jsonb_build_object('rejected_count', v_count)::text);
  END IF;

  RETURN jsonb_build_object('rejected_count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_reject_blend_tickets(uuid[], uuid, text) TO authenticated;

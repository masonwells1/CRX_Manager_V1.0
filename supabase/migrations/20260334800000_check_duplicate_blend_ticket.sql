-- Duplicate blend ticket detection
-- Checks if a ticket with the same number and date already exists

CREATE OR REPLACE FUNCTION check_duplicate_blend_ticket(
  p_ticket_number text,
  p_ticket_date date
)
RETURNS TABLE(id uuid, ticket_number text, ticket_date date, status text, review_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT bt.id, bt.ticket_number, bt.ticket_date, bt.status, bt.review_status
    FROM blend_tickets bt
    WHERE bt.ticket_number = p_ticket_number
      AND bt.ticket_date = p_ticket_date
      AND bt.deleted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION check_duplicate_blend_ticket(text, date) TO authenticated;

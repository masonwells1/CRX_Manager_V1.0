-- Migration: Server-side number generation for deliveries and POs
-- Problem: Client-side count+1 pattern causes race conditions when two users
--          create a delivery or PO at the same time, resulting in duplicate
--          numbers and insert failures (UNIQUE constraint violation).
-- Solution: Use PostgreSQL advisory locks + MAX+1 inside the DB function.
--           Advisory locks are lightweight, session-scoped, and don't block
--           unrelated queries.

-- ============================================================
-- 1. next_delivery_number()
--    Format: DEL-00001 (global sequential, zero-padded 5 digits)
-- ============================================================
CREATE OR REPLACE FUNCTION next_delivery_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_num int;
  v_next text;
BEGIN
  -- Advisory lock key: unique integer for delivery number generation
  -- Using a fixed key (hash of 'delivery_number') to serialize access
  PERFORM pg_advisory_xact_lock(hashtext('next_delivery_number'));

  -- Find the current max numeric suffix from existing delivery numbers
  SELECT COALESCE(
    MAX(
      CASE
        WHEN delivery_number ~ '^DEL-\d+$'
        THEN CAST(split_part(delivery_number, '-', 2) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM deliveries;

  v_next := 'DEL-' || lpad((v_max_num + 1)::text, 5, '0');

  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION next_delivery_number() TO authenticated;


-- ============================================================
-- 2. next_po_number()
--    Format: PO-YYYY-0001 (year-scoped sequential, zero-padded 4 digits)
-- ============================================================
CREATE OR REPLACE FUNCTION next_po_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;

  -- Advisory lock key: unique integer for PO number generation
  PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));

  -- Find the current max numeric suffix for the current year
  SELECT COALESCE(
    MAX(
      CASE
        WHEN po_number ~ ('^PO-' || v_year || '-\d+$')
        THEN CAST(split_part(po_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM purchase_orders;

  v_next := 'PO-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION next_po_number() TO authenticated;

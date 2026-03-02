-- Fix: Drop ambiguous 3-param overload of receive_po_items
-- Problem: PostgREST cannot disambiguate between:
--   receive_po_items(jsonb, uuid, text)
--   receive_po_items(jsonb, uuid, text, boolean)
-- Solution: Drop the 3-param version. The 4-param version has DEFAULT false
-- for p_allow_over_receive, so it handles both cases.

DROP FUNCTION IF EXISTS receive_po_items(jsonb, uuid, text);

-- Verify the 4-param version still exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'receive_po_items'
      AND p.pronargs = 4
  ) THEN
    RAISE EXCEPTION 'receive_po_items(4 params) not found after dropping 3-param version!';
  END IF;
END $$;

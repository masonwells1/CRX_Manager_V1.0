-- ============================================================================
-- S5-4: COMMISSION RECIPIENT FK
-- CRX Manager V1.0
-- Date: 2026-02-11
--
-- Problem: commissions.recipient is a text field matched against profiles.full_name.
-- If a name changes, commissions orphan. If two users share a name, they collide.
--
-- Fix: Add recipient_user_id UUID FK. Backfill from profiles. Update RLS.
-- Keep recipient text column for display (denormalized), but use FK for security.
-- ============================================================================

-- 1. Add the FK column (nullable initially for backfill)
ALTER TABLE commissions
  ADD COLUMN IF NOT EXISTS recipient_user_id uuid REFERENCES profiles(id);

-- 2. Backfill existing rows by matching recipient name to profiles.full_name
UPDATE commissions c
SET recipient_user_id = p.id
FROM profiles p
WHERE c.recipient = p.full_name
  AND c.recipient_user_id IS NULL;

-- 3. Create index for FK lookups and RLS performance
CREATE INDEX IF NOT EXISTS idx_commissions_recipient_user_id
  ON commissions(recipient_user_id);

-- 4. Drop old RLS policy and replace with FK-based policy
DROP POLICY IF EXISTS "comm_rep_select" ON commissions;

CREATE POLICY "comm_rep_select" ON commissions FOR SELECT TO authenticated
  USING (
    is_sales_rep() AND (
      recipient_user_id = auth.uid()
      -- Fallback to name matching for any rows that couldn't be backfilled
      OR (recipient_user_id IS NULL AND EXISTS (
        SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND commissions.recipient = p.full_name
      ))
    )
  );

-- NOTE: RPC redefinitions for convert_quote_to_order and create_direct_order
-- were REMOVED from this migration file. The original versions lacked inventory
-- safety checks (FOR UPDATE locks, availability validation, prebooking) that
-- are present in sprint0_emergency_fixes.sql and sprint5_updated_rpcs.sql.
-- The production RPCs already include recipient_user_id population.
-- See: 20260211200000_sprint0_emergency_fixes.sql for the correct RPC logic.

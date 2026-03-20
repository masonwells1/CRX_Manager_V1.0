-- Enable RLS and add deny-all policy on rate_limit_log
-- This table is only accessed by SECURITY DEFINER functions, not directly by users
ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all direct access to rate_limit_log"
  ON rate_limit_log
  FOR ALL
  USING (false);

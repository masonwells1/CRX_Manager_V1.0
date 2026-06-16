-- Follow-up to add_order_shares_total_guard: _validate_order_shares_total() is SECURITY DEFINER
-- and received the default PUBLIC EXECUTE grant on creation, so it surfaced in the db-invariant
-- 'anon-exec-secdef' sweep. It is a TRIGGER function (anon cannot invoke it directly — Postgres
-- rejects a direct call), so this is defense-in-depth, but the project's convention is to revoke
-- EXECUTE on SECURITY DEFINER trigger functions (cf. _enforce_quote_terminal_not_drawn, already
-- revoked). Tighten to the function owner / service_role only; keeps the sweep clean.
-- Rollback: GRANT EXECUTE ON FUNCTION public._validate_order_shares_total() TO PUBLIC;

REVOKE EXECUTE ON FUNCTION public._validate_order_shares_total() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._validate_order_shares_total() FROM anon;
REVOKE EXECUTE ON FUNCTION public._validate_order_shares_total() FROM authenticated;

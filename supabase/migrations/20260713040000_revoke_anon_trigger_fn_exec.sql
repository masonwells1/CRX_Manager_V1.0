-- Grant hygiene: three trigger functions carried EXECUTE for anon (default
-- PUBLIC grant from their original migrations). Trigger functions cannot be
-- invoked directly (they RETURN trigger), so the grants are inert — but the
-- anon-exec invariant sweep rightly flags them, and the project convention is
-- an explicit revoke on every function anon should never touch.
--
-- Flagged by the post-apply sweep on 2026-07-11 (all three predate that night's
-- migrations). Trigger execution is unaffected: triggers fire as the table
-- owner regardless of EXECUTE grants.

REVOKE ALL ON FUNCTION public.enforce_blend_ticket_fields_billed_lock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_blend_ticket_fields_billed_lock() FROM anon;

REVOKE ALL ON FUNCTION public.fields_acre_authority_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fields_acre_authority_guard() FROM anon;

REVOKE ALL ON FUNCTION public.recalc_product_price_per_acre() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalc_product_price_per_acre() FROM anon;

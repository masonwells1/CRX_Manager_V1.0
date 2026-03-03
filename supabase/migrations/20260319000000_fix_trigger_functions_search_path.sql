-- ============================================================================
-- Migration: 20260319000000_fix_trigger_functions_search_path.sql
-- Purpose:   Fix 11 trigger functions that call _is_admin_override() but
--            have no SET search_path clause.
--
-- Root cause:
--   Security-definer RPCs (e.g. record_invoice_payment) run with
--   SET search_path = ''. When those RPCs UPDATE a row that fires a trigger,
--   the trigger function inherits the empty search_path. Without an explicit
--   SET search_path, the trigger can't resolve _is_admin_override() (which
--   lives in the public schema) and raises:
--     ERROR: function _is_admin_override() does not exist
--
--   Partial payments didn't surface this because the status stays 'posted'
--   (OLD.status = NEW.status → early return before _is_admin_override() is
--   called). Full payments change status to 'paid', hitting the call site.
--
-- Fix:
--   Add SET search_path TO 'public' to all 11 affected trigger functions
--   using ALTER FUNCTION (no need to rewrite function bodies).
-- ============================================================================

-- Status-transition guards
ALTER FUNCTION public._enforce_delivery_status_transition() SET search_path TO 'public';
ALTER FUNCTION public._enforce_invoice_status_transition()  SET search_path TO 'public';
ALTER FUNCTION public._enforce_job_status_transition()      SET search_path TO 'public';
ALTER FUNCTION public._enforce_order_status_transition()    SET search_path TO 'public';
ALTER FUNCTION public._enforce_po_status_transition()       SET search_path TO 'public';
ALTER FUNCTION public._enforce_quote_status_transition()    SET search_path TO 'public';
ALTER FUNCTION public._enforce_return_status_transition()   SET search_path TO 'public';

-- Hard-delete guards
ALTER FUNCTION public._guard_delivery_delete() SET search_path TO 'public';
ALTER FUNCTION public._guard_invoice_delete()  SET search_path TO 'public';
ALTER FUNCTION public._guard_order_delete()    SET search_path TO 'public';
ALTER FUNCTION public._guard_po_delete()       SET search_path TO 'public';

-- ============================================================================
-- Codex review fix for PR #59 (P2, 2026-05-12) — Populate recipient_user_id
-- in _insert_commissions_for_order when the display name resolves to a profile.
-- ============================================================================
-- Audit finding: the helper introduced in 20260513020000_canonical_commission_
-- math.sql only sets `recipient` (display name from CommissionSplitEditor) and
-- leaves `recipient_user_id` NULL. The CommissionPayments flow groups unpaid
-- commissions by `recipient_user_id`, and `create_commission_payment` raises
-- when it cannot find a non-null recipient id. Result: every commission row
-- created through this helper (which is now the single source of truth for
-- convert_quote_to_order, create_direct_order, and create_quick_delivery)
-- shows as "Unknown" in the payment UI and cannot be paid.
--
-- Note: this is pre-existing behavior — every prior commission INSERT path
-- also omitted recipient_user_id. The helper just preserved the same pattern.
--
-- Fix: LEFT-JOIN profiles by full_name when inserting. If exactly one active
-- profile matches the recipient display name, use its id. If zero or multiple
-- match, leave NULL (safest fallback — admin can still see/manage the row
-- via the recipient text, and create_commission_payment will surface a
-- clear error for any NULL recipient_user_id row).
--
-- Hardcoded recipient list in CommissionSplitEditor.tsx:
--   - 'Mason Wells'       → resolves to admin profile (will populate)
--   - 'Chance Tuttle'     → resolves to sales_rep profile (will populate)
--   - 'CMCTW LLC'         → entity, no profile (stays NULL by design)
--   - 'Crop Rx Solutions' → entity, no profile (stays NULL by design)
--
-- Lookup uses case-insensitive trimmed comparison to tolerate minor whitespace
-- variations between the dropdown value and profile.full_name. Limited to
-- is_active = true profiles so deactivated employees don't get associated
-- with new commissions.
--
-- Function bodies for the 3 caller RPCs (convert_quote_to_order,
-- create_direct_order, create_quick_delivery) are unchanged — they call this
-- helper and benefit from the fix without modification.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._insert_commissions_for_order(
  p_order_id          uuid,
  p_customer_id       uuid,
  p_order_profit      numeric,
  p_commission_split  jsonb,
  p_order_date        date DEFAULT current_date
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int := 0;
BEGIN
  IF p_commission_split IS NULL OR NOT (p_commission_split ? 'splits') THEN
    RETURN 0;
  END IF;

  INSERT INTO public.commissions (
    order_id, customer_id, recipient, recipient_user_id, split_percentage,
    commission_amount, order_profit, order_date, status
  )
  SELECT
    p_order_id,
    p_customer_id,
    s->>'recipient',
    -- Resolve display name to profile id when exactly one active profile
    -- matches. Returns NULL for entity recipients ('CMCTW LLC' etc.) or
    -- ambiguous matches. Codex P2 fix (PR #59, 2026-05-12).
    (
      SELECT CASE WHEN count(*) = 1 THEN max(p.id) ELSE NULL END
      FROM public.profiles p
      WHERE lower(trim(p.full_name)) = lower(trim(s->>'recipient'))
        AND p.is_active = true
    ),
    (s->>'percentage')::numeric,
    public.compute_commission_amount(p_order_profit, (s->>'percentage')::numeric),
    COALESCE(p_order_profit, 0),
    p_order_date,
    'pending'
  FROM jsonb_array_elements(p_commission_split->'splits') s
  WHERE (s->>'recipient') IS NOT NULL
    AND (s->>'percentage')::numeric > 0;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Keep the lock-down from 20260513070000_lock_down_commission_helper.sql:
-- helper is not exposed to authenticated callers; only the 3 SECURITY DEFINER
-- wrappers (convert_quote_to_order / create_direct_order / create_quick_delivery)
-- reach it through owner privilege.
REVOKE ALL ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM authenticated;

COMMENT ON FUNCTION public._insert_commissions_for_order IS
  'Internal helper for the 3 canonical commission-creating RPCs. Populates recipient_user_id via case-insensitive full_name lookup against active profiles when exactly one match exists (codex P2 fix for PR #59, 2026-05-13). NOT callable from PostgREST.';

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_has_recipient_user_id boolean;
  v_authenticated_has_grant boolean;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = '_insert_commissions_for_order' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of _insert_commissions_for_order, found %', v_overload_count;
  END IF;

  SELECT prosrc ~ 'recipient_user_id'
    INTO v_has_recipient_user_id
  FROM pg_proc
  WHERE proname = '_insert_commissions_for_order' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_recipient_user_id, false) THEN
    RAISE EXCEPTION 'codex-fix verification: _insert_commissions_for_order body missing recipient_user_id INSERT column';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name   = '_insert_commissions_for_order'
      AND grantee        = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ) INTO v_authenticated_has_grant;
  IF v_authenticated_has_grant THEN
    RAISE EXCEPTION 'codex-fix verification: _insert_commissions_for_order regrants EXECUTE to authenticated (lock-down regressed)';
  END IF;

  RAISE NOTICE 'codex-fix: _insert_commissions_for_order now populates recipient_user_id via full_name lookup.';
END
$$;

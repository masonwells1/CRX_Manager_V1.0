-- ============================================================================
-- Codex review fix for PR #59 (P1, 2026-05-13) — Avoid max(uuid) aggregate
-- in _insert_commissions_for_order recipient lookup.
-- ============================================================================
-- The prior migration (20260513090000_commissions_populate_recipient_user_id.sql)
-- introduced a recipient_user_id lookup using
--   SELECT CASE WHEN count(*) = 1 THEN max(p.id) ELSE NULL END FROM profiles ...
--
-- PostgreSQL/Supabase does NOT provide max(uuid) — there's no max aggregate
-- registered for the UUID type. Verified live:
--   ERROR:  42883: function max(uuid) does not exist
--
-- Net effect of 20260513090000 on apply: every call to _insert_commissions_for_order
-- with a recipient that has a matching profile (e.g. 'Mason Wells',
-- 'Chance Tuttle') raises and rolls back the wrapping order/quick-delivery
-- RPC. Entity recipients ('CMCTW LLC', 'Crop Rx Solutions') would also hit
-- this because the aggregate runs regardless of match count.
--
-- Fix: replace the aggregate with a correlated scalar subquery that returns
-- the single matching id (or NULL when zero or multiple match) without
-- aggregating UUIDs. Behavior is identical to the intent of the previous
-- migration — best-effort full_name resolution, NULL fallback for ambiguous
-- or absent matches.
--
-- This migration supersedes 20260513090000's function body. No frontend
-- impact, no schema changes; only the helper body is rewritten.
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
    -- ambiguous matches. No UUID aggregate — inner count subquery decides
    -- whether to emit the single id. Codex P1 fix (PR #59, 2026-05-13).
    (
      SELECT p.id
      FROM public.profiles p
      WHERE lower(trim(p.full_name)) = lower(trim(s->>'recipient'))
        AND p.is_active = true
        AND (
          SELECT count(*) FROM public.profiles p2
          WHERE lower(trim(p2.full_name)) = lower(trim(s->>'recipient'))
            AND p2.is_active = true
        ) = 1
      LIMIT 1
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

-- Preserve the lock-down from 20260513070000:
REVOKE ALL ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date) FROM authenticated;

COMMENT ON FUNCTION public._insert_commissions_for_order IS
  'Internal helper for the 3 canonical commission-creating RPCs. Populates recipient_user_id via case-insensitive full_name lookup against active profiles when exactly one match exists. No UUID aggregate (codex P1 fix for PR #59, 2026-05-13). NOT callable from PostgREST.';

-- ─── Verification ────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_has_recipient_user_id boolean;
  v_has_max_uuid boolean;
  v_authenticated_has_grant boolean;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = '_insert_commissions_for_order' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of _insert_commissions_for_order, found %', v_overload_count;
  END IF;

  -- Body must still write recipient_user_id (lookup preserved)
  SELECT prosrc ~ 'recipient_user_id'
    INTO v_has_recipient_user_id
  FROM pg_proc
  WHERE proname = '_insert_commissions_for_order' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_has_recipient_user_id, false) THEN
    RAISE EXCEPTION 'codex-fix verification: _insert_commissions_for_order body missing recipient_user_id';
  END IF;

  -- Body must NOT contain the broken max() aggregate
  SELECT prosrc ~ 'max\s*\(\s*p\.id\s*\)'
    INTO v_has_max_uuid
  FROM pg_proc
  WHERE proname = '_insert_commissions_for_order' AND pronamespace = 'public'::regnamespace;
  IF COALESCE(v_has_max_uuid, false) THEN
    RAISE EXCEPTION 'codex-fix verification: _insert_commissions_for_order still uses max(uuid) aggregate';
  END IF;

  -- Lock-down preserved
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

  RAISE NOTICE 'codex-fix: _insert_commissions_for_order recipient_user_id lookup rewritten without UUID aggregate.';
END
$$;

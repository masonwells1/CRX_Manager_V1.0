-- APPLIED LIVE (2026-07-15): Supabase ledger version 20260715203911 recorded
-- this migration under name 20260715182757_park_returns_creation_rpc_only.
-- Keep the checked-in filename on the ledger version so local reconciliation
-- and registry high-water checks agree with live state.
--
-- Section 5-8 closure survivor: public.returns still had the original
-- role-only returns_insert RLS policy plus an authenticated INSERT privilege.
-- An active admin/sales user could therefore create a return header directly,
-- bypassing create_return's atomic item creation, delivered-quantity ceiling,
-- source-order/customer checks, server-derived prices, and idempotency.
--
-- Return creation is RPC-only after this migration:
--   * authenticated callers retain EXECUTE on the privileged
--     public.create_return(jsonb,jsonb,text) API;
--   * direct header INSERT is removed at both the RLS-policy and table-grant
--     layers;
--   * direct return_items INSERT/UPDATE/DELETE is revoked as defense-in-depth.
--
-- Deliberately preserved: public.returns UPDATE/DELETE privileges and policies.
-- The July 15 lifecycle trigger still governs allowed soft-delete and lifecycle
-- behavior, so this migration does not broaden or remove those existing paths.

DROP POLICY IF EXISTS returns_insert ON public.returns;
REVOKE INSERT ON TABLE public.returns FROM PUBLIC, anon, authenticated;

-- The July 14 source-of-truth migration already removed these policies. Repeat
-- the named drops idempotently, then remove the remaining table privilege so a
-- future permissive policy alone cannot reopen direct line mutation.
DROP POLICY IF EXISTS return_items_insert ON public.return_items;
DROP POLICY IF EXISTS return_items_update ON public.return_items;
DROP POLICY IF EXISTS return_items_delete ON public.return_items;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.return_items
  FROM PUBLIC, anon, authenticated;

-- Re-state the intended callable boundary. create_return performs its own
-- active admin/sales authorization before its privileged writes.
REVOKE EXECUTE ON FUNCTION public.create_return(jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_return(jsonb, jsonb, text)
  TO authenticated, service_role;

DO $guard$
DECLARE
  v_create_return regprocedure := to_regprocedure('public.create_return(jsonb,jsonb,text)');
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policy p
    WHERE p.polrelid = 'public.returns'::regclass
      AND p.polcmd IN ('a', '*')
  ) THEN
    RAISE EXCEPTION 'public.returns still has an INSERT/FOR ALL policy';
  END IF;

  IF has_table_privilege('authenticated', 'public.returns', 'INSERT')
     OR has_table_privilege('anon', 'public.returns', 'INSERT') THEN
    RAISE EXCEPTION 'public.returns remains directly insertable by an external API role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policy p
    WHERE p.polrelid = 'public.return_items'::regclass
      AND p.polcmd IN ('a', 'w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'public.return_items still has a direct mutation policy';
  END IF;

  IF has_table_privilege('authenticated', 'public.return_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.return_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.return_items', 'DELETE')
     OR has_table_privilege('anon', 'public.return_items', 'INSERT')
     OR has_table_privilege('anon', 'public.return_items', 'UPDATE')
     OR has_table_privilege('anon', 'public.return_items', 'DELETE') THEN
    RAISE EXCEPTION 'public.return_items remains directly mutable by an external API role';
  END IF;

  IF v_create_return IS NULL THEN
    RAISE EXCEPTION 'canonical public.create_return(jsonb,jsonb,text) is missing';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'create_return'
  ) <> 1 THEN
    RAISE EXCEPTION 'create_return overload count is not exactly one';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = v_create_return
      AND p.prosecdef
      AND EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.proconfig, '{}'::text[])) AS config(value)
        WHERE replace(config.value, ' ', '') = 'search_path=public,pg_temp'
      )
      AND p.prosrc LIKE '%v_actor uuid := auth.uid()%'
      AND p.prosrc LIKE '%role IN (''admin'', ''sales_rep'')%'
      AND p.prosrc LIKE '%INSERT INTO public.returns%'
      AND p.prosrc LIKE '%INSERT INTO public.return_items%'
  ) THEN
    RAISE EXCEPTION 'create_return lost its definer privilege, search_path, role gate, or atomic write contract';
  END IF;

  IF NOT has_function_privilege(
       'authenticated', 'public.create_return(jsonb,jsonb,text)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.create_return(jsonb,jsonb,text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'create_return external EXECUTE grants do not match the authenticated-only API contract';
  END IF;
END;
$guard$;

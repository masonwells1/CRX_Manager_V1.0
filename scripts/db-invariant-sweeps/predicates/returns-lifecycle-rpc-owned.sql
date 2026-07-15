-- predicate: returns-lifecycle-rpc-owned
-- Return status transitions were already RPC-gated, but Section 8 found the
-- broader lifecycle/audit surface still needed deterministic coverage:
-- approval, receipt, cancellation, and credit fields must be writable only by
-- return RPCs or scoped admin_override blocks. approve_return/cancel_return
-- must also reject NULL/forged actor arguments instead of writing nullable
-- attribution. Direct soft-delete and hard-delete must remain limited to
-- requested/rejected/cancelled returns so active returns stay visible to
-- terminal order guards. Return creation is RPC-owned too: returns must have
-- no INSERT/FOR ALL policy and browser roles must have no INSERT privilege;
-- return_items must have neither mutation policies nor browser-role DML.
-- Historical catch: 2026-07-15 Live Foundation Gauntlet Section 8.
-- Contract: EXPECT ZERO rows. Missing trigger coverage or nullable actor gates
-- are violations, as is any reopened direct return creation/item-write path.

WITH trigger_guard AS (
  SELECT t.tgname,
         pg_get_triggerdef(t.oid) AS trigger_def,
         pg_get_functiondef(t.tgfoid) AS function_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.returns'::regclass
     AND t.tgname = 'trg_return_lifecycle_rpc_owned'
     AND NOT t.tgisinternal
     AND t.tgenabled <> 'D'
),
fn AS (
  SELECT p.oid::regprocedure::text AS signature,
         p.prosrc
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('approve_return', 'cancel_return')
)
SELECT 'returns:trg_return_lifecycle_rpc_owned' AS violation_key,
       'return lifecycle trigger is missing, disabled, or not attached as a BEFORE UPDATE/DELETE guard' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM trigger_guard
    WHERE trigger_def ILIKE 'CREATE TRIGGER trg_return_lifecycle_rpc_owned BEFORE%UPDATE%ON public.returns%'
      AND trigger_def ILIKE 'CREATE TRIGGER trg_return_lifecycle_rpc_owned BEFORE%DELETE%ON public.returns%'
      AND function_def LIKE '%RETURN_LIFECYCLE_VIA_RPC_ONLY%'
      AND function_def LIKE '%RETURN_DELETE_STATUS_LOCKED%'
      AND function_def LIKE '%TG_OP = ''DELETE''%'
      AND function_def LIKE '%IF OLD.status NOT IN%'
      AND function_def NOT LIKE '%IF TG_OP = ''DELETE'' THEN%current_setting(''app.return_rpc'', true)%OLD.status NOT IN%'
      AND function_def LIKE '%RETURN OLD%'
      AND function_def LIKE '%current_setting(''app.return_rpc'', true)%'
      AND function_def LIKE '%_is_admin_override%'
      AND function_def LIKE '%requested_at%'
      AND function_def LIKE '%deleted_at%'
      AND function_def LIKE '%approved_by%'
      AND function_def LIKE '%received_by%'
      AND function_def LIKE '%cancelled_by%'
      AND function_def LIKE '%credit_invoice_id%'
      AND function_def LIKE '%total_credit_cents%'
      AND function_def LIKE '%credited_by%'
 )

UNION ALL

SELECT 'approve_return(uuid, uuid, text)' AS violation_key,
       'approve_return must require p_approved_by to equal auth.uid() and write v_actor attribution' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM fn
    WHERE signature = 'approve_return(uuid,uuid,text)'
      AND prosrc LIKE '%p_approved_by IS DISTINCT FROM v_actor%'
      AND prosrc NOT LIKE '%p_approved_by IS NOT NULL AND%'
      AND prosrc LIKE '%approved_by = v_actor%'
 )

UNION ALL

SELECT 'cancel_return(uuid, text, uuid, text)' AS violation_key,
       'cancel_return must require p_performed_by to equal auth.uid() and write v_actor attribution' AS reason
 WHERE NOT EXISTS (
   SELECT 1
     FROM fn
    WHERE signature = 'cancel_return(uuid,text,uuid,text)'
      AND prosrc LIKE '%p_performed_by IS DISTINCT FROM v_actor%'
      AND prosrc NOT LIKE '%p_performed_by IS NOT NULL AND%'
      AND prosrc LIKE '%cancelled_by = v_actor%'
      AND prosrc LIKE '%performed_by, notes%'
 )

UNION ALL

SELECT 'returns:external-insert-policy' AS violation_key,
       'public.returns must not have an INSERT or FOR ALL policy; create_return is the canonical creation path' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_policy p
    WHERE p.polrelid = 'public.returns'::regclass
      AND p.polcmd IN ('a', '*')
 )

UNION ALL

SELECT 'returns:browser-insert-privilege' AS violation_key,
       'anon/authenticated must not hold direct INSERT on public.returns' AS reason
 WHERE has_table_privilege('authenticated', 'public.returns', 'INSERT')
    OR has_table_privilege('anon', 'public.returns', 'INSERT')

UNION ALL

SELECT 'return_items:external-mutation-policy' AS violation_key,
       'public.return_items must not have INSERT/UPDATE/DELETE/FOR ALL policies' AS reason
 WHERE EXISTS (
   SELECT 1
     FROM pg_policy p
    WHERE p.polrelid = 'public.return_items'::regclass
      AND p.polcmd IN ('a', 'w', 'd', '*')
 )

UNION ALL

SELECT 'return_items:browser-mutation-privilege' AS violation_key,
       'anon/authenticated must not hold direct INSERT, UPDATE, or DELETE on public.return_items' AS reason
 WHERE has_table_privilege('authenticated', 'public.return_items', 'INSERT')
    OR has_table_privilege('authenticated', 'public.return_items', 'UPDATE')
    OR has_table_privilege('authenticated', 'public.return_items', 'DELETE')
    OR has_table_privilege('anon', 'public.return_items', 'INSERT')
    OR has_table_privilege('anon', 'public.return_items', 'UPDATE')
    OR has_table_privilege('anon', 'public.return_items', 'DELETE');

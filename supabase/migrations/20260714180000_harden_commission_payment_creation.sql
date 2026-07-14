-- Harden commission payment creation and RLS from live foundation gauntlet
--
-- Fixes:
-- 1. commission payment tables: remove direct authenticated write policies so
--    create/post/void RPCs are the only authenticated mutation path.
-- 2. create_commission_payment: reject stale selections instead of silently
--    creating a partial payment from the still-pending subset.
-- 3. commissions SELECT: remove legacy full-name recipient fallback after
--    asserting payable/live rows have recipient_user_id.

-- ---------------------------------------------------------------------------
-- RLS: commission payment tables are readable by active admins only; writes go
-- through SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "commission_payment_items_insert_admin" ON public.commission_payment_items;
DROP POLICY IF EXISTS "commission_payment_items_admin_delete" ON public.commission_payment_items;
DROP POLICY IF EXISTS "commission_payment_items_select_admin" ON public.commission_payment_items;
CREATE POLICY "commission_payment_items_select_admin"
  ON public.commission_payment_items
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS "commission_payments_insert_admin" ON public.commission_payments;
DROP POLICY IF EXISTS "commission_payments_update_admin" ON public.commission_payments;
DROP POLICY IF EXISTS "commission_payments_admin_delete" ON public.commission_payments;
DROP POLICY IF EXISTS "commission_payments_select_admin" ON public.commission_payments;
CREATE POLICY "commission_payments_select_admin"
  ON public.commission_payments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_admin());

-- ---------------------------------------------------------------------------
-- RLS: retire legacy name-based commission visibility. Payable/paid commission
-- rows must have recipient_user_id before this policy is tightened.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.commissions c
    WHERE c.deleted_at IS NULL
      AND c.status IN ('pending', 'paid')
      AND c.recipient_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot remove commission full-name fallback: payable/paid commissions without recipient_user_id exist';
  END IF;
END $$;

DROP POLICY IF EXISTS "comm_rep_select" ON public.commissions;
DROP POLICY IF EXISTS "comm_select" ON public.commissions;
CREATE POLICY "comm_select" ON public.commissions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    is_admin()
    OR (
      is_sales_rep()
      AND recipient_user_id = (SELECT auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- RPC: all selected commission IDs must still be payable at submit time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[],
  p_payment_method text,
  p_reference text,
  p_payment_date date,
  p_notes text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor             uuid;
  v_existing          jsonb;
  v_payment_id        uuid;
  v_payment_num       text;
  v_total             numeric := 0;
  v_recipient_id      uuid;
  v_season            integer;
  v_payment_dt        date;
  v_selected_count    integer := 0;
  v_locked_count      integer := 0;
  v_non_pending_count integer := 0;
  v_recipient_count   integer := 0;
  v_already_in_payment integer := 0;
  v_item_count        integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_commission_payment');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing #>> '{}')::uuid;
    END IF;
  END IF;

  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  PERFORM check_period_open(v_payment_dt);

  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  SELECT count(*)
    INTO v_selected_count
    FROM (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids;

  IF v_selected_count = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Lock every selected existing row, regardless of status. The later checks
  -- then run against the locked set and cannot silently filter stale rows out.
  PERFORM 1
     FROM commissions c
     JOIN (
       SELECT DISTINCT id
       FROM unnest(p_commission_ids) AS selected(id)
     ) selected_ids ON selected_ids.id = c.id
    FOR UPDATE OF c;

  SELECT count(*)
    INTO v_locked_count
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id;

  IF v_locked_count <> v_selected_count THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_SELECTION_STALE: one or more selected commissions no longer exist';
  END IF;

  SELECT count(*)
    INTO v_non_pending_count
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id
   WHERE c.deleted_at IS NOT NULL
      OR c.status IS DISTINCT FROM 'pending';

  IF v_non_pending_count > 0 THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_SELECTION_STALE: every selected commission must still be pending';
  END IF;

  SELECT count(*)
    INTO v_already_in_payment
    FROM commission_payment_items cpi
    JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = cpi.commission_id
   WHERE cp.status IS DISTINCT FROM 'voided';

  IF v_already_in_payment > 0 THEN
    RAISE EXCEPTION 'One or more commissions are already in an existing (non-voided) payment. Void that payment first or remove those commissions from the selection.';
  END IF;

  SELECT count(DISTINCT c.recipient_user_id)
    INTO v_recipient_count
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id;

  IF v_recipient_count <> 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  SELECT c.recipient_user_id
    INTO v_recipient_id
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id
   LIMIT 1;

  SELECT sum(c.commission_amount)
    INTO v_total
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id;

  v_season := compute_season(v_payment_dt);
  v_payment_num := next_commission_payment_number();

  INSERT INTO commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, v_actor
  ) RETURNING id INTO v_payment_id;

  INSERT INTO commission_payment_items (
    commission_payment_id, commission_id, amount
  )
  SELECT v_payment_id, c.id, c.commission_amount
    FROM commissions c
    JOIN (
      SELECT DISTINCT id
      FROM unnest(p_commission_ids) AS selected(id)
    ) selected_ids ON selected_ids.id = c.id
   WHERE c.deleted_at IS NULL
     AND c.status = 'pending';

  GET DIAGNOSTICS v_item_count = ROW_COUNT;
  IF v_item_count <> v_selected_count THEN
    RAISE EXCEPTION 'COMMISSION_PAYMENT_SELECTION_STALE: expected % commission payment item(s), inserted %',
      v_selected_count, v_item_count;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    v_actor, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created (UNPOSTED) for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM profiles WHERE id = v_recipient_id)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_commission_payment', to_jsonb(v_payment_id::text));
  END IF;

  RETURN v_payment_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
  v_src text;
  v_secdef boolean;
  v_config text[];
  v_sig constant text := 'public.create_commission_payment(uuid[],text,text,date,text,uuid,text)';
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'create_commission_payment'
    AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_commission_payment overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc, prosecdef, proconfig INTO v_src, v_secdef, v_config
  FROM pg_proc
  WHERE proname = 'create_commission_payment'
    AND pronamespace = 'public'::regnamespace;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'create_commission_payment is no longer SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) cfg
    WHERE cfg LIKE 'search_path=%' AND cfg LIKE '%public%' AND cfg LIKE '%pg_temp%'
  ) THEN
    RAISE EXCEPTION 'create_commission_payment lost SET search_path = public, pg_temp';
  END IF;

  IF position('v_locked_count <> v_selected_count' IN v_src) = 0
     OR position('v_non_pending_count > 0' IN v_src) = 0
     OR position('GET DIAGNOSTICS v_item_count = ROW_COUNT' IN v_src) = 0
     OR position('v_item_count <> v_selected_count' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_commission_payment is missing stale-selection guards';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('commission_payments', 'commission_payment_items')
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'commission payment tables still expose direct authenticated write policies';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'commissions'
      AND policyname = 'comm_select'
      AND coalesce(qual, '') ILIKE '%full_name%'
  ) THEN
    RAISE EXCEPTION 'comm_select still contains legacy full-name fallback';
  END IF;

  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'create_commission_payment: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'create_commission_payment: service_role lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'create_commission_payment: anon must NOT have EXECUTE';
  END IF;
END $$;

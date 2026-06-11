-- idempotency-body-check: exempt
-- ============================================================================
-- create_commission_payment: FOR UPDATE + DISTINCT (SQLSTATE 0A000) hard break
-- ============================================================================
-- BUG (plpgsql_check sweep 2026-06-10 — error-prevention execution log §4
-- item 1): the live body contains, in ONE statement:
--
--       SELECT DISTINCT c.recipient_user_id
--         INTO v_recipient_id
--         FROM commissions c
--        WHERE c.id = ANY(p_commission_ids)
--          AND c.status = 'pending'
--          FOR UPDATE;
--
-- PostgreSQL rejects row locking combined with DISTINCT at plan time
-- (0A000: "FOR UPDATE is not allowed with DISTINCT clause"). plpgsql plans
-- statements lazily, so the function CREATEs fine and then crashes on every
-- call the moment execution reaches this statement — i.e. on EVERY invocation
-- that passes the auth / idempotency / period / empty-selection /
-- already-in-payment guards. Commission payment creation
-- (src/pages/CommissionPayments.tsx:224, src/pages/Reports.tsx:468) is
-- hard-broken live until this fix.
--
-- BASELINE (live, read 2026-06-10 via pg_get_functiondef + md5(prosrc)):
--   public.create_commission_payment(p_commission_ids uuid[],
--     p_payment_method text, p_reference text, p_payment_date date,
--     p_notes text, p_performed_by uuid DEFAULT NULL,
--     p_idempotency_key text DEFAULT NULL) RETURNS uuid
--   baseline md5(prosrc) = cf95b2a343d45dd39a417ad060d1e05e
--   SECURITY DEFINER; search_path=public, pg_temp; exactly 1 overload
--   live acl: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   (anon: no EXECUTE)
--
-- DESIGN — locking and dedup separated, with proof of equivalence:
--  * The DISTINCT was redundant FOR THE INTO: the query reads a single table
--    keyed by primary key (c.id = ANY(p_commission_ids) — commissions_pkey),
--    so duplicates exist only in the projected recipient_user_id column, and
--    a non-STRICT SELECT ... INTO consumes just the FIRST row either way.
--    Single-recipient correctness was never enforced by that DISTINCT — it is
--    enforced by the count(DISTINCT c.recipient_user_id) > 1 guard that
--    immediately follows (unchanged). Dropping DISTINCT from the INTO read is
--    observationally identical on every path (single recipient -> same value;
--    multi-recipient -> an arbitrary one of them, exactly as DISTINCT+INTO
--    behaved, then the >1 guard raises; zero rows -> NULL -> same error).
--  * The LOCKING INTENT (no double-pay of the same commission rows) is
--    preserved AND strengthened, two ways:
--    (1) Full-set lock. plpgsql SELECT ... INTO fetches only the first row,
--        so even a valid INTO ... FOR UPDATE would have locked at most one
--        row. The lock is now a standalone PERFORM 1 ... FOR UPDATE, which
--        drains the whole rowset and locks EVERY selected pending commission.
--    (2) Lock hoisted ABOVE the duplicate-payment check. commissions.status
--        stays 'pending' while a payment is unposted, and there is NO unique
--        index on commission_payment_items.commission_id (verified live), so
--        the already-in-payment lookup is the ONLY double-pay guard. The live
--        order was check-then-lock (the same TOCTOU shape fixed for
--        draw_down_quote in 20260610181726): two concurrent calls over the
--        same ids would both pass the check before either commits and both
--        create a payment. With the lock above the check, the loser blocks on
--        the winner's row locks; under READ COMMITTED its check then runs on
--        a fresh snapshot, sees the winner's committed payment items, and
--        raises 'already in an existing (non-voided) payment'.
--  * Happy path (one recipient, pending, unpaid commissions) is behaviour-
--    identical: same guards, same error texts, same inserts in the same
--    order, same return value, same audit row, same money handling
--    (commissions.commission_amount / commission_payments.total_amount are
--    numeric DOLLARS in the live schema; the audit row converts to cents via
--    (v_total * 100)::bigint exactly as the live body already did).
--
-- EXHAUSTIVE DELTA LIST (everything else is verbatim from the live body,
-- whitespace included; deltas are sentinel-delimited in the body and land in
-- prosrc for post-apply verification):
--   DELTA cpfu-1 — INSERTED statement: PERFORM 1 FROM commissions ... FOR
--     UPDATE over the selected pending rows, placed between the empty-
--     selection guard and the already-in-payment count.
--   DELTA cpfu-2 — MODIFIED statement: the recipient read loses DISTINCT and
--     FOR UPDATE; otherwise the same statement, now reading rows cpfu-1 has
--     already locked.
--   (no other change of any kind — signature, return type, grants, guards,
--    idempotency wiring, audit writes all untouched)
--
-- GRANTS: restated verbatim from the live acl and asserted in the DO block —
-- EXECUTE to authenticated + service_role; NOT anon/PUBLIC. In-body gates:
-- auth.uid() NOT NULL, strict-actor on p_performed_by, is_admin().
-- caller-analysis: create_commission_payment — live UI callers
--   src/pages/CommissionPayments.tsx:224 (idempotency-keyed) and
--   src/pages/Reports.tsx:468, both calling as authenticated; service_role
--   kept for ops/smoke harness. This migration does NOT change the grant
--   disposition — it restates the existing live grants after CREATE OR
--   REPLACE.
--
-- Reversible: re-apply the baseline body (md5 above) — though that restores
-- the 0A000 crash, so reverting is never desirable.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_commission_payment(p_commission_ids uuid[], p_payment_method text, p_reference text, p_payment_date date, p_notes text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor        uuid;
  v_existing     jsonb;
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
  v_already_in_payment integer;
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
    IF v_existing IS NOT NULL THEN RETURN (v_existing #>> '{}')::uuid; END IF;
  END IF;

  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  PERFORM check_period_open(v_payment_dt);

  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- [DELTA cpfu-1 BEGIN] full-set row lock, hoisted above the duplicate-
  -- payment check: PERFORM drains the rowset so EVERY selected pending
  -- commission row is locked (an INTO read fetches only the first row).
  -- Concurrent calls over the same ids serialize here, so the loser's check
  -- below runs against the winner's committed payment items.
  PERFORM 1
     FROM commissions c
    WHERE c.id = ANY(p_commission_ids)
      AND c.status = 'pending'
      FOR UPDATE;
  -- [DELTA cpfu-1 END]

  SELECT count(*) INTO v_already_in_payment
  FROM commission_payment_items cpi
  JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
  WHERE cpi.commission_id = ANY(p_commission_ids)
    AND cp.status != 'voided';

  IF v_already_in_payment > 0 THEN
    RAISE EXCEPTION 'One or more commissions are already in an existing (non-voided) payment. Void that payment first or remove those commissions from the selection.';
  END IF;

  -- [DELTA cpfu-2 BEGIN] was: a DISTINCT projection combined with a row lock
  -- in this one statement — rejected by PostgreSQL at plan time with SQLSTATE
  -- 0A000, crashing every call. The rows are already locked by cpfu-1 above;
  -- DISTINCT was redundant for a single-row INTO (rows are PK-selected, INTO
  -- consumes the first row, and the count(DISTINCT ...) guard below is what
  -- enforces the single-recipient rule).
  SELECT c.recipient_user_id
    INTO v_recipient_id
    FROM commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status = 'pending';
  -- [DELTA cpfu-2 END]

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No pending commissions found for the given IDs (commissions must be status=pending and not in any non-voided payment)';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status = 'pending') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  SELECT sum(c.commission_amount)
    INTO v_total
    FROM commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status = 'pending';

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

  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status = 'pending'
  LOOP
    INSERT INTO commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

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

-- Grants restated verbatim from the live acl (see caller-analysis above).
REVOKE EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count  int;
  v_src    text;
  v_secdef boolean;
  v_config text[];
  v_sig    constant text := 'public.create_commission_payment(uuid[],text,text,date,text,uuid,text)';
BEGIN
  -- exactly one overload
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

  -- SECDEF + search_path intact
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'create_commission_payment is no longer SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_config) cfg
    WHERE cfg LIKE 'search_path=%' AND cfg LIKE '%public%' AND cfg LIKE '%pg_temp%'
  ) THEN
    RAISE EXCEPTION 'create_commission_payment lost SET search_path = public, pg_temp';
  END IF;

  -- delta sentinel markers present in prosrc
  IF position('[DELTA cpfu-1 BEGIN]' IN v_src) = 0
     OR position('[DELTA cpfu-1 END]' IN v_src) = 0
     OR position('[DELTA cpfu-2 BEGIN]' IN v_src) = 0
     OR position('[DELTA cpfu-2 END]' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_commission_payment: delta sentinel markers missing from prosrc';
  END IF;

  -- the 0A000 shape is gone: no SELECT DISTINCT anywhere in the body
  IF position('SELECT DISTINCT' IN v_src) > 0 THEN
    RAISE EXCEPTION 'create_commission_payment: SELECT DISTINCT still present in body';
  END IF;

  -- the lock exists and sits ABOVE both the already-in-payment check and the
  -- recipient read (locking covers the rows every later statement reads)
  IF position('FOR UPDATE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'create_commission_payment: FOR UPDATE lock missing from body';
  END IF;
  IF position('FOR UPDATE' IN v_src) > position('commission_payment_items' IN v_src) THEN
    RAISE EXCEPTION 'create_commission_payment: lock is not above the already-in-payment check';
  END IF;
  IF position('FOR UPDATE' IN v_src) > position('[DELTA cpfu-2 BEGIN]' IN v_src) THEN
    RAISE EXCEPTION 'create_commission_payment: lock is not above the recipient read';
  END IF;

  -- grants asserted: authenticated + service_role yes, anon no
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'create_commission_payment: authenticated lost EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'create_commission_payment: service_role lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'create_commission_payment: anon must NOT have EXECUTE';
  END IF;

  -- if plpgsql_check is installed (20260610192229), the 0A000 finding must be
  -- gone (targeted match only — unrelated findings do not fail this block)
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check') THEN
    IF EXISTS (
      SELECT 1
      FROM plpgsql_check_function(v_sig::regprocedure) AS msg
      WHERE (msg ILIKE '%DISTINCT%' AND msg ILIKE '%FOR UPDATE%')
         OR msg LIKE '%0A000%'
    ) THEN
      RAISE EXCEPTION 'create_commission_payment: plpgsql_check still reports the FOR UPDATE/DISTINCT error';
    END IF;
  END IF;
END $$;

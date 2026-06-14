-- ============================================================================
-- void_payment: overpayment prepay-credit reversal guaranteed-miss fix
-- (2026-06-10, chip task_d53a1704 — found by the fin-* financial invariant
--  predicates; see docs/audits/2026-06-10-error-prevention-execution-log.md §4.2)
-- ----------------------------------------------------------------------------
-- THE BUG (production money bug, live-verified 2026-06-10):
--   allocate_payment creates an overpayment prepay credit with
--     source_type      = 'overpayment'
--     source_reference = 'From payment ' || COALESCE(p_reference_number,
--                                                    p_check_number,
--                                                    v_set_id::text)
--   (live body, md5 b29f09e5a04deedf49d7992937cbb215 — read-only evidence,
--    allocate_payment is NOT modified by this migration).
--   void_payment tries to reverse that credit by matching
--     source_reference = p_allocation_set_id::text
--   which can NEVER equal any value allocate_payment writes (even the
--   no-ref/no-check fallback is prefixed 'From payment '). Result: voiding a
--   payment that carried an overpayment leaves the prepay credit live and
--   customers.prepay_balance_cents inflated FOREVER — the customer can spend
--   money the business gave back. v_prepay_reversed silently reports 0.
--
--   SECONDARY DEFECT IN THE SAME LIVE BLOCK (folded into the same delta —
--   it is the very block being replaced, not a scope expansion): the live
--   code reads ONE credit's balance (LIMIT 1 FOR UPDATE) but then zeroes
--   EVERY matching row with an un-LIMITed UPDATE, crediting the customer
--   back only the first row's balance. If multiple credits ever matched,
--   balances would be destroyed without restoring the customer ledger.
--   The rewrite sums and reverses ALL matched live-balance credits.
--
-- WHY source_reference IS THE JOIN KEY (schema-verified 2026-06-10):
--   prepay_credits has NO allocation-set FK column — its full column list is
--   id, customer_id, season, original_amount_cents, balance_cents,
--   payment_method, reference_number, notes, created_by, created_at,
--   updated_at, source_type, source_reference, bucket_label. source_reference
--   (free text) is the ONLY link to the originating payment, so per the chip
--   instruction the fix matches BOTH formats that have ever been written:
--     (a) 'From payment ' || COALESCE(set.reference_number, set.check_number,
--         set.id::text)        — what allocate_payment writes today;
--     (b) p_allocation_set_id::text — the bare-uuid format the live
--         void_payment expected (kept so any historical credit keyed that
--         way is still reversible; a uuid string is globally unique so this
--         branch cannot over-match).
--   Branch (a) is narrowed by customer_id = v_set.customer_id AND
--   season = v_set.season: allocate_payment writes the credit and the
--   allocation set in the SAME transaction with the SAME v_current_season
--   and the same customer, so for every credit it ever created these are
--   exact invariants — they cost nothing and they stop a same-reference-
--   number credit of ANOTHER customer/season from being zeroed. If
--   v_set.season is NULL (defensive: column is nullable; allocate_payment
--   always populates it) the season narrowing is disabled rather than
--   guaranteeing a miss. balance_cents > 0 keeps already-spent credits
--   untouched (live semantic preserved).
--
-- DEACTIVATION CHECK (chip's second question, answered — NO fix needed):
--   invoice_line_allocations has NO is_active column (schema-verified); the
--   deactivation mechanism for the allocate_payment path is
--   allocation_sets.is_active = false, which the live body already sets, and
--   the invoice paid_amount_cents reversal loop already runs per-invoice.
--   ILA rows correctly remain as historical detail under an inactive set.
--
-- BASELINE (verbatim-from-live discipline):
--   void_payment(uuid, text, uuid, text)  prosrc md5
--     3af867fc9f1c187836d1127f77befadd   (read live 2026-06-10, overloads=1)
--   The body below is byte-identical to that baseline EXCEPT the two
--   sentinel-delimited D53A regions. Stripping both regions (sentinel lines
--   included) and re-inserting the REMOVED-BLOCK quoted below in place of
--   delta D53A-2 reconstructs the baseline exactly.
--
-- EXHAUSTIVE DELTA LIST:
--   D53A-1 (DECLARE, pure insertion): adds `v_credit record;` for the new
--          reversal loop. v_old_balance is now unused but is KEPT verbatim
--          to preserve the baseline DECLARE byte-for-byte.
--   D53A-2 (body, replacement): replaces the broken single-credit
--          bare-set-id reversal block with a locked loop over ALL matching
--          live-balance overpayment credits (both source_reference formats,
--          customer + season narrowed), summing into v_prepay_reversed and
--          restoring customers.prepay_balance_cents once (GREATEST clamp and
--          the exact customers UPDATE shape preserved from live).
--   There are NO other changes: signature, SECURITY DEFINER,
--   SET search_path, auth/role gate, idempotency block, invoice reversal
--   loop, allocation_sets deactivation, financial_audit_log insert,
--   idempotency_keys insert and return shape are all baseline-verbatim.
--
-- REMOVED BLOCK (live baseline text replaced by delta D53A-2, quoted for
-- review diffing; this is the ONLY baseline text not reproduced below):
--   SELECT balance_cents INTO v_old_balance
--   FROM prepay_credits
--   WHERE source_type = 'overpayment' AND source_reference = p_allocation_set_id::text AND balance_cents > 0
--   LIMIT 1 FOR UPDATE;
--
--   IF FOUND AND v_old_balance > 0 THEN
--     UPDATE prepay_credits
--     SET balance_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
--     WHERE source_type = 'overpayment' AND source_reference = p_allocation_set_id::text;
--     v_prepay_reversed := v_old_balance;
--     UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
--   END IF;
--
-- OUT-OF-SCOPE FINDINGS (enumerated, deliberately NOT fixed here — each
-- needs its own /ship; see the chip report's open_concerns):
--   * void_payment CRASHES when the voided payment had FULLY paid an
--     invoice: the loop flips status paid->posted, but the live
--     _enforce_invoice_status_transition trigger does not allow
--     paid->posted and void_payment carries no app.admin_override bracket —
--     the whole void aborts. (The smoke uses a partial allocation so the
--     prepay fix is testable without tripping this separate live bug.)
--   * Partial reversal of a fully-paid invoice leaves status='paid' with a
--     positive balance (the CASE only demotes when paid_amount reaches 0).
--   * The idempotency replay lookup is operation-unscoped (already queued in
--     the known 22-RPC sweep) and replays a generic result instead of the
--     original. Kept baseline-verbatim.
--   * Residual ambiguity: if the SAME customer reuses the SAME
--     reference/check number on two overpaid payments in the SAME season,
--     voiding one zeroes both credits — source_reference is the only link.
--     Recommend a prepay_credits.allocation_set_id column as the durable fix.
--   * Credits partially spent before the void only reverse their REMAINING
--     balance (live semantic preserved).
--
-- GRANTS (live-verified 2026-06-10): EXECUTE for authenticated +
-- service_role only (no anon, no PUBLIC) — restated and asserted below.
-- CREATE OR REPLACE preserves the ACL; the restatement is belt-and-braces.
--
-- Rolled-back smoke test: scripts/smoke/smoke-void_payment_prepay_reversal.sql
-- (register under void_payment in scripts/smoke/smoke-specs.json at apply).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_set              record;
  v_alloc            record;
  v_actor            uuid;
  v_reversed_cents   bigint := 0;
  v_invoice_count    int    := 0;
  v_prepay_reversed  bigint := 0;
  v_old_balance      bigint;
  -- D53A<<< new loop variable for the multi-credit reversal (task_d53a1704)
  v_credit           record;
  -- >>>D53A
  v_existing         jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'idempotent', true);
    END IF;
  END IF;

  SELECT * INTO v_set FROM allocation_sets WHERE id = p_allocation_set_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id; END IF;
  IF NOT v_set.is_active THEN RAISE EXCEPTION 'Payment already voided'; END IF;

  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) = 0
               AND status IN ('paid', 'posted') THEN 'posted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;
    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count  := v_invoice_count + 1;
  END LOOP;

  -- D53A<<< overpayment-credit reversal REWRITTEN (task_d53a1704; the
  -- replaced live block is quoted verbatim in the file header).
  -- allocate_payment writes source_reference = 'From payment ' ||
  -- COALESCE(reference_number, check_number, set_id::text); the live match
  -- on the bare set uuid could never hit it, stranding the overpayment in
  -- customers.prepay_balance_cents on every void. prepay_credits has no
  -- allocation-set FK column, so match BOTH historical source_reference
  -- formats; branch (a) is narrowed by customer + season (same-transaction
  -- invariants of allocate_payment), branch (b) is a globally-unique uuid
  -- string. Loop + per-row lock so MULTIPLE matching credits are summed and
  -- reversed consistently (the old code zeroed every match but credited the
  -- customer back only the first row's balance).
  FOR v_credit IN
    SELECT id, balance_cents
    FROM prepay_credits
    WHERE source_type = 'overpayment'
      AND customer_id = v_set.customer_id
      AND balance_cents > 0
      AND (
        (source_reference = 'From payment ' || COALESCE(v_set.reference_number, v_set.check_number, v_set.id::text)
         AND (v_set.season IS NULL OR season = v_set.season))
        OR source_reference = p_allocation_set_id::text
      )
    FOR UPDATE
  LOOP
    UPDATE prepay_credits
    SET balance_cents = 0, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now()
    WHERE id = v_credit.id;
    v_prepay_reversed := v_prepay_reversed + v_credit.balance_cents;
  END LOOP;

  IF v_prepay_reversed > 0 THEN
    UPDATE customers SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0) WHERE id = v_set.customer_id;
  END IF;
  -- >>>D53A

  UPDATE allocation_sets SET is_active = false, notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']', updated_at = now() WHERE id = p_allocation_set_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, old_values, new_values, total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id, v_actor,
    jsonb_build_object('total_payment_cents', v_set.total_payment_cents, 'total_allocated_cents', v_set.total_allocated_cents, 'payment_method', v_set.payment_method, 'check_number', v_set.check_number, 'customer_id', v_set.customer_id),
    jsonb_build_object('reason', p_reason, 'invoices_reversed', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'void_payment', to_jsonb(p_allocation_set_id));
  END IF;

  RETURN jsonb_build_object('success', true, 'allocation_set_id', p_allocation_set_id, 'reversed_cents', v_reversed_cents, 'invoices_affected', v_invoice_count, 'prepay_reversed_cents', v_prepay_reversed);
END;
$function$;

-- Grants restated exactly as live-verified (authenticated + service_role
-- only; owner postgres implicit). CREATE OR REPLACE preserved the ACL — this
-- is belt-and-braces against drift.
REVOKE EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count  int;
  v_src    text;
  v_secdef boolean;
  v_config text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'void_payment' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'void_payment overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc, prosecdef, array_to_string(proconfig, ';')
  INTO v_src, v_secdef, v_config
  FROM pg_proc WHERE proname = 'void_payment' AND pronamespace = 'public'::regnamespace;

  -- SECDEF + search_path retained
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'void_payment lost SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR v_config NOT LIKE '%search_path=public, pg_temp%' THEN
    RAISE EXCEPTION 'void_payment lost SET search_path (proconfig = %)', v_config;
  END IF;

  -- Delta sentinels present in the deployed body
  IF v_src NOT LIKE '%-- D53A<<<%' OR v_src NOT LIKE '%-- >>>D53A%' THEN
    RAISE EXCEPTION 'void_payment missing D53A delta sentinels';
  END IF;

  -- New matching logic present: allocate_payment format + legacy bare-set-id
  IF v_src NOT LIKE '%''From payment '' || COALESCE(v_set.reference_number, v_set.check_number, v_set.id::text)%' THEN
    RAISE EXCEPTION 'void_payment missing the allocate_payment source_reference match';
  END IF;
  IF v_src NOT LIKE '%OR source_reference = p_allocation_set_id::text%' THEN
    RAISE EXCEPTION 'void_payment missing the legacy bare-set-id source_reference match';
  END IF;

  -- Broken live block gone
  IF v_src LIKE '%LIMIT 1 FOR UPDATE%' THEN
    RAISE EXCEPTION 'void_payment still contains the broken LIMIT 1 single-credit read';
  END IF;
  IF v_src LIKE '%source_reference = p_allocation_set_id::text AND balance_cents > 0%' THEN
    RAISE EXCEPTION 'void_payment still contains the broken bare-set-id-only predicate';
  END IF;

  -- Grants exactly as restated
  IF NOT has_function_privilege('authenticated', 'public.void_payment(uuid, text, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on void_payment';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.void_payment(uuid, text, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on void_payment';
  END IF;
  IF has_function_privilege('anon', 'public.void_payment(uuid, text, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on void_payment';
  END IF;
END $verify$;

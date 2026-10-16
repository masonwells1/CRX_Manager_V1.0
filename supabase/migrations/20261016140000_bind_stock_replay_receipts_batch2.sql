-- Written 2026-10-16. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: batch 2 of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md, "about 75 live
--   functions replay a saved result matched on the retry key alone"). This is the HIGH stock group
--   (the table row the inventory labels batch 3; it is the second batch to ship). Thirteen stock
--   RPCs replay a stored receipt matched on the retry key alone, so a retry that reuses a key for a
--   DIFFERENT record or payload gets the first call's "done" answer and the new record is never
--   touched (a false success; nothing is ever done twice):
--     release_inventory_hold, retire_inventory_item, reconcile_negative_inventory,
--     manual_inventory_add, create_order_from_blend_ticket, create_direct_order, create_rush_order,
--     close_quote_as_applied, close_quote_as_short, create_application_record_from_blend_ticket,
--     batch_cancel_deliveries, reverse_completed_cycle_count, create_planned_holds.
--
--   The fix is batch 1's pattern (20261016060000), reusing its live helpers: each live body is
--   RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it), and a public wrapper
--   with the identical signature, defaults, return type, owner, search_path and grants takes its
--   place. create_application_record_from_blend_ticket's renamed body is
--   _create_app_record_from_bt_replay_impl_20261015 (the long form exceeds PostgreSQL's 63-byte
--   name limit), after the operation name its receipts already use. With a key, the wrapper
--     1. requires auth.uid() and refuses a p_performed_by (p_reversed_by) naming someone else, with
--        the same test and the same message its renamed body uses (strict where the body is strict:
--        create_order_from_blend_ticket and create_application_record_from_blend_ticket refuse a
--        NULL actor too);
--     2. computes a SHA-256 fingerprint of the actor, the target id(s) and every other argument;
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>). No receipt: run the body. Exact actor + intent
--        match: run the body, which replays its own stored answer exactly as before. Anything else
--        is refused with IDEMPOTENCY_ACTOR_MISMATCH or IDEMPOTENCY_INTENT_MISMATCH, which the app
--        maps to plain English (src/lib/idempotency.ts getIdempotencyBindingRejection,
--        src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id and request_fingerprint onto the receipt the body
--        just wrote (_bind_replay_receipt_20261015), and refuses (rolls the call back) if the body
--        wrote none. Four bodies answer a no-op WITHOUT writing a receipt, before any write, and the
--        wrapper returns those answers unbound instead of refusing them:
--          release_inventory_hold           {status: already_released}
--          close_quote_as_applied / _short  {already_closed: true}
--          create_order_from_blend_ticket   {success: false, error: ...} (every such return precedes
--                                           the order insert)
--        A retry of one of them simply gets the same no-op answer again.
--   A key is REQUIRED (IDEMPOTENCY_KEY_REQUIRED, 22023), as in batch 1: a keyless call would run with
--   no receipt, so a lost-response retry could repeat the stock action. Every app call site already
--   sends one. The one internal keyless caller, revert_quote_status (already bound, body pinned
--   below), rebuilds a reopened planned quote's holds; it now calls the private renamed body
--   _create_planned_holds_replay_impl_20261015 directly instead of the public name (its live body is
--   recreated below with that call retargeted and a required-key check added, md5 pinned before and
--   after), so no public entry point accepts a keyless call (CodeRabbit on PR #951).
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key, so a key has at most one row, and
--   check_idempotency_intent has already refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row
--   is this operation's, under the lock.
--
--   Two more pieces:
--   * COMMIT-TIME GUARD: batch 1's deferred constraint trigger require_bound_replay_receipt_20261015
--     now also covers the thirteen operations (create_app_record_from_bt for the application-record
--     RPC). A trigger's WHEN clause cannot be altered, so the trigger is dropped and recreated with
--     the same name, function, timing and the batch-1 nine plus these thirteen, inside this
--     transaction under its ACCESS EXCLUSIVE lock on idempotency_keys (no gap is visible). No second
--     trigger is created.
--   * _reverse_completed_cycle_count_impl loses its leftover service_role EXECUTE (it has a key-only
--     replay of its own, below the wrapper; its only caller is the renamed body).
--
-- WHAT DOES NOT CHANGE: no stock or order logic is retyped (the bodies are renamed, pinned by md5
--   below; revert_quote_status is recreated from its pinned live body with one call retargeted and a key required); no
--   table, row, policy or receipt changes; every keyed legitimate call (first call, exact retry)
--   returns what it returns today. A keyless call is now refused (IDEMPOTENCY_KEY_REQUIRED) by all
--   thirteen. revert_quote_status behaves exactly as before (same checks, same receipts); only its
--   planned-holds call now targets the private body. Checks that now run before the renamed bodies:
--   the key requirement, the auth/actor test (same messages), and the actor/intent binding. The
--   body's role test still runs inside the renamed body; the binding refuses a mismatch before it,
--   which reveals nothing a caller did not send (the stored result is disclosed only to the same
--   actor).
--
-- RECEIPT DISCLOSURE: as batch 1. The preflight refuses to apply while any unexpired receipt exists
--   for the thirteen operations (none existed when read live on 2026-10-16) and the commit-time guard
--   keeps an unbound one from ever committing.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the renamed bodies and _reverse_completed_cycle_count_impl
--   lose EXECUTE, and a keyless create_planned_holds from the browser is now refused. It widens
--   nothing.
--
-- NOT IN THIS BATCH: the inventory's other unbound groups (complete_delivery/void_order/... and the
--   MED/LOW group). batch_cancel_deliveries calls cancel_delivery (not yet bound) per delivery with
--   no key, under its own bound key; whichever batch binds cancel_delivery must keep that keyless
--   internal call working (batch 1's marker pattern).
--
-- OVERLOADS: each of the thirteen has exactly one overload (read-only on live 2026-10-16); the
--   preflight refuses a second one and the postflight proves exactly one wrapper and one body per
--   name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST recreate
--   require_bound_replay_receipt_20261015 with the batch-1 nine only (left covering these thirteen,
--   it would refuse every receipt the restored old bodies write); then, for each name, DROP the
--   wrapper, ALTER FUNCTION public.<impl>(...) RENAME TO <name>, and restore its grants (EXECUTE to
--   authenticated, service_role); restore revert_quote_status's previous body (it calls the public
--   create_planned_holds again, so restore that wrapper's keyless path first or keep this one);
--   re-grant EXECUTE on _reverse_completed_cycle_count_impl to service_role if wanted.
--   Batch 1's helpers stay (batch 1 still uses them).
--
-- ORDERING: strict. Live high-water when written: 20261016060000 (PR #942, replay-binding batch 1,
--   ledger 20261016121253). Re-read the live ledger before applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, (b)
-- the routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to authenticated
-- and service_role, which is exactly the live ACL of the function it replaces, or (c)
-- _reverse_completed_cycle_count_impl's service_role EXECUTE. The app keeps calling the same name
-- with the same arguments and reaches the wrapper:
-- caller-analysis: release_inventory_hold :: src/pages/InventoryPage.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: retire_inventory_item :: src/pages/InventoryPage.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: reconcile_negative_inventory :: src/components/integrity/IntegrityCleanupPanel.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: manual_inventory_add :: src/pages/InventoryPage.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_order_from_blend_ticket :: src/pages/BlendTicketDetail.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_direct_order :: src/pages/NewOrder.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_rush_order :: src/pages/NewOrder.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: close_quote_as_applied :: src/pages/QuoteBuilder.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: close_quote_as_short :: src/pages/QuoteBuilder.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_application_record_from_blend_ticket :: src/pages/BlendTicketDetail.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: batch_cancel_deliveries :: src/pages/Deliveries.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: reverse_completed_cycle_count :: src/pages/CycleCounts.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: create_planned_holds :: src/pages/QuoteBuilder.tsx calls the same name and signature with a key; revert_quote_status now calls the private renamed body directly; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: revert_quote_status :: recreated in place (CREATE OR REPLACE keeps its EXECUTE grants and COMMENT); src/pages/QuoteBuilder.tsx calls the same name and signature
-- caller-analysis: _reverse_completed_cycle_count_impl :: no UI or Edge Function caller; its only caller is the renamed reverse_completed_cycle_count body, a postgres-owned definer function, which keeps calling it

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE stock_replay_binding_batch2_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.stock_replay_binding_batch2_tx') IS NULL THEN
    RAISE EXCEPTION 'STOCK_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.stock_replay_binding_batch2_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'STOCK_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The thirteen bodies, exactly as reviewed live on 2026-10-16 (md5 ignores carriage returns), each
  -- the only overload of its name, with the live owner, attributes and grants, and no renamed copy.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM (VALUES
      ('release_inventory_hold', '_release_inventory_hold_replay_impl_20261015', 'p_hold_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '7ba73d49affa67b73c6eff7a9fcc421a'),
      ('retire_inventory_item', '_retire_inventory_item_replay_impl_20261015', 'p_inventory_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'e3a007fd59454bcc53c879c391ae6c3c'),
      ('reconcile_negative_inventory', '_reconcile_negative_inventory_replay_impl_20261015', 'p_inventory_id uuid, p_new_quantity numeric, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'f74d57e251dba616fa18376f6c65955a'),
      ('manual_inventory_add', '_manual_inventory_add_replay_impl_20261015', 'p_product_id uuid, p_location text, p_quantity numeric, p_unit_size text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_unit_cost numeric DEFAULT NULL::numeric, p_idempotency_key text DEFAULT NULL::text, p_reorder_point numeric DEFAULT NULL::numeric, p_min_stock_level numeric DEFAULT NULL::numeric', 'jsonb', 'e54402d968bd94924857f1ff69827d46'),
      ('create_order_from_blend_ticket', '_create_order_from_blend_ticket_replay_impl_20261015', 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text', 'json', '344532c6522cce26857ce4ffd9597125'),
      ('create_direct_order', '_create_direct_order_replay_impl_20261015', 'p_customer_id uuid, p_order_date date, p_order_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT ''[]''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text', 'jsonb', 'f18495ee041dafa152e736ce93c0452f'),
      ('create_rush_order', '_create_rush_order_replay_impl_20261015', 'p_customer_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '9027a97ab42a109f5e81188736f52f9c'),
      ('close_quote_as_applied', '_close_quote_as_applied_replay_impl_20261015', 'p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '4d702d353d66f801e745c4d13ecbba24'),
      ('close_quote_as_short', '_close_quote_as_short_replay_impl_20261015', 'p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '0c2274bd3478635c5fc7ec38bcf46230'),
      ('create_application_record_from_blend_ticket', '_create_app_record_from_bt_replay_impl_20261015', 'p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid[]', '0ad9a78b900cb953e0aa7d2a0d87bda0'),
      ('batch_cancel_deliveries', '_batch_cancel_deliveries_replay_impl_20261015', 'p_delivery_ids uuid[], p_cancel_reason text DEFAULT ''Batch cancelled''::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'integer', '25d34db60f098a22a62db53780742eee'),
      ('reverse_completed_cycle_count', '_reverse_completed_cycle_count_replay_impl_20261015', 'p_cycle_count_id uuid, p_reversed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'void', '76ac5389d5541ab4a7b3a96388165c5b'),
      ('create_planned_holds', '_create_planned_holds_replay_impl_20261015', 'p_quote_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '810d772cbd0b5669fd22412067b9ddaa')
    ) AS pin(name, impl, args, ret, body_md5)
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = pin.name
           AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
           AND NOT p.proisstrict AND NOT p.proretset AND p.prokind = 'f'
           AND p.prorettype = pin.ret::regtype
           AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
           AND pg_get_function_arguments(p.oid) = pin.args
           AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
           AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
               IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = pin.impl);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_STOCK_REPLAY_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), the two
  -- binding columns, auth.uid(), and batch 1's live helpers and guard (pinned).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'check_idempotency_intent') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'check_idempotency_intent'
          AND pg_get_function_identity_arguments(p.oid) = 'p_key text, p_operation text, p_actor uuid, p_fingerprint text'
          AND md5(replace(p.prosrc, chr(13), '')) = 'edc73be809069669e8441eba7acf443d') THEN
    RAISE EXCEPTION 'PREFLIGHT_INTENT_CHECK_DRIFT: check_idempotency_intent differs from its reviewed body';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.idempotency_keys'::regclass AND NOT a.attisdropped
         AND ((a.attname = 'request_actor_id' AND a.atttypid = 'uuid'::regtype)
           OR (a.attname = 'request_fingerprint' AND a.atttypid = 'text'::regtype))) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_COLUMNS_DRIFT: idempotency_keys.request_actor_id (uuid) and request_fingerprint (text) are required';
  END IF;
  -- auth.uid() is the actor every wrapper binds to: pin its live body (read 2026-10-16), not just
  -- its existence (Luna round 1).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('auth.uid()')
       AND NOT p.prosecdef
       AND md5(replace(p.prosrc, chr(13), '')) = 'cdef18c69c4f4cbbced2eaf81e628b49') THEN
    RAISE EXCEPTION 'PREFLIGHT_AUTH_UID_DRIFT: auth.uid() is missing or differs from its reviewed live body';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf', false),
      ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73', false),
      ('public._require_bound_replay_receipt_20261015()', '5c0478525131ddbeb7b96ef1535ff91e', true)
    ) AS h(sig, body_md5, secdef)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure(h.sig)
          AND p.proowner = 'postgres'::regrole AND p.prosecdef = h.secdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = h.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[])
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_BATCH1_HELPER_DRIFT: the batch-1 replay-binding helpers differ from their reviewed live bodies or ACLs';
  END IF;
  -- Batch 1's guard trigger, exactly as installed (its covered list is the nine batch-1 operations).
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.idempotency_keys'::regclass
         AND t.tgname = 'require_bound_replay_receipt_20261015'
         AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
         AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND pg_get_triggerdef(t.oid) = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY[''void_payment''::text, ''delete_prepay_credit''::text, ''edit_prepay_credit''::text, ''apply_write_off''::text, ''reverse_write_off''::text, ''apply_prepay_to_invoice''::text, ''create_prepay_check_splits''::text, ''batch_apply_prepayments''::text, ''batch_void_invoices''::text]))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()'
     ) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: require_bound_replay_receipt_20261015 differs from the batch-1 trigger';
  END IF;
  -- The one keyless internal caller of create_planned_holds (wrapped below, so pinned like the
  -- thirteen), and the private impl this file narrows.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'revert_quote_status') <> 1
     OR NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'revert_quote_status'
       AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
       AND NOT p.proisstrict AND NOT p.proretset AND p.prokind = 'f'
       AND p.prorettype = 'jsonb'::regtype
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND pg_get_function_arguments(p.oid) = 'p_quote_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'
       AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
       AND md5(replace(p.prosrc, chr(13), '')) = 'fb0cc5def3766270b13c401810b61f3e') THEN
    RAISE EXCEPTION 'PREFLIGHT_REVERT_QUOTE_STATUS_DRIFT: revert_quote_status differs from its reviewed body (it calls create_planned_holds with a NULL key)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_reverse_completed_cycle_count_impl'
       AND pg_get_function_identity_arguments(p.oid) = 'p_cycle_count_id uuid, p_reversed_by uuid, p_idempotency_key text'
       AND md5(replace(p.prosrc, chr(13), '')) = 'e73e7c0d020fd9645ce19d4d9fe1ca13'
       AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres', 'service_role']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_REVERSE_CYCLE_COUNT_IMPL_DRIFT: _reverse_completed_cycle_count_impl differs from its reviewed body or ACL';
  END IF;
  -- Cutover: a receipt written by an old body carries no binding, and the intent check refuses it.
  -- So apply only while no unexpired receipt exists for the thirteen operations; this transaction's
  -- ACCESS EXCLUSIVE lock keeps a new one from appearing before the guard covers them.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN ('release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory', 'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order', 'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short', 'create_app_record_from_bt', 'batch_cancel_deliveries', 'reverse_completed_cycle_count', 'create_planned_holds')
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired receipt exists for one of the thirteen operations; wait for it to expire (24 hours) and apply again';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- The commit-time guard now covers the thirteen operations too (same trigger, same function).
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER require_bound_replay_receipt_20261015 ON public.idempotency_keys;
CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015
  AFTER INSERT OR UPDATE ON public.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.operation IN (
    -- batch 1 (20261016060000)
    'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off', 'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits', 'batch_apply_prepayments', 'batch_void_invoices',
    -- batch 2 (this file)
    'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory', 'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order', 'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short', 'create_app_record_from_bt', 'batch_cancel_deliveries', 'reverse_completed_cycle_count', 'create_planned_holds'))
  EXECUTE FUNCTION public._require_bound_replay_receipt_20261015();

-- ---------------------------------------------------------------------------------------------
-- 1. release_inventory_hold
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.release_inventory_hold(uuid, uuid, text) RENAME TO _release_inventory_hold_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._release_inventory_hold_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.release_inventory_hold(
  p_hold_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: release_inventory_hold requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'hold_id', p_hold_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'release_inventory_hold', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._release_inventory_hold_replay_impl_20261015(p_hold_id, p_performed_by, p_idempotency_key);
  -- An already-released hold is answered before any write, with no receipt: nothing to bind.
  IF v_replay IS NULL AND v_result ->> 'status' IS DISTINCT FROM 'already_released' THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'release_inventory_hold', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.release_inventory_hold(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_inventory_hold(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. retire_inventory_item
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.retire_inventory_item(uuid, uuid, text) RENAME TO _retire_inventory_item_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._retire_inventory_item_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.retire_inventory_item(
  p_inventory_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: retire_inventory_item requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The renamed body's own messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'inventory_id', p_inventory_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'retire_inventory_item', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._retire_inventory_item_replay_impl_20261015(p_inventory_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'retire_inventory_item', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.retire_inventory_item(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retire_inventory_item(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. reconcile_negative_inventory
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.reconcile_negative_inventory(uuid, numeric, text, uuid, text) RENAME TO _reconcile_negative_inventory_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reconcile_negative_inventory_replay_impl_20261015(uuid, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reconcile_negative_inventory(
  p_inventory_id uuid,
  p_new_quantity numeric,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reconcile_negative_inventory requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- The renamed body's own messages.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'inventory_id', p_inventory_id,
    'new_quantity', p_new_quantity,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reconcile_negative_inventory', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._reconcile_negative_inventory_replay_impl_20261015(p_inventory_id, p_new_quantity, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reconcile_negative_inventory', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.reconcile_negative_inventory(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_negative_inventory(uuid, numeric, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. manual_inventory_add
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) RENAME TO _manual_inventory_add_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._manual_inventory_add_replay_impl_20261015(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.manual_inventory_add(
  p_product_id uuid,
  p_location text,
  p_quantity numeric,
  p_unit_size text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_unit_cost numeric DEFAULT NULL::numeric,
  p_idempotency_key text DEFAULT NULL::text,
  p_reorder_point numeric DEFAULT NULL::numeric,
  p_min_stock_level numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: manual_inventory_add requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'location', p_location,
    'quantity', p_quantity,
    'unit_size', p_unit_size,
    'notes', p_notes,
    'unit_cost', p_unit_cost,
    'reorder_point', p_reorder_point,
    'min_stock_level', p_min_stock_level
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'manual_inventory_add', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._manual_inventory_add_replay_impl_20261015(p_product_id, p_location, p_quantity, p_unit_size, p_performed_by, p_notes, p_unit_cost, p_idempotency_key, p_reorder_point, p_min_stock_level);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'manual_inventory_add', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text, numeric, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. create_order_from_blend_ticket (returns json, not jsonb; strict actor)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text) RENAME TO _create_order_from_blend_ticket_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_order_from_blend_ticket_replay_impl_20261015(uuid, text, date, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_order_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_order_number text,
  p_order_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT auth.uid(),
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result json;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_order_from_blend_ticket requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same strictness as the renamed body: the caller must name itself (NULL refused).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'blend_ticket_id', p_blend_ticket_id,
    'order_number', p_order_number,
    'order_date', p_order_date,
    'notes', p_notes
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_order_from_blend_ticket', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_order_from_blend_ticket_replay_impl_20261015(p_blend_ticket_id, p_order_number, p_order_date, p_notes, p_performed_by, p_idempotency_key);
  -- A {success: false} answer is returned before the order insert, with no receipt: nothing to bind.
  IF v_replay IS NULL AND (v_result::jsonb -> 'success') IS DISTINCT FROM 'false'::jsonb THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_order_from_blend_ticket', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. create_direct_order (the renamed body still opens the below-cost write and delegates to
--    _create_direct_order_below_cost_impl_20260810)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) RENAME TO _create_direct_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_direct_order_replay_impl_20261015(uuid, date, text, text, jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_direct_order(
  p_customer_id uuid,
  p_order_date date,
  p_order_name text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_customer_po_number text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_direct_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- p_items is fingerprinted as sent: a reordered line list is a different request. p_notes carries
  -- any below-cost approval note, so a retry adding one is a different request too (the refused
  -- attempt it follows wrote no receipt).
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'customer_id', p_customer_id,
    'order_date', p_order_date,
    'order_name', p_order_name,
    'notes', p_notes,
    'items', p_items,
    'customer_po_number', p_customer_po_number
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_direct_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_direct_order_replay_impl_20261015(p_customer_id, p_order_date, p_order_name, p_notes, p_items, p_performed_by, p_idempotency_key, p_customer_po_number);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_direct_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_direct_order(uuid, date, text, text, jsonb, uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. create_rush_order (the renamed body still opens the below-cost write and delegates to
--    _create_rush_order_below_cost_impl_20260810)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_rush_order(uuid, jsonb, text, text, uuid, text) RENAME TO _create_rush_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_rush_order_replay_impl_20261015(uuid, jsonb, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_rush_order(
  p_customer_id uuid,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_notes text DEFAULT NULL::text,
  p_customer_po_number text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_rush_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- p_items is fingerprinted as sent (it also carries any below-cost approval reason).
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'customer_id', p_customer_id,
    'items', p_items,
    'notes', p_notes,
    'customer_po_number', p_customer_po_number
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_rush_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_rush_order_replay_impl_20261015(p_customer_id, p_items, p_notes, p_customer_po_number, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_rush_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_rush_order(uuid, jsonb, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_rush_order(uuid, jsonb, text, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. close_quote_as_applied
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.close_quote_as_applied(uuid, uuid, text) RENAME TO _close_quote_as_applied_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._close_quote_as_applied_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.close_quote_as_applied(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: close_quote_as_applied requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'quote_id', p_quote_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_quote_as_applied', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._close_quote_as_applied_replay_impl_20261015(p_quote_id, p_performed_by, p_idempotency_key);
  -- An already-closed booking is answered before any write, with no receipt: nothing to bind.
  IF v_replay IS NULL AND (v_result -> 'already_closed') IS DISTINCT FROM 'true'::jsonb THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'close_quote_as_applied', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.close_quote_as_applied(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_quote_as_applied(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. close_quote_as_short
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.close_quote_as_short(uuid, uuid, text) RENAME TO _close_quote_as_short_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._close_quote_as_short_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.close_quote_as_short(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: close_quote_as_short requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'quote_id', p_quote_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'close_quote_as_short', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._close_quote_as_short_replay_impl_20261015(p_quote_id, p_performed_by, p_idempotency_key);
  -- An already-closed booking is answered before any write, with no receipt: nothing to bind.
  IF v_replay IS NULL AND (v_result -> 'already_closed') IS DISTINCT FROM 'true'::jsonb THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'close_quote_as_short', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.close_quote_as_short(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_quote_as_short(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. create_application_record_from_blend_ticket (receipts use operation 'create_app_record_from_bt';
--     strict actor; returns uuid[])
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_application_record_from_blend_ticket(uuid, uuid, text) RENAME TO _create_app_record_from_bt_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_app_record_from_bt_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_application_record_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result uuid[];
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_application_record_from_blend_ticket requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same strictness as the renamed body: the caller must name itself (NULL refused).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'blend_ticket_id', p_blend_ticket_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_app_record_from_bt', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'array' THEN
    -- The body stores to_jsonb(<record id array>), a JSON array.
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_app_record_from_bt_replay_impl_20261015(p_blend_ticket_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_app_record_from_bt', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_application_record_from_blend_ticket(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_application_record_from_blend_ticket(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 11. batch_cancel_deliveries (its renamed body still cancels each delivery through cancel_delivery,
--     with no key, under this bound key)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.batch_cancel_deliveries(uuid[], text, uuid, text) RENAME TO _batch_cancel_deliveries_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_cancel_deliveries_replay_impl_20261015(uuid[], text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.batch_cancel_deliveries(
  p_delivery_ids uuid[],
  p_cancel_reason text DEFAULT 'Batch cancelled'::text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result integer;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_cancel_deliveries requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- The body treats the ids as a set (WHERE id = ANY), so the fingerprint does too.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_ids', to_jsonb(ARRAY(SELECT DISTINCT u.id FROM unnest(p_delivery_ids) AS u(id) ORDER BY u.id)),
    'cancel_reason', p_cancel_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_cancel_deliveries', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._batch_cancel_deliveries_replay_impl_20261015(p_delivery_ids, p_cancel_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_cancel_deliveries', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_cancel_deliveries(uuid[], text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_cancel_deliveries(uuid[], text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 12. reverse_completed_cycle_count (returns void; the receipt '{}' is written by
--     _reverse_completed_cycle_count_impl, which the renamed body calls)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) RENAME TO _reverse_completed_cycle_count_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reverse_completed_cycle_count_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reverse_completed_cycle_count(
  p_cycle_count_id uuid,
  p_reversed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reverse_completed_cycle_count requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_reversed_by IS NOT NULL AND p_reversed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'cycle_count_id', p_cycle_count_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reverse_completed_cycle_count', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  PERFORM public._reverse_completed_cycle_count_replay_impl_20261015(p_cycle_count_id, p_reversed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reverse_completed_cycle_count', v_fingerprint);
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._reverse_completed_cycle_count_impl(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 13. create_planned_holds
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_planned_holds(uuid, uuid, text) RENAME TO _create_planned_holds_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_planned_holds_replay_impl_20261015(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_planned_holds(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_planned_holds requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'quote_id', p_quote_id
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_planned_holds', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'string' THEN
    -- The body stores to_jsonb(<quote uuid>), a JSON string.
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_planned_holds_replay_impl_20261015(p_quote_id, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_planned_holds', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_planned_holds(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_planned_holds(uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 14. revert_quote_status: its live body (pinned above) with two changes: its rebuild of a reopened
--     planned quote's holds calls the private body instead of the public wrapper (which now requires a
--     key), and a keyless call is refused (IDEMPOTENCY_KEY_REQUIRED) before anything else. CREATE OR
--     REPLACE keeps its grants and COMMENT.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revert_quote_status(p_quote_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor              uuid;
  v_quote              record;
  v_existing           jsonb;
  v_existing_operation text;
  v_result             jsonb;
  v_reason             text;
  v_request            jsonb;
  v_fingerprint        text;
  v_contract CONSTANT text := 'revert_quote_status_v1';
BEGIN
  -- A key is required (20261016140000): every caller sends one, and a keyless call would skip the
  -- replay binding below and reach the quote and audit writes.
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: revert_quote_status requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to revert quote status';
  END IF;
  v_reason := btrim(p_reason);

  IF p_idempotency_key IS NOT NULL THEN
    IF btrim(p_idempotency_key) = '' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
    END IF;

    v_request := jsonb_build_object(
      'contract_version', v_contract,
      'quote_id', p_quote_id,
      'actor_id', v_actor,
      'reason', v_reason
    );
    v_fingerprint := md5(v_request::text);

    PERFORM pg_advisory_xact_lock(
      hashtextextended('crx:idempotency:revert_quote_status:' || p_idempotency_key, 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
    );

    DELETE FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND expires_at < now();

    SELECT operation, result
      INTO v_existing_operation, v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      IF v_existing_operation IS DISTINCT FROM 'revert_quote_status' THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation revert_quote_status',
          p_idempotency_key, v_existing_operation;
      END IF;
      IF v_existing->>'_contract' IS DISTINCT FROM v_contract
         OR NOT (v_existing ? 'request_fingerprint') THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_UNBOUND_REPLAY: key % has no revert_quote_status_v1 request binding; use a new key',
          p_idempotency_key;
      END IF;
      IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_REQUEST_MISMATCH: key % was already used with different revert_quote_status arguments',
          p_idempotency_key;
      END IF;
      IF NOT (v_existing ? 'response') OR v_existing->'response' = 'null'::jsonb THEN
        RAISE EXCEPTION
          'IDEMPOTENCY_INCOMPLETE_REPLAY: key % has no completed revert_quote_status response',
          p_idempotency_key;
      END IF;
      RETURN v_existing->'response';
    END IF;

    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (
      p_idempotency_key,
      'revert_quote_status',
      jsonb_build_object(
        '_contract', v_contract,
        'request_fingerprint', v_fingerprint,
        'request', v_request,
        'response', NULL
      ),
      now() + interval '24 hours'
    );
  END IF;

  SELECT * INTO v_quote
    FROM quotes
   WHERE id = p_quote_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'accepted') THEN
    RAISE EXCEPTION 'Cannot revert quote in status "%" — only declined, expired, cancelled, or accepted quotes can be reverted', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    -- DEADLOCK FIX: keep the quote-first contract shared with conversion, but
    -- never wait on an order that cancel_order may hold while it waits here.
    -- A serialization_failure is safe to retry; the whole idempotency claim and
    -- every earlier action roll back with this transaction.
    BEGIN
      PERFORM 1
        FROM orders
       WHERE quote_id = p_quote_id
       ORDER BY id
       FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION
        'QUOTE_REOPEN_CONCURRENT_ORDER_CHANGE_RETRY: an order from quote % is changing; retry after the cancellation finishes',
        v_quote.quote_number
        USING ERRCODE = '40001';
    END;

    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'Cannot revert accepted quote % — an active (non-cancelled) order exists from it', v_quote.quote_number;
    END IF;

    IF EXISTS (
         SELECT 1
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND COALESCE(oi.quantity_delivered, 0) > 0
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN deliveries d ON d.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND d.status = 'completed'
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN invoices i ON i.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND i.deleted_at IS NULL
            AND i.status NOT IN ('voided', 'cancelled')
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN commissions c ON c.order_id = o.id
          WHERE o.quote_id = p_quote_id
            AND c.status = 'paid'
       )
       OR EXISTS (
         SELECT 1
           FROM orders o
           JOIN commissions c ON c.order_id = o.id
           JOIN commission_payment_items cpi ON cpi.commission_id = c.id
           JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
          WHERE o.quote_id = p_quote_id
            AND cp.status <> 'voided'
       ) THEN
      RAISE EXCEPTION 'QUOTE_REOPEN_HAS_ORDER_HISTORY: quote % has delivered, invoiced, or paid/batched commission history; create a new quote/order instead of re-converting it', v_quote.quote_number;
    END IF;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  IF v_quote.status = 'accepted' THEN
    UPDATE quote_product_draws
       SET quantity_drawn = 0, updated_at = now()
     WHERE quote_id = p_quote_id AND quantity_drawn <> 0;
  END IF;

  IF v_quote.is_planned THEN
    PERFORM public._create_planned_holds_replay_impl_20261015(p_quote_id, v_actor, NULL);
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'quote_status_reverted', 'quote', p_quote_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_quote.status),
    jsonb_build_object('status', 'sent'),
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || v_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_status_reverted',
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || v_reason,
    v_actor, 'quote', p_quote_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'quote_id',      p_quote_id,
    'quote_number',  v_quote.quote_number,
    'old_status',    v_quote.status,
    'new_status',    'sent'
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE idempotency_keys
       SET result = jsonb_build_object(
             '_contract', v_contract,
             'request_fingerprint', v_fingerprint,
             'request', v_request,
             'response', v_result
           ),
           expires_at = now() + interval '24 hours'
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'revert_quote_status';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CLAIM_LOST: revert_quote_status key % disappeared', p_idempotency_key;
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.stock_replay_binding_batch2_tx') IS NULL THEN
    RAISE EXCEPTION 'STOCK_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.stock_replay_binding_batch2_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'STOCK_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM (VALUES
      ('release_inventory_hold', 'release_inventory_hold', '_release_inventory_hold_replay_impl_20261015', 'p_hold_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '7ba73d49affa67b73c6eff7a9fcc421a', true),
      ('retire_inventory_item', 'retire_inventory_item', '_retire_inventory_item_replay_impl_20261015', 'p_inventory_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'e3a007fd59454bcc53c879c391ae6c3c', true),
      ('reconcile_negative_inventory', 'reconcile_negative_inventory', '_reconcile_negative_inventory_replay_impl_20261015', 'p_inventory_id uuid, p_new_quantity numeric, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'f74d57e251dba616fa18376f6c65955a', true),
      ('manual_inventory_add', 'manual_inventory_add', '_manual_inventory_add_replay_impl_20261015', 'p_product_id uuid, p_location text, p_quantity numeric, p_unit_size text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_unit_cost numeric DEFAULT NULL::numeric, p_idempotency_key text DEFAULT NULL::text, p_reorder_point numeric DEFAULT NULL::numeric, p_min_stock_level numeric DEFAULT NULL::numeric', 'jsonb', 'e54402d968bd94924857f1ff69827d46', true),
      ('create_order_from_blend_ticket', 'create_order_from_blend_ticket', '_create_order_from_blend_ticket_replay_impl_20261015', 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text', 'json', '344532c6522cce26857ce4ffd9597125', true),
      ('create_direct_order', 'create_direct_order', '_create_direct_order_replay_impl_20261015', 'p_customer_id uuid, p_order_date date, p_order_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT ''[]''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text', 'jsonb', 'f18495ee041dafa152e736ce93c0452f', true),
      ('create_rush_order', 'create_rush_order', '_create_rush_order_replay_impl_20261015', 'p_customer_id uuid, p_items jsonb DEFAULT ''[]''::jsonb, p_notes text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '9027a97ab42a109f5e81188736f52f9c', true),
      ('close_quote_as_applied', 'close_quote_as_applied', '_close_quote_as_applied_replay_impl_20261015', 'p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '4d702d353d66f801e745c4d13ecbba24', true),
      ('close_quote_as_short', 'close_quote_as_short', '_close_quote_as_short_replay_impl_20261015', 'p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '0c2274bd3478635c5fc7ec38bcf46230', true),
      ('create_application_record_from_blend_ticket', 'create_app_record_from_bt', '_create_app_record_from_bt_replay_impl_20261015', 'p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid[]', '0ad9a78b900cb953e0aa7d2a0d87bda0', true),
      ('batch_cancel_deliveries', 'batch_cancel_deliveries', '_batch_cancel_deliveries_replay_impl_20261015', 'p_delivery_ids uuid[], p_cancel_reason text DEFAULT ''Batch cancelled''::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'integer', '25d34db60f098a22a62db53780742eee', true),
      ('reverse_completed_cycle_count', 'reverse_completed_cycle_count', '_reverse_completed_cycle_count_replay_impl_20261015', 'p_cycle_count_id uuid, p_reversed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'void', '76ac5389d5541ab4a7b3a96388165c5b', true),
      ('create_planned_holds', 'create_planned_holds', '_create_planned_holds_replay_impl_20261015', 'p_quote_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '810d772cbd0b5669fd22412067b9ddaa', true)
    ) AS pin(name, op, impl, args, ret, body_md5, key_required)
   WHERE
     -- Exactly one public wrapper with the live signature, defaults and return type: definer,
     -- pinned search_path, it routes through the intent check, the receipt binder and its renamed
     -- body, and is callable by authenticated and service_role but never by anon or PUBLIC.
     (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = pin.name
          AND pg_get_function_arguments(p.oid) = pin.args
          AND p.prorettype = pin.ret::regtype AND NOT p.proretset AND p.provolatile = 'v'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND strpos(p.prosrc, 'check_idempotency_intent(p_idempotency_key, ''' || pin.op || ''',') > 0
          AND strpos(p.prosrc, '_bind_replay_receipt_20261015(p_idempotency_key, ''' || pin.op || ''',') > 0
          AND strpos(p.prosrc, pin.impl || '(') > 0
          AND (NOT pin.key_required
               OR strpos(p.prosrc, 'IDEMPOTENCY_KEY_REQUIRED: ' || pin.name || ' requires p_idempotency_key') > 0)
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
     -- Exactly one renamed body: byte-identical to the reviewed live body, callable only by postgres.
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = pin.impl) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = pin.impl
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_STOCK_REPLAY_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  -- The commit-time guard: still exactly one enabled, deferred AFTER INSERT OR UPDATE row trigger,
  -- running the batch-1 guard function, now covering the batch-1 nine plus these thirteen.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.idempotency_keys'::regclass
         AND t.tgname = 'require_bound_replay_receipt_20261015'
         AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
         AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND (t.tgtype::int & 1) = 1      -- ROW level
         AND (t.tgtype::int & 2) = 0      -- AFTER
         AND (t.tgtype::int & 4) <> 0     -- INSERT
         AND (t.tgtype::int & 16) <> 0    -- UPDATE
         AND pg_get_triggerdef(t.oid) = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY[''void_payment''::text, ''delete_prepay_credit''::text, ''edit_prepay_credit''::text, ''apply_write_off''::text, ''reverse_write_off''::text, ''apply_prepay_to_invoice''::text, ''create_prepay_check_splits''::text, ''batch_apply_prepayments''::text, ''batch_void_invoices''::text, ''release_inventory_hold''::text, ''retire_inventory_item''::text, ''reconcile_negative_inventory''::text, ''manual_inventory_add''::text, ''create_order_from_blend_ticket''::text, ''create_direct_order''::text, ''create_rush_order''::text, ''close_quote_as_applied''::text, ''close_quote_as_short''::text, ''create_app_record_from_bt''::text, ''batch_cancel_deliveries''::text, ''reverse_completed_cycle_count''::text, ''create_planned_holds''::text]))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()'
     ) <> 1
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid = 'public.idempotency_keys'::regclass
            AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: require_bound_replay_receipt_20261015 must be the one deferred guard covering the batch-1 and batch-2 operations';
  END IF;

  -- The private cycle-count impl is callable only by postgres now.
  IF ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
            WHERE p.oid = to_regprocedure('public._reverse_completed_cycle_count_impl(uuid,uuid,text)')
              AND a.privilege_type = 'EXECUTE' ORDER BY 1)
       IS DISTINCT FROM ARRAY['postgres']::text[] THEN
    RAISE EXCEPTION 'POSTFLIGHT_REVERSE_CYCLE_COUNT_IMPL_ACL: _reverse_completed_cycle_count_impl must be callable only by postgres';
  END IF;

  -- revert_quote_status: still exactly one, with its live signature and ACL; its body is the pinned
  -- live body with only the planned-holds call retargeted (md5 below); create_planned_holds has no
  -- keyless path left.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'revert_quote_status') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'revert_quote_status'
          AND pg_get_function_arguments(p.oid) = 'p_quote_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'
          AND p.prorettype = 'jsonb'::regtype AND p.prosecdef AND p.proowner = 'postgres'::regrole
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = 'e038d6568f6f0294045bf662eceb02bd'
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
     OR EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure('public.create_planned_holds(uuid,uuid,text)')
          AND strpos(p.prosrc, 'RETURN public._create_planned_holds_replay_impl_20261015(p_quote_id, p_performed_by, NULL)') > 0) THEN
    RAISE EXCEPTION 'POSTFLIGHT_REVERT_QUOTE_STATUS_CONTRACT: revert_quote_status is not the reviewed body, or create_planned_holds still has a keyless path';
  END IF;

  -- The worker bodies below create_direct_order and create_rush_order keep their own key-only
  -- replay; no API role may reach them around the wrappers (unchanged by this file, asserted here).
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['public._create_direct_order_below_cost_impl_20260810(uuid,date,text,text,jsonb,uuid,text,text)',
                        'public._create_rush_order_below_cost_impl_20260810(uuid,jsonb,text,text,uuid,text)']) AS w(sig)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE to_regprocedure(w.sig) IS NULL
        OR has_function_privilege(api_role, to_regprocedure(w.sig), 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_WORKER_ACL: the below-cost order worker bodies must exist and be callable by no API role';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: thirteen stock RPCs now replay a stored result only for the same person and the exact same request';
END
$postflight$;

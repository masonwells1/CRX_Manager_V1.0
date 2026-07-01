-- PARKED-010 — codex-driven-bug-hunt cycle 6, finding #3 (MED).
-- dedupeKey: inventory-net-free:create_inventory_hold:idempotency-before-auth
--
-- THE GAP
-- public.create_inventory_hold (live verified 2026-06-30) is SECURITY DEFINER
-- and GRANTed EXECUTE to authenticated (anon is correctly off). But the
-- function body's FIRST executable statement is the idempotency cache lookup,
-- which runs BEFORE auth.uid() is asserted:
--   line 1-15 of body:
--     IF p_idempotency_key IS NOT NULL THEN
--       SELECT result INTO v_existing
--         FROM idempotency_keys
--        WHERE idempotency_key = p_idempotency_key
--          AND operation = 'create_inventory_hold';
--       IF v_existing IS NOT NULL THEN
--         RETURN v_existing;   ← returns cached hold_id BEFORE any auth check
--       END IF;
--     END IF;
--     v_actor := auth.uid();
--     IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
--
-- An authenticated caller (admin or sales_rep — they're the role that has
-- EXECUTE) who guesses or otherwise obtains another caller's idempotency_key
-- can call this function with that key and receive the cached jsonb result:
--   { hold_id, todays_free_before, forced }
-- The hold_id is the most sensitive piece — combined with separate read
-- access to inventory_holds (granted in this codebase to authenticated for
-- the UI), it lets the caller read the full hold record they did not create.
--
-- The CRX precedent (per CLAUDE.md): every SECDEF RPC self-gates on
-- auth.uid() / role as its FIRST executable statement. create_inventory_hold
-- is one of the few that doesn't. The Supabase advisor's
-- "Public Can Execute SECURITY DEFINER Function" list captures the *grant*
-- shape, but this misordering is invisible to the advisor — it has to be
-- caught by code review (or, as here, by Codex).
--
-- WHY MED (NOT HIGH)
-- (a) anon is already revoked; only authenticated admin/sales_rep can call.
-- (b) The cached payload is minimal (3 fields, no PII / customer name).
-- (c) The leak is contingent on a separate idempotency_key disclosure.
-- (d) The fix is trivial — reorder ~6 lines so auth.uid() and role come first.
-- HIGH parallels (PARKED-007) leaked customer pricing directly; this leaks a
-- single hold_id and a numeric uncommitted-stock figure.
--
-- HONEST LIMITATION (Codex r1 catch, kept for traceability)
-- This fix prevents anonymous and non-billing-role callers from getting the
-- cached result, but it does NOT bind the cache to the ORIGINAL requester:
-- any admin/sales_rep who learns another admin/sales_rep's idempotency_key
-- can still call this RPC, pass the role gate, and receive the cached
-- payload. Fully closing that gap requires adding `created_by` to
-- idempotency_keys and filtering check_idempotency by (key, op, actor) —
-- a project-wide structural change in the same shape as PARKED-008's
-- descope (every RPC that uses check_idempotency / save_idempotency, and
-- the 25+ direct `ON CONFLICT (idempotency_key)` inline callers). Out of
-- scope for this park; tracked as future foundation work.
--
-- THE FIX
-- Move the auth gate (auth.uid() check + p_performed_by strict-actor + role
-- gate) to the TOP of the function body, BEFORE the idempotency lookup.
-- Every other byte is verbatim from the live body — same DELETE+INSERT
-- semantics, same inventory math, same force-reason guard, same activity
-- feed write, same save_idempotency. Reversible: swap the two blocks back.
--
-- ROLLED-BACK VALIDATION (inline below): assert the function body has
-- v_actor := auth.uid() BEFORE the idempotency_keys SELECT (position check
-- compares offsets in prosrc). Also assert the function signature, SECDEF,
-- search_path, and grants are unchanged.
--
-- PARKED: do NOT apply without Mason's explicit OK.
-- ============================================================================

-- LIVE-FAITHFUL signature (verified 2026-06-30 via pg_get_function_arguments):
-- p_expires_at is `date` (not timestamptz), parameter order is product/customer/
-- qty/type/expires/notes/performed_by/force/force_reason/idempotency_key, and
-- ONLY the last 3 args have defaults (force=false, force_reason=NULL,
-- idempotency_key=NULL). v1 of this draft had the wrong type and a different
-- param order — a CREATE OR REPLACE with a different argument signature creates
-- a NEW overload instead of replacing the live function. v2 fixed type/order
-- but added DEFAULT NULL to p_expires_at/p_notes/p_performed_by — Codex r2 catch:
-- pg_get_function_identity_arguments() shows only types not defaults, so the
-- drift went unflagged. v3 reproduces the live signature byte-for-byte
-- including defaults, and the self-check now validates the full
-- pg_get_function_arguments() result (which includes defaults).
CREATE OR REPLACE FUNCTION public.create_inventory_hold(
  p_product_id uuid,
  p_customer_id uuid,
  p_quantity numeric,
  p_hold_type text,
  p_expires_at date,
  p_notes text,
  p_performed_by uuid,
  p_force boolean DEFAULT false,
  p_force_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_hold_id uuid;
  v_existing jsonb;
  v_inventory record;
  v_active_holds numeric;
  v_todays_free numeric;
  v_result jsonb;
BEGIN
  -- PARKED-010 (codex-driven cycle 6 #3 MED): auth gate FIRST — without this,
  -- any authenticated caller who learns a known idempotency_key for this op
  -- can read the cached hold_id (+ uncommitted-stock figure) without first
  -- proving they are admin/sales_rep AND the original requester (strict-actor).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency cache check NOW runs after the caller is authenticated AND
  -- role-gated. Same-key, same-op replay still returns the cached result; an
  -- attacker without the right role hits INSUFFICIENT_ROLE above instead.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'create_inventory_hold';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  IF p_hold_type NOT IN ('manual', 'crop_program') THEN
    RAISE EXCEPTION 'INVALID_HOLD_TYPE: %', p_hold_type;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: must be > 0';
  END IF;

  -- F1 fix: validate the force contract BEFORE any inventory-based branching.
  IF p_force THEN
    IF v_role != 'admin' THEN
      RAISE EXCEPTION 'FORCE_REQUIRES_ADMIN';
    END IF;
    IF p_force_reason IS NULL OR length(trim(p_force_reason)) = 0 THEN
      RAISE EXCEPTION 'FORCE_REQUIRES_REASON';
    END IF;
  END IF;

  SELECT id, quantity_available, quantity_prebooked
    INTO v_inventory
    FROM inventory
   WHERE product_id = p_product_id
     AND location = 'Main Warehouse'
   FOR UPDATE;

  IF NOT FOUND THEN
    v_todays_free := 0;
    v_active_holds := 0;
  ELSE
    SELECT COALESCE(SUM(quantity), 0) INTO v_active_holds
      FROM inventory_holds
     WHERE product_id = p_product_id
       AND is_active = true
       AND (expires_at IS NULL OR expires_at >= CURRENT_DATE);
    v_todays_free := v_inventory.quantity_available
                     - v_inventory.quantity_prebooked
                     - v_active_holds;
  END IF;

  IF v_todays_free - p_quantity < 0 AND NOT p_force THEN
    RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY: only % units uncommitted (Available % - Prebooked % - Active Holds %); requested %',
      v_todays_free,
      COALESCE(v_inventory.quantity_available, 0),
      COALESCE(v_inventory.quantity_prebooked, 0),
      v_active_holds,
      p_quantity;
  END IF;

  INSERT INTO inventory_holds (
    product_id, customer_id, quantity, hold_type, expires_at, notes,
    is_active, created_by, created_at, updated_at
  ) VALUES (
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, true, v_actor, NOW(), NOW()
  ) RETURNING id INTO v_hold_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'inventory_hold_created',
    CASE
      WHEN p_force THEN 'WARNING: Hold created with admin override (' || p_force_reason || ')'
      ELSE 'Hold created'
    END,
    v_actor, 'inventory_hold', v_hold_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'hold_id', v_hold_id,
    'todays_free_before', v_todays_free,
    'forced', p_force
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'create_inventory_hold', v_result,
            now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

-- ── SELF-VERIFICATION ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
  v_auth_pos int;
  v_idem_pos int;
  v_secdef boolean;
  v_proconfig text[];
  v_n_overloads int;
  v_args text;
  v_anon_exec boolean;
  v_authd_exec boolean;
BEGIN
  -- PARKED-010 r2 (Codex catch): assert there is EXACTLY ONE overload — a
  -- wrong-signature CREATE OR REPLACE silently adds a parallel overload
  -- instead of replacing the live one (v1 of this draft hit that trap).
  SELECT count(*) INTO v_n_overloads FROM pg_proc
    WHERE proname='create_inventory_hold' AND pronamespace='public'::regnamespace;
  IF v_n_overloads <> 1 THEN
    RAISE EXCEPTION 'PARKED-010: expected exactly 1 overload, found %', v_n_overloads;
  END IF;

  SELECT prosrc, prosecdef, proconfig,
         pg_get_function_identity_arguments(oid),
         has_function_privilege('anon', oid, 'EXECUTE'),
         has_function_privilege('authenticated', oid, 'EXECUTE')
    INTO v_src, v_secdef, v_proconfig, v_args, v_anon_exec, v_authd_exec
    FROM pg_proc
    WHERE proname='create_inventory_hold' AND pronamespace='public'::regnamespace;

  IF v_src IS NULL THEN RAISE EXCEPTION 'PARKED-010: function missing'; END IF;
  IF NOT v_secdef THEN RAISE EXCEPTION 'PARKED-010: lost SECURITY DEFINER'; END IF;

  -- Live signature lock — exact arg list, in order, with live types
  IF v_args <> 'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean, p_force_reason text, p_idempotency_key text' THEN
    RAISE EXCEPTION 'PARKED-010: live signature drift — got %', v_args;
  END IF;

  -- PARKED-010 r3 (Codex catch): identity_arguments shows only types — defaults
  -- can drift unseen. Also validate pg_get_function_arguments() (includes
  -- defaults) so adding/removing a DEFAULT NULL on any optional-looking arg
  -- fails the self-check. Live: only the last 3 args carry defaults.
  DECLARE v_args_with_defaults text;
  BEGIN
    SELECT pg_get_function_arguments(oid) INTO v_args_with_defaults
      FROM pg_proc WHERE proname='create_inventory_hold' AND pronamespace='public'::regnamespace;
    IF v_args_with_defaults <>
       'p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text'
    THEN
      RAISE EXCEPTION 'PARKED-010: defaults drift — got %', v_args_with_defaults;
    END IF;
  END;

  -- Live grant posture: anon OFF, authenticated ON
  IF v_anon_exec THEN RAISE EXCEPTION 'PARKED-010: anon must NOT have EXECUTE'; END IF;
  IF NOT v_authd_exec THEN RAISE EXCEPTION 'PARKED-010: authenticated must retain EXECUTE'; END IF;

  -- search_path preserved
  IF v_proconfig IS NULL OR NOT (v_proconfig::text LIKE '%search_path=public, pg_temp%') THEN
    RAISE EXCEPTION 'PARKED-010: search_path drift — got %', v_proconfig::text;
  END IF;

  -- auth.uid() must appear BEFORE the idempotency_keys SELECT
  v_auth_pos := position('v_actor := auth.uid()' in v_src);
  v_idem_pos := position('FROM idempotency_keys' in v_src);
  IF v_auth_pos = 0 THEN RAISE EXCEPTION 'PARKED-010: auth.uid() block missing'; END IF;
  IF v_idem_pos = 0 THEN RAISE EXCEPTION 'PARKED-010: idempotency lookup missing'; END IF;
  IF v_auth_pos >= v_idem_pos THEN
    RAISE EXCEPTION 'PARKED-010: auth.uid() at pos % must come before idempotency_keys at pos %', v_auth_pos, v_idem_pos;
  END IF;

  -- Role gate still present, force-reason guard still present
  IF position('INSUFFICIENT_ROLE' in v_src) = 0 THEN RAISE EXCEPTION 'PARKED-010: role gate dropped'; END IF;
  IF position('FORCE_REQUIRES_ADMIN' in v_src) = 0 THEN RAISE EXCEPTION 'PARKED-010: force-admin guard dropped'; END IF;
  IF position('FORCE_REQUIRES_REASON' in v_src) = 0 THEN RAISE EXCEPTION 'PARKED-010: force-reason guard dropped'; END IF;
END $$;

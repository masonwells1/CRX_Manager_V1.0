-- Migration: bind commission payout idempotency receipts to actor + exact intent
--
-- Section 7 gauntlet refresh (2026-08-09) Finding 2 — HIGH. The commission
-- payout create/post/void receipts identify only a random key plus the
-- operation name. The browser deliberately retains an idempotency key after an
-- uncertain response (src/hooks/useIdempotencyKey.ts), so an admin who changes
-- the selected commissions, opens a different payment, or edits a void reason
-- and retries can be handed the FIRST action's cached success. No double-pay
-- occurs, but the operator is told a different financial action succeeded.
--
-- Fix: derive a server-side SHA-256 fingerprint of the exact intent, persist it
-- with the authenticated actor on the receipt, and fail closed when a key is
-- reused for a different actor or a different intent. Public signatures,
-- behaviour, and error messages for every legitimate path are unchanged.
--
-- Established pattern reused verbatim from
-- 20260803010917_bind_idempotency_to_mutation_intent.sql (save_invoice /
-- create_quick_delivery): rename the implementation, lock it down to postgres,
-- and recreate the public wrapper with an identical signature. The three payout
-- bodies are never retyped, so their money logic cannot drift in this change.
--
-- Receipt-disclosure note: unlike save_invoice/create_quick_delivery, all three
-- payout RPCs are admin-only. The wrapper re-runs is_admin() before any receipt
-- is read, and admins can already read every payout row, so no additional
-- per-entity scope check is required before returning the committed receipt in
-- the error DETAIL.
--
-- CHECK 6 live preflight (read-only Supabase execute_sql, 2026-08-09 17:07:28
-- UTC): supabase_migrations.schema_migrations contained 946 rows; max(version)
-- = 20260809130108 and the ledger name was
-- team_note_completion_rpc_and_assignment_notify. This file's timestamp
-- 20260810130500 is strictly greater. No live schema or data was changed.

-- ---------------------------------------------------------------------------
-- Shared intent-aware receipt check
-- ---------------------------------------------------------------------------
-- Deliberately a NEW, distinctly named helper rather than defaulted parameters
-- added to check_idempotency(text, text). Adding defaulted parameters to an
-- existing function via CREATE OR REPLACE creates a SECOND function and makes
-- every prior-arity call ambiguous — the migration-drift bug class this repo
-- has been bitten by before.
--
-- Returns NULL when there is no live receipt (caller performs the work).
-- Returns {"found": true, "result": <receipt>} on an exact actor+intent match
-- (caller replays). Raises otherwise. The envelope keeps "no receipt" and
-- "receipt whose stored result is NULL" unambiguous, so a money operation can
-- never be silently re-executed.
CREATE OR REPLACE FUNCTION public.check_idempotency_intent(
  p_key text,
  p_operation text,
  p_actor uuid,
  p_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  IF p_fingerprint IS NULL OR btrim(p_fingerprint) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_FINGERPRINT_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_key;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
  END IF;

  -- Deployment bridge: receipts written by the pre-migration implementation
  -- carry neither binding column. Their original intent cannot be
  -- reconstructed, so fail closed and hand back the committed receipt rather
  -- than replay it as this request. This avoids both a duplicate payout and
  -- reporting a stale success for edited input.
  IF v_existing.request_actor_id IS NULL
     AND v_existing.request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object(
              'operation', v_existing.operation,
              'result', v_existing.result
            )::text;
  END IF;

  IF v_existing.request_actor_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
  END IF;

  IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object(
              'operation', v_existing.operation,
              'result', v_existing.result
            )::text;
  END IF;

  RETURN jsonb_build_object('found', true, 'result', v_existing.result);
END;
$function$;

COMMENT ON FUNCTION public.check_idempotency_intent(text, text, uuid, text) IS
  'Intent-bound idempotency receipt check. NULL = no receipt; {"found":true,"result":...} = exact actor+intent replay; raises IDEMPOTENCY_ACTOR_MISMATCH / IDEMPOTENCY_INTENT_MISMATCH otherwise. Callers must already have authorized the actor.';

REVOKE ALL ON FUNCTION public.check_idempotency_intent(text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_idempotency_intent(text, text, uuid, text)
  TO postgres;

-- ---------------------------------------------------------------------------
-- create_commission_payment
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text)
  RENAME TO _create_commission_payment_intent_impl_20260809;

REVOKE ALL ON FUNCTION public._create_commission_payment_intent_impl_20260809(uuid[], text, text, date, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._create_commission_payment_intent_impl_20260809(uuid[], text, text, date, text, uuid, text)
  TO postgres;

CREATE FUNCTION public.create_commission_payment(
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
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
BEGIN
  -- Same guards, same messages, same order as the implementation, so no
  -- legitimate caller sees a behaviour change.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._create_commission_payment_intent_impl_20260809(
      p_commission_ids, p_payment_method, p_reference,
      p_payment_date, p_notes, p_performed_by, NULL
    );
  END IF;

  -- Intent = the actor plus the sorted, de-duplicated commission selection and
  -- every payment field the admin can edit. p_payment_date is fingerprinted
  -- raw: substituting CURRENT_DATE here would make an otherwise identical
  -- retry across midnight look like a changed intent.
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'commission_ids', (
          SELECT COALESCE(jsonb_agg(to_jsonb(cid) ORDER BY cid), '[]'::jsonb)
            FROM (
              SELECT DISTINCT unnest(COALESCE(p_commission_ids, ARRAY[]::uuid[])) AS cid
            ) s
        ),
        'payment_method', NULLIF(btrim(COALESCE(p_payment_method, '')), ''),
        'reference', NULLIF(btrim(COALESCE(p_reference, '')), ''),
        'payment_date', p_payment_date,
        'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- Return the committed receipt here rather than delegating: the
    -- implementation's own check_idempotency reads a NULL stored result as
    -- "no receipt" and would re-execute the payout. idempotency_keys.result
    -- is nullable, so fail closed instead.
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN ((v_replay -> 'result') #>> '{}')::uuid;
  END IF;

  v_payment_id := public._create_commission_payment_intent_impl_20260809(
    p_commission_ids, p_payment_method, p_reference,
    p_payment_date, p_notes, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_payment_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- post_commission_payment
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.post_commission_payment(uuid, uuid, text)
  RENAME TO _post_commission_payment_intent_impl_20260809;

REVOKE ALL ON FUNCTION public._post_commission_payment_intent_impl_20260809(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._post_commission_payment_intent_impl_20260809(uuid, uuid, text)
  TO postgres;

CREATE FUNCTION public.post_commission_payment(
  p_payment_id uuid,
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
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._post_commission_payment_intent_impl_20260809(
      p_payment_id, p_performed_by, NULL
    );
  END IF;

  -- Intent = the actor plus which payment is being posted.
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'post_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- See create_commission_payment: return the committed receipt directly so a
    -- NULL stored result can never be mistaken for "not yet performed".
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._post_commission_payment_intent_impl_20260809(
    p_payment_id, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'post_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_commission_payment(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_commission_payment(uuid, uuid, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- void_commission_payment
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.void_commission_payment(uuid, text, uuid, text)
  RENAME TO _void_commission_payment_intent_impl_20260809;

REVOKE ALL ON FUNCTION public._void_commission_payment_intent_impl_20260809(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._void_commission_payment_intent_impl_20260809(uuid, text, uuid, text)
  TO postgres;

CREATE FUNCTION public.void_commission_payment(
  p_payment_id uuid,
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
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  -- REASON_REQUIRED is checked before the receipt lookup in the implementation;
  -- keep that ordering so the error surface is unchanged.
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._void_commission_payment_intent_impl_20260809(
      p_payment_id, p_reason, p_performed_by, NULL
    );
  END IF;

  -- Intent = the actor, which payment is being voided, and the reason text
  -- (normalized only for surrounding whitespace, which the UI already trims).
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id,
        'reason', btrim(p_reason)
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'void_commission_payment', v_actor, v_fingerprint
  );

  IF v_replay IS NOT NULL THEN
    -- See create_commission_payment: return the committed receipt directly so a
    -- NULL stored result can never be mistaken for "not yet performed".
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._void_commission_payment_intent_impl_20260809(
    p_payment_id, p_reason, p_performed_by, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'void_commission_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.void_commission_payment(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_commission_payment(uuid, text, uuid, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_name text;
  v_count integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'create_commission_payment',
    'post_commission_payment',
    'void_commission_payment',
    'check_idempotency_intent'
  ] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% overload count = % (expected 1)', v_name, v_count;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.create_commission_payment(uuid[],text,text,date,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.post_commission_payment(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.void_commission_payment(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anonymous execution must remain revoked';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.create_commission_payment(uuid[],text,text,date,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.post_commission_payment(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.void_commission_payment(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated execution grant missing';
  END IF;

  IF has_function_privilege('authenticated', 'public.check_idempotency_intent(text,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._create_commission_payment_intent_impl_20260809(uuid[],text,text,date,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._post_commission_payment_intent_impl_20260809(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'internal payout implementations must not be browser-executable';
  END IF;
END;
$verify$;

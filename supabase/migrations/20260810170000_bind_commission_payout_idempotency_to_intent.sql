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
-- reused for a different actor or a different intent. Public signatures and
-- error messages are unchanged on every legitimate path.
--
-- One deliberate behaviour change: create now passes the SAME whitespace-
-- normalized payment_method / reference / notes to the implementation that it
-- fingerprints, and void does the same for reason. Previously the raw values
-- were stored. Normalizing on only one side would let ' REF-1 ' replay REF-1's
-- receipt while claiming to have persisted something different.
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
-- the error DETAIL. This is a narrowed disclosure, not zero disclosure: an admin
-- who collides on another admin's key sees that receipt's result. Admin-to-admin
-- over rows both can already read, so it is accepted — but it is a leak, and any
-- future non-admin caller of these RPCs invalidates that reasoning.
--
-- Double-payout backstop (verified live 2026-08-10 against the implementation):
-- _create_commission_payment_intent_impl_20260809 locks every selected
-- commission FOR UPDATE and raises COMMISSION_PAYMENT_SELECTION_STALE unless all
-- are still 'pending'. So even when the bridge below refuses a legacy receipt
-- and the operator retries with a fresh key, a second payout for the same
-- commissions is hard-refused by that guard rather than by idempotency alone.
--
-- CHECK 6 live preflight (read-only Supabase execute_sql, re-read 2026-08-10):
-- max(supabase_migrations.schema_migrations.version) = 20260810155629 across 957
-- applied migrations. This file's timestamp 20260810170000 is strictly greater,
-- and sorts after every 20260809170500-20260809230500 migration; none of those
-- redefine the three payout RPCs. The file has been renumbered forward twice —
-- from 20260809171500, then from 20260810130500 — because parallel sessions kept
-- pushing the live high-water past it while this branch was in review. A file
-- numbered behind live can be skipped by migration delivery, which would leave
-- production on the unbound RPCs while the frontend ships. Re-read the live
-- high-water immediately before applying and renumber again if it has moved.
--
-- Also verified live at that time: idempotency_keys already carries
-- request_actor_id and request_fingerprint; digest() resolves in the extensions
-- schema; and there were ZERO unexpired receipts for the three payout
-- operations, so the legacy-receipt bridge below strands no in-flight retry at
-- cutover. No live schema or data was changed.

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
  -- Parity with check_idempotency: a whitespace-only key is a caller bug, not a
  -- missing key, and must keep raising the original message.
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
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

  -- Message parity with check_idempotency: the wrapper reaches this check first,
  -- so the caller must still see the original formatted text, not a bare code.
  IF v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing.operation, p_operation;
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
-- Re-runnable: rename only on the first application. A bare ALTER ... RENAME
-- aborts on a replay (the target name already exists), which would strand a
-- recovery that re-runs this file after a lost ledger write. Fail closed if the
-- public function is missing entirely rather than installing a wrapper over
-- nothing. Also fail closed when the impl is gone but the PUBLIC function is
-- already this migration's wrapper: renaming that onto the impl name would give
-- the wrapper a body that calls itself, and every postcondition below (name
-- present, one overload, grants correct) would still pass while every payout
-- call recursed until the stack blew.
DO $rename_create$
DECLARE
  v_src text;
  v_code text;
BEGIN
  IF to_regprocedure('public._create_commission_payment_intent_impl_20260809(uuid[], text, text, date, text, uuid, text)') IS NULL THEN
    IF to_regprocedure('public.create_commission_payment(uuid[], text, text, date, text, uuid, text)') IS NULL THEN
      RAISE EXCEPTION 'create_commission_payment(uuid[], text, text, date, text, uuid, text) not found; refusing to install the intent-binding wrapper';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.create_commission_payment(uuid[], text, text, date, text, uuid, text)');
    IF v_src LIKE '%_create_commission_payment_intent_impl_20260809%' THEN
      RAISE EXCEPTION 'public.create_commission_payment is already the intent-binding wrapper but its implementation _create_commission_payment_intent_impl_20260809 is missing; refusing to rename the wrapper onto itself';
    END IF;
    -- Absence of the wrapper marker is not proof this is the body we mean to
    -- wrap. Require the two contract markers the wrapper actually depends on:
    -- the implementation must write an idempotency receipt via
    -- check_idempotency() — the wrapper stamps that receipt afterwards and
    -- raises IDEMPOTENCY_RECEIPT_MISSING if it is absent — and it must touch
    -- commission_payment_items, which no thin wrapper does. Fail closed rather
    -- than rename an unrelated body into the implementation slot.
    -- prosrc keeps the comments, so a body that merely MENTIONS
    -- check_idempotency() in a comment would satisfy a plain LIKE while doing
    -- nothing of the kind. Strip block comments then line comments and match
    -- the code that is left. Stripping can only remove text, so every way this
    -- goes wrong (a '--' inside a string literal, a nested block comment)
    -- deletes a marker and refuses loudly; it can never invent one.
    --
    -- Deliberately asymmetric with the wrapper-marker check above, which reads
    -- the RAW source: there, ANY mention — comment included — should stop us,
    -- because renaming the wrapper onto itself is the unrecoverable outcome.
    v_code := regexp_replace(
                regexp_replace(v_src, '/\*.*?\*/', ' ', 'gs'),
                '--[^\n]*', ' ', 'g');
    IF v_code NOT LIKE '%check_idempotency(%' OR v_code NOT LIKE '%commission_payment_items%' THEN
      RAISE EXCEPTION 'public.create_commission_payment does not look like the payout implementation this migration wraps (it must call check_idempotency() and touch commission_payment_items); refusing to rename it';
    END IF;
    ALTER FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text)
      RENAME TO _create_commission_payment_intent_impl_20260809;
  END IF;
END
$rename_create$;

REVOKE ALL ON FUNCTION public._create_commission_payment_intent_impl_20260809(uuid[], text, text, date, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._create_commission_payment_intent_impl_20260809(uuid[], text, text, date, text, uuid, text)
  TO postgres;

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
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
  -- Normalize ONCE, then use these same values for both the fingerprint and the
  -- implementation call. Fingerprinting a trimmed value while storing the raw
  -- one would let ' REF-1 ' replay REF-1's receipt while claiming to persist
  -- different metadata, so the two must never diverge.
  v_payment_method text := NULLIF(btrim(COALESCE(p_payment_method, '')), '');
  v_reference      text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_notes          text := NULLIF(btrim(COALESCE(p_notes, '')), '');
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

  -- A key is REQUIRED. It used to be optional, and omitting it ran the payout
  -- with no receipt and therefore no intent binding at all — an authenticated
  -- admin calling the RPC directly (PostgREST lets a defaulted argument be
  -- omitted) reached the money path unbound, which is the exact hole this
  -- migration exists to close. Every application caller already sends one, and
  -- the one checked-in smoke script that passed NULL
  -- (scripts/smoke/smoke-commission_payment_for_update_fix.sql) was fixed in the
  -- same change, so refusing here leaves no unbound door.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second is locale-independent: [[:space:]] follows
  -- the database collation, so whether NBSP or an em-space counts as blank is
  -- not the same answer on every cluster, and a key made only of those would be
  -- accepted somewhere. Every key this application generates is ASCII, so
  -- demanding one printable ASCII character costs no real caller anything.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor plus the sorted, de-duplicated commission selection and
  -- every payment field the admin can edit. p_payment_date is fingerprinted
  -- raw: substituting CURRENT_DATE here would make an otherwise identical
  -- retry across midnight look like a changed intent.
  --
  -- p_performed_by is deliberately NOT fingerprinted, and that omission depends
  -- on the guard above constraining it to {NULL, v_actor} — it therefore carries
  -- no information beyond actor_id. If that guard is ever relaxed, p_performed_by
  -- MUST be added here.
  --
  -- The DISTINCT below matches the implementation, which also de-duplicates the
  -- selection (SELECT DISTINCT id FROM unnest(p_commission_ids)) before locking
  -- and paying, so [A, A] and [A] are the same request in both layers.
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
        'payment_method', v_payment_method,
        'reference', v_reference,
        'payment_date', p_payment_date,
        'notes', v_notes
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
    p_commission_ids, v_payment_method, v_reference,
    p_payment_date, v_notes, p_performed_by, p_idempotency_key
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
-- See create_commission_payment: rename only on first application.
DO $rename_post$
DECLARE
  v_src text;
  v_code text;
BEGIN
  IF to_regprocedure('public._post_commission_payment_intent_impl_20260809(uuid, uuid, text)') IS NULL THEN
    IF to_regprocedure('public.post_commission_payment(uuid, uuid, text)') IS NULL THEN
      RAISE EXCEPTION 'post_commission_payment(uuid, uuid, text) not found; refusing to install the intent-binding wrapper';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.post_commission_payment(uuid, uuid, text)');
    IF v_src LIKE '%_post_commission_payment_intent_impl_20260809%' THEN
      RAISE EXCEPTION 'public.post_commission_payment is already the intent-binding wrapper but its implementation _post_commission_payment_intent_impl_20260809 is missing; refusing to rename the wrapper onto itself';
    END IF;
    -- See create: absence of the wrapper marker is not proof of identity.
    -- prosrc keeps the comments, so a body that merely MENTIONS
    -- check_idempotency() in a comment would satisfy a plain LIKE while doing
    -- nothing of the kind. Strip block comments then line comments and match
    -- the code that is left. Stripping can only remove text, so every way this
    -- goes wrong (a '--' inside a string literal, a nested block comment)
    -- deletes a marker and refuses loudly; it can never invent one.
    --
    -- Deliberately asymmetric with the wrapper-marker check above, which reads
    -- the RAW source: there, ANY mention — comment included — should stop us,
    -- because renaming the wrapper onto itself is the unrecoverable outcome.
    v_code := regexp_replace(
                regexp_replace(v_src, '/\*.*?\*/', ' ', 'gs'),
                '--[^\n]*', ' ', 'g');
    IF v_code NOT LIKE '%check_idempotency(%' OR v_code NOT LIKE '%commission_payment_items%' THEN
      RAISE EXCEPTION 'public.post_commission_payment does not look like the payout implementation this migration wraps (it must call check_idempotency() and touch commission_payment_items); refusing to rename it';
    END IF;
    ALTER FUNCTION public.post_commission_payment(uuid, uuid, text)
      RENAME TO _post_commission_payment_intent_impl_20260809;
  END IF;
END
$rename_post$;

REVOKE ALL ON FUNCTION public._post_commission_payment_intent_impl_20260809(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._post_commission_payment_intent_impl_20260809(uuid, uuid, text)
  TO postgres;

CREATE OR REPLACE FUNCTION public.post_commission_payment(
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

  -- See create: a key is REQUIRED, so no caller reaches the money path unbound.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second is locale-independent: [[:space:]] follows
  -- the database collation, so whether NBSP or an em-space counts as blank is
  -- not the same answer on every cluster, and a key made only of those would be
  -- accepted somewhere. Every key this application generates is ASCII, so
  -- demanding one printable ASCII character costs no real caller anything.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_commission_payment requires p_idempotency_key';
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
-- See create_commission_payment: rename only on first application.
DO $rename_void$
DECLARE
  v_src text;
  v_code text;
BEGIN
  IF to_regprocedure('public._void_commission_payment_intent_impl_20260809(uuid, text, uuid, text)') IS NULL THEN
    IF to_regprocedure('public.void_commission_payment(uuid, text, uuid, text)') IS NULL THEN
      RAISE EXCEPTION 'void_commission_payment(uuid, text, uuid, text) not found; refusing to install the intent-binding wrapper';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.void_commission_payment(uuid, text, uuid, text)');
    IF v_src LIKE '%_void_commission_payment_intent_impl_20260809%' THEN
      RAISE EXCEPTION 'public.void_commission_payment is already the intent-binding wrapper but its implementation _void_commission_payment_intent_impl_20260809 is missing; refusing to rename the wrapper onto itself';
    END IF;
    -- See create: absence of the wrapper marker is not proof of identity.
    -- prosrc keeps the comments, so a body that merely MENTIONS
    -- check_idempotency() in a comment would satisfy a plain LIKE while doing
    -- nothing of the kind. Strip block comments then line comments and match
    -- the code that is left. Stripping can only remove text, so every way this
    -- goes wrong (a '--' inside a string literal, a nested block comment)
    -- deletes a marker and refuses loudly; it can never invent one.
    --
    -- Deliberately asymmetric with the wrapper-marker check above, which reads
    -- the RAW source: there, ANY mention — comment included — should stop us,
    -- because renaming the wrapper onto itself is the unrecoverable outcome.
    v_code := regexp_replace(
                regexp_replace(v_src, '/\*.*?\*/', ' ', 'gs'),
                '--[^\n]*', ' ', 'g');
    IF v_code NOT LIKE '%check_idempotency(%' OR v_code NOT LIKE '%commission_payment_items%' THEN
      RAISE EXCEPTION 'public.void_commission_payment does not look like the payout implementation this migration wraps (it must call check_idempotency() and touch commission_payment_items); refusing to rename it';
    END IF;
    ALTER FUNCTION public.void_commission_payment(uuid, text, uuid, text)
      RENAME TO _void_commission_payment_intent_impl_20260809;
  END IF;
END
$rename_void$;

REVOKE ALL ON FUNCTION public._void_commission_payment_intent_impl_20260809(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._void_commission_payment_intent_impl_20260809(uuid, text, uuid, text)
  TO postgres;

CREATE OR REPLACE FUNCTION public.void_commission_payment(
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
  -- See create_commission_payment: fingerprint and implementation must receive
  -- the identical normalized value, never trimmed here and raw there.
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  -- REASON_REQUIRED is checked before the receipt lookup in the implementation;
  -- keep that ordering so the error surface is unchanged.
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  -- See create: a key is REQUIRED, so no caller reaches the money path unbound.
  -- Two predicates, deliberately. The first is the house rule already live in
  -- 20260721145936 across every money/lifecycle RPC, kept so this path does not
  -- drift from the rest. The second is locale-independent: [[:space:]] follows
  -- the database collation, so whether NBSP or an em-space counts as blank is
  -- not the same answer on every cluster, and a key made only of those would be
  -- accepted somewhere. Every key this application generates is ASCII, so
  -- demanding one printable ASCII character costs no real caller anything.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_commission_payment requires p_idempotency_key';
  END IF;

  -- Intent = the actor, which payment is being voided, and the reason text
  -- (normalized only for surrounding whitespace, which the UI already trims).
  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'payment_id', p_payment_id,
        'reason', v_reason
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
    p_payment_id, v_reason, p_performed_by, p_idempotency_key
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
  v_role text;
  v_target text;
  -- Public entry points: reachable by a signed-in browser session, never by anon.
  v_public text[] := ARRAY[
    'public.create_commission_payment(uuid[],text,text,date,text,uuid,text)',
    'public.post_commission_payment(uuid,uuid,text)',
    'public.void_commission_payment(uuid,text,uuid,text)'
  ];
  -- Internal surface: the receipt helper and the three renamed implementations.
  -- Every one of these skips a guard the wrapper performs, so NONE of the three
  -- PostgREST roles may execute them — not anon, not authenticated, and not
  -- service_role. Checking only anon+authenticated (as an earlier revision did)
  -- would let a service_role grant reintroduce the unguarded path.
  v_internal text[] := ARRAY[
    'public.check_idempotency_intent(text,text,uuid,text)',
    'public._create_commission_payment_intent_impl_20260809(uuid[],text,text,date,text,uuid,text)',
    'public._post_commission_payment_intent_impl_20260809(uuid,uuid,text)',
    'public._void_commission_payment_intent_impl_20260809(uuid,text,uuid,text)'
  ];
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'create_commission_payment',
    'post_commission_payment',
    'void_commission_payment',
    'check_idempotency_intent',
    '_create_commission_payment_intent_impl_20260809',
    '_post_commission_payment_intent_impl_20260809',
    '_void_commission_payment_intent_impl_20260809'
  ] LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '% overload count = % (expected 1)', v_name, v_count;
    END IF;
  END LOOP;

  FOREACH v_target IN ARRAY v_public LOOP
    IF has_function_privilege('anon', v_target, 'EXECUTE') THEN
      RAISE EXCEPTION 'anonymous execution must remain revoked: %', v_target;
    END IF;
    IF NOT has_function_privilege('authenticated', v_target, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated execution grant missing: %', v_target;
    END IF;
  END LOOP;

  FOREACH v_target IN ARRAY v_internal LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(v_role, v_target, 'EXECUTE') THEN
        RAISE EXCEPTION
          'internal payout implementations must not be browser-executable: % may execute %',
          v_role, v_target;
      END IF;
    END LOOP;
  END LOOP;
END;
$verify$;

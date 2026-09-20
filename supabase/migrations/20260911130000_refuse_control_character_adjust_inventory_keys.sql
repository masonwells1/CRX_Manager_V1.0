-- ============================================================================
-- adjust_inventory: refuse idempotency keys that carry ASCII control
-- characters, and state the refused set exactly.
-- STATUS: NOT APPLIED — DO NOT APPLY. LOCAL CANDIDATE; forward-only
-- CREATE OR REPLACE of the live adjust_inventory body. No DDL beyond that
-- function, no data rewrite, no new object.
--
-- (That STATUS line's exact wording is load-bearing, not style. The parked-scan
-- detector hasExplicitParkedMigrationHeader() in
-- .claude/hooks/worktree-awareness-lib.mjs only accepts "NOT APPLIED" when it is
-- followed by end-of-line or a separator plus "DO NOT APPLY". An earlier draft
-- read "NOT APPLIED — LOCAL CANDIDATE." and matched NOTHING, which silently
-- dropped this file from the parked set and degraded the whole worktree scan to
-- UNKNOWN. Match the predecessor's wording exactly.)
--
-- STAMP: deliberately 20260911130000, NOT a 2026-09-20 stamp, though it was
-- authored on 2026-09-20. It must sort ABOVE the live effective high-water
-- 20260911120000 (whose body it replaces) and BELOW the eight parked
-- 20260914100* files. A 2026-09-20 stamp would sort above all eight, and the
-- pending-set guard (.claude/hooks/migration-pending-lib.mjs) then REFUSES the
-- apply while any older migration is still pending — all eight are. The only
-- escape would be an `ordering-guard: ahead-of-pending` marker, which raises the
-- effective high-water and STRANDS all eight, forcing a ninth restamp round.
-- Stamping below the band avoids both: nothing is stranded, no marker is needed,
-- and the band still applies in its own order afterwards. Measured 2026-09-20:
-- ZERO migrations on disk sort between 20260911120000 and 20260914100100, so
-- this stamp lands in an empty gap and displaces nothing. Same technique, same
-- reason as 20260908140000, which was stamped below this cohort so it could
-- apply first without stranding it.
--
-- idempotency-body-check: exempt — the body below DOES enforce
-- p_idempotency_key: it requires the key, calls public.check_idempotency_intent
-- (per-key advisory lock + actor/intent comparison + replay) BEFORE any
-- mutation, and writes the receipt with a direct INSERT INTO
-- public.idempotency_keys carrying request_actor_id and request_fingerprint.
-- The hook's helper pattern wants check_idempotency( plus save_idempotency(,
-- and save_idempotency cannot write the binding columns, so neither of the
-- hook's patterns fits a bound receipt. Unchanged from 20260911120000.
--
-- caller-analysis: adjust_inventory :: only the browser calls it, signed in as
-- authenticated (src/pages/InventoryPage.tsx handleAdjust and
-- src/components/inventory/BatchAdjustModal.tsx, both always send a
-- crypto.randomUUID()-derived p_idempotency_key); this file changes no grant,
-- so the ACL installed by 20260911120000 stands and the postflight re-asserts
-- it; no SQL function, cron job or edge function calls it.
--
-- DEFECT (gpt-5.6-sol exact-SHA review of PR #727, Low; confirmed by the
-- rls-security-reviewer). 20260911120000 — APPLIED LIVE 2026-09-20 under ledger
-- version 20260920052149 — introduced this key check:
--     IF p_idempotency_key IS NULL
--        OR p_idempotency_key !~ '[^[:space:]]'
--        OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
-- and a comment claiming it refuses "non-printable" keys. It does not. The
-- third test requires only that the key carry AT LEAST ONE printable ASCII
-- character; it says nothing about the other characters. A key such as a UUID
-- with a trailing newline satisfies it and is accepted, so a control character
-- can reach the receipt table, the error text and the logs.
-- SEVERITY, stated honestly: this is a hygiene gap, not a live defect. Both
-- browser callers derive the key from crypto.randomUUID(), which cannot produce
-- a control character, and a caller who wants to write a strange key of their
-- own is already an authenticated active admin by the time this line runs.
-- Measured on live 2026-09-20: ZERO adjust_inventory receipts exist at all, and
-- none with a control-character or non-ASCII-only key.
--
-- SOURCE: the installed body (read-only from pg_proc on 2026-09-20, after the
-- 20260911120000 apply) is SECURITY DEFINER, owner postgres, plpgsql,
-- search_path=public, pg_temp, exactly one overload, prosrc 4334 characters,
-- LF only, sha256
--   9a503e549f42ad54fd9309d4843bab18f646731e5896c015734a61f524ca0af3
-- which is byte-identical to the body emitted by
-- supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql
-- as it stands on main at 17826e9c3. The repo and production agree.
--
-- CHANGE: exactly one block of the body differs from the installed body — the
-- key check gains `OR p_idempotency_key COLLATE "C" ~ '[[:cntrl:]]'` and its
-- comment is corrected. Everything else, including the fingerprint, the
-- check_idempotency_intent call, the stock math, the ledger row and the bound
-- receipt INSERT, is reproduced verbatim. No argument, default, return shape or
-- error message changes, so no frontend change is required.
--
-- SCOPE OF THE REFUSAL, stated as MEASURED. The old comment overclaimed
-- ("non-printable"); the first draft of THIS comment underclaimed by saying C1
-- controls still pass. Measured on PostgreSQL 17 and confirmed read-only on
-- live 2026-09-20, [[:cntrl:]] matches 64 code points in two ranges:
--   U+0001-U+001F (C0), U+007F (DEL), and U+0080-U+009F (the whole C1 block).
-- U+0000 is not reachable at all: PostgreSQL text rejects a null byte outright,
-- so naming it as the low end of the range would be dead precision.
-- Therefore C1 controls -- U+0085 NEL among them -- ARE refused. What is NOT
-- refused, and still passes so long as the key also carries a printable ASCII
-- character: NBSP (U+00A0), ZWSP (U+200B), BOM (U+FEFF), U+2028 and the soft
-- hyphen (U+00AD). Each of those five was measured on live, not assumed.
-- The COLLATE "C" is defensive pinning, NOT the cause of that set: the class
-- matches the same 64 code points under the database default collation
-- (en_US.UTF-8, libc). PostgreSQL hardwires the POSIX class ranges, so a
-- collation change cannot silently widen or narrow this check.
--
-- ONE SUBSUMED TEST, deliberately left in place. `!~ '[^[:space:]]'` is now
-- subsumed by `COLLATE "C" !~ '[!-~]'`: a key with no non-whitespace character
-- has no [!-~] character either, because [!-~] excludes the space. The body
-- carries a comment saying which of the two is safe to delete. Removing the
-- [!-~] test instead would reopen the hole it closes — a key made only of
-- non-ASCII text.
--
-- NO CUTOVER LOCK, and this is the deliberate difference from 20260911120000.
-- That migration took LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE
-- MODE because the body it replaced wrote UNBOUND receipts, so an old-body call
-- caught mid-flight had to be stopped. Here the installed body already writes
-- bound receipts and the trigger
-- refuse_unbound_adjust_inventory_receipt_20260911 already exists and stays
-- untouched, so a call in flight during this swap is harmless: it writes a
-- bound receipt the trigger accepts. Taking the lock anyway would stall EVERY
-- mutating RPC in the app, because they are all keyed and all touch that table.
-- This migration therefore takes no table lock and does not pause app saving.
-- The only in-flight effect, stated fully rather than waved past: a call that
-- slips through mid-swap can still accept a control-character key and commit a
-- receipt under it. That receipt is then PERMANENTLY UNREPLAYABLE — a retry on
-- the same key now hits IDEMPOTENCY_KEY_REQUIRED instead of its committed
-- result. That is precisely the stranding PREFLIGHT_STRANDED_RECEIPTS exists to
-- prevent, and the preflight's SELECT takes no lock, so it cannot cover the
-- window between its own snapshot and COMMIT. Blast radius is ONE stranded
-- retry: it errors before any mutation, so no double stock change and no
-- duplicate ledger row. Unreachable in practice, because no caller in this app
-- can produce such a key — but it is a real residual, not "no correctness
-- risk", and closing it would cost the app-wide write pause this migration is
-- deliberately avoiding. That trade is the decision being made here.
--
-- RESIDUAL, KNOWN AND ACCEPTED: a NaN already stored in
-- inventory.quantity_available is NOT repaired by this migration or by
-- 20260911120000. Both refuse a NaN or infinite p_delta going forward, but the
-- column still has no CHECK constraint, so a value written by the pre-20260911
-- body keeps propagating through every later adjustment of that row (NaN plus
-- anything is NaN). The structural fix is the parked
-- scripts/.staging-migrations/20260813030000_reject_non_finite_money_and_quantities.sql.
-- Read-only check, before or after this applies:
--   SELECT id, product_id, quantity_available FROM public.inventory
--    WHERE quantity_available = 'NaN'::numeric;
-- There should be no rows.
--
-- Atomicity: no BEGIN/COMMIT of its own. Apply ONLY through
-- scripts/apply-migration-file.mjs (or psql -1), which wraps the whole file in
-- one transaction.
--
-- PREFLIGHT: check_idempotency_intent(text,text,uuid,text) and
-- extensions.digest(bytea,text) installed; exactly one overload of
-- adjust_inventory; owner postgres, plpgsql, SECURITY DEFINER,
-- search_path=public, pg_temp; VOLATILE, non-strict and non-leakproof (none of
-- those three live in prosrc, so ALTER FUNCTION can change them without moving
-- the body hash, and a replace that does not restate them silently resets them
-- to defaults — they are pinned separately for that reason); the full argument
-- list INCLUDING DEFAULTS equals the pinned string; prosrc sha256
-- (CRLF-normalized) equal to the pinned installed body, or on a re-run to the
-- body this file emits — anything else (a later hotfix) is refused; and, on a
-- FIRST run only, ZERO unexpired (or NULL-expiry) adjust_inventory receipts
-- whose key this migration would newly reject, so applying can never strand a
-- live retry. That last check is skipped on a re-run: the body is already
-- correct there and the operator has no action left but to wait, so enforcing
-- it would make the advertised re-run path unusable.
-- POSTFLIGHT: one overload, pinned argument list, postgres-owned SECURITY
-- DEFINER with the pinned search_path; the installed body carries NO CR bytes
-- (checked BEFORE the hash, which normalizes CRLF away and therefore cannot
-- see them); installed body sha256 equals the body
-- this file emits; the auth and role gates are PRESENT and both sit before the
-- receipt lookup; the legacy key-only helpers are absent; the receipt carries
-- both binding columns; the control-character test is present; ACL — anon
-- cannot execute, authenticated and service_role can; and the
-- 20260911120000 cutover trigger is still registered, BEFORE INSERT FOR EACH
-- ROW, and enabled.
-- ROLLBACK: a NEW forward migration re-emitting the 9a503e54… body. Nothing
-- else is touched, so nothing else needs undoing.
-- PROOF: scripts/smoke/prove-adjust-inventory-control-character-keys.mjs
-- (network-disabled throwaway Supabase PostgreSQL 17 image on the checked-in
-- 2026-07-27 baseline plus every later migration) and the rolled-back chain
-- scripts/smoke/smoke-adjust-inventory-control-character-keys.sql.
-- ============================================================================

DO $preflight$
DECLARE
  v_sig      text := 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
  v_oid      oid;
  v_count    integer;
  v_owner    text;
  v_lang     text;
  v_secdef   boolean;
  v_config   text[];
  v_src      text;
  v_sha      text;
  v_args     text;
  v_stranded integer;
  v_volatile "char";
  v_strict   boolean;
  v_leakproof boolean;
  v_rerun    boolean := false;
  v_args_pin text := 'p_inventory_id uuid, p_delta numeric, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text';
  -- sha256 of the body installed live by 20260911120000 (read 2026-09-20) and
  -- of the body THIS file emits, both CRLF-normalized. The constants live here,
  -- not in the body, so declaring them does not change the value they pin.
  v_installed_pin text := '9a503e549f42ad54fd9309d4843bab18f646731e5896c015734a61f524ca0af3';
  v_new_pin       text := '841eededd4b3ced161c8379752a6561c446a121a3a20c10061a22ebb8e9579c8';
BEGIN
  IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: public.check_idempotency_intent(text, text, uuid, text) is not installed (20260811130000).';
  END IF;
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: extensions.digest(bytea, text) is not installed (pgcrypto).';
  END IF;

  v_oid := to_regprocedure(v_sig);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_MISSING: % is not installed. This migration replaces an existing body; it does not create one.', v_sig;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'adjust_inventory';
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload of adjust_inventory in public, found %. Reconcile before applying.',
      v_count;
  END IF;

  SELECT r.rolname, l.lanname, p.prosecdef, p.proconfig, p.prosrc,
         p.provolatile, p.proisstrict, p.proleakproof
    INTO v_owner, v_lang, v_secdef, v_config, v_src,
         v_volatile, v_strict, v_leakproof
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = v_oid;

  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'PREFLIGHT_OWNER: % is owned by %, expected postgres.', v_sig, v_owner;
  END IF;
  IF v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'PREFLIGHT_LANGUAGE: % is %, expected plpgsql.', v_sig, v_lang;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PREFLIGHT_SECURITY: % is not SECURITY DEFINER.', v_sig;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'PREFLIGHT_SEARCH_PATH: % has proconfig %, expected {search_path=public, pg_temp}.', v_sig, v_config;
  END IF;
  -- Volatility, strictness and leakproofness are NOT part of prosrc, so
  -- ALTER FUNCTION can change any of them without moving the body hash below —
  -- the pin cannot see such a hotfix, and a CREATE OR REPLACE that does not
  -- restate them silently resets them to the defaults. Pin them separately.
  IF v_volatile <> 'v' OR v_strict OR v_leakproof THEN
    RAISE EXCEPTION
      'PREFLIGHT_ATTRIBUTES: % has provolatile=%, proisstrict=%, proleakproof=%, expected v/false/false. Something altered the function outside its body; reconcile before replacing it.',
      v_sig, v_volatile, v_strict, v_leakproof;
  END IF;

  -- Only the reviewed installed body (first run) or this file's own body
  -- (re-run) may be replaced. A later hotfix to either is refused, so replaying
  -- this file can never silently revert it.
  v_sha := encode(
    extensions.digest(convert_to(replace(v_src, E'\r\n', E'\n'), 'UTF8'), 'sha256'), 'hex');
  IF v_sha = v_installed_pin THEN
    RAISE NOTICE 'adjust_inventory: installed body is the pinned 20260911120000 body; replacing it.';
  ELSIF v_sha = v_new_pin THEN
    v_rerun := true;
    RAISE NOTICE 'adjust_inventory: installed body is already this file''s body; re-running.';
  ELSE
    RAISE EXCEPTION
      'PREFLIGHT_BODY: % has prosrc sha256 %, which is neither the pinned installed body nor the body this file emits. Re-verify the live definition before replacing it.',
      v_sig, v_sha;
  END IF;

  -- prosrc excludes argument defaults, so pin them separately.
  v_args := pg_get_function_arguments(v_oid);
  IF v_args <> v_args_pin THEN
    RAISE EXCEPTION 'PREFLIGHT_ARGS: % has argument list "%", expected "%".', v_sig, v_args, v_args_pin;
  END IF;

  -- A live retry must never be stranded. A receipt whose key this migration
  -- would newly reject could still be replayed by the installed body today, but
  -- not after this applies: the caller would get IDEMPOTENCY_KEY_REQUIRED
  -- instead of their committed result. Refuse while any such receipt can still
  -- be redeemed. A NULL expires_at is never cleaned up, so it counts too.
  -- Measured on live 2026-09-20: zero adjust_inventory receipts of any kind.
  --
  -- Skipped on a re-run. Once the new body is installed the damage this guard
  -- prevents is already done or already impossible, and the operator has no
  -- action left but to wait — so aborting a re-run of an ALREADY-CORRECT
  -- function on this condition would make the advertised re-run path a lie.
  IF NOT v_rerun THEN
    SELECT count(*) INTO v_stranded
      FROM public.idempotency_keys
     WHERE operation = 'adjust_inventory'
       AND (expires_at IS NULL OR expires_at > now())
       AND idempotency_key COLLATE "C" ~ '[[:cntrl:]]';
    IF v_stranded > 0 THEN
      RAISE EXCEPTION
        'PREFLIGHT_STRANDED_RECEIPTS: % unexpired adjust_inventory receipt(s) carry a control-character key and would stop replaying. Wait for them to expire (<= 24h) and re-run; never delete live receipts.',
        v_stranded;
    END IF;
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $adjust$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_inv record;
  v_new_qty numeric;
  v_result jsonb;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at, so
  -- holding someone else's key is not enough to read their result.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;
  -- The caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must be the signed-in user';
  END IF;
  -- NULL-safe and active-only: a missing or deactivated profile is refused.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins can adjust inventory';
  END IF;

  -- Every adjustment gets a receipt a retry can find. Blank, whitespace-only
  -- and control-character keys are refused before any work. Scope stated as
  -- MEASURED, because "non-printable" overclaimed and a first draft of this
  -- comment underclaimed: PostgreSQL hardwires the POSIX control class to 64
  -- code points -- U+0001 to U+001F, DEL (U+007F), and the whole C1 block
  -- U+0080 to U+009F. (U+0000 cannot occur: PostgreSQL text rejects a null byte
  -- outright.) So C1 controls ARE refused. NBSP, ZWSP, BOM, U+2028 and the soft
  -- hyphen are NOT, and still pass so long as the key also carries a printable
  -- ASCII character.
  -- The COLLATE "C" is defensive pinning, not what produces that set: the class
  -- matches the same 64 code points under the database default collation.
  -- The class literal appears EXACTLY ONCE in this body -- on the refusal line
  -- below -- and the postflight COUNTS it rather than testing for its presence.
  -- Never name the class in a comment here. An earlier draft did, and a
  -- mutation run on 2026-09-20 proved that it DEFEATED the guard: deleting the
  -- real check left the comment behind, the presence test still found the
  -- token, and a body with no control-character refusal passed every postflight
  -- check.
  IF p_idempotency_key IS NULL
     -- Subsumed by the [!-~] test below, which is the load-bearing one: a key
     -- with no non-whitespace character has no [!-~] character either, because
     -- [!-~] excludes the space. If this pair is ever tidied, delete THIS line;
     -- deleting the next one reopens the hole, because it is what refuses a key
     -- made only of non-ASCII text.
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]'
     OR p_idempotency_key COLLATE "C" ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: adjust_inventory requires p_idempotency_key';
  END IF;

  -- numeric accepts NaN and +/-Infinity. NaN sorts above every number, so it
  -- would pass the negative-stock check below and be written into
  -- quantity_available, which has no CHECK constraint.
  IF p_delta IS NULL
     OR p_delta IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT_QUANTITY: the adjustment must be a finite number';
  END IF;
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  -- Everything that shapes the adjustment. p_performed_by is left out: the
  -- guard above constrains it to {NULL, actor} and the ledger row is stamped
  -- from auth.uid(), so it cannot change the outcome. That omission DEPENDS on
  -- the ACTOR_MISMATCH guard; if it is ever relaxed, p_performed_by must join
  -- the fingerprint. trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'inventory_id', p_inventory_id,
    'delta', trim_scale(p_delta),
    'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction:
  -- a racing same-key call waits here, then replays. Replays only a receipt
  -- bound to THIS actor and THIS request.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'adjust_inventory', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- The adjustment itself, unchanged from the live body.
  SELECT * INTO v_inv FROM public.inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  v_new_qty := v_inv.quantity_available + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Adjustment would result in negative inventory (current: %, delta: %, result: %)',
      v_inv.quantity_available, p_delta, v_new_qty;
  END IF;

  UPDATE public.inventory SET
    quantity_available = v_new_qty,
    updated_at = now()
  WHERE id = p_inventory_id;

  INSERT INTO public.inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, v_actor,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'adjust_inventory', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$adjust$;

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_sig      text := 'public.adjust_inventory(uuid,numeric,text,uuid,text)';
  v_args_pin text := 'p_inventory_id uuid, p_delta numeric, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text';
  v_new_pin  text := '841eededd4b3ced161c8379752a6561c446a121a3a20c10061a22ebb8e9579c8';
  v_count integer;
  v_src   text;
  v_sha   text;
  v_role  text;
  v_cntrl_hits integer;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: % is not installed.', v_sig;
  END IF;
  IF pg_get_function_arguments(to_regprocedure(v_sig)) <> v_args_pin THEN
    RAISE EXCEPTION 'POSTFLIGHT_ARGS: % has argument list "%", expected "%".',
      v_sig, pg_get_function_arguments(to_regprocedure(v_sig)), v_args_pin;
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'adjust_inventory';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: adjust_inventory has % overloads, expected 1.', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = to_regprocedure(v_sig)
       AND r.rolname = 'postgres'
       AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SHAPE: % is not a postgres-owned SECURITY DEFINER function with search_path=public, pg_temp.', v_sig;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(v_sig);
  -- CR bytes first, because the pin below CANNOT see them: it normalizes
  -- \r\n to \n before digesting, so a CRLF working tree installs CR bytes into
  -- live prosrc and still matches. Without this assertion the eol=lf pin in
  -- .gitattributes would be the ONLY defense, and a .gitattributes pin governs
  -- future checkouts, not a tree that already holds the file with CRLF.
  IF position(E'\r' IN v_src) > 0 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_CR_BYTES: the installed adjust_inventory body carries % CR byte(s). The working tree was checked out with CRLF; re-checkout or `git add --renormalize` this file and re-apply.',
      length(v_src) - length(replace(v_src, E'\r', ''));
  END IF;
  v_sha := encode(
    extensions.digest(convert_to(replace(v_src, E'\r\n', E'\n'), 'UTF8'), 'sha256'), 'hex');
  IF v_sha <> v_new_pin THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY_PIN: adjust_inventory body sha256 is %, expected the % this file emits.', v_sha, v_new_pin;
  END IF;

  -- The inherited guarantee: the auth and role gates must be PRESENT and must
  -- come before the receipt lookup, and the legacy key-only lookup must be
  -- gone. Presence is tested first and separately, because position() returns 0
  -- for an absent token and 0 is never greater than a positive position — an
  -- ordering test ALONE would pass a body that never authenticates at all.
  IF position('public.check_idempotency_intent(' IN v_src) = 0
     OR position('AUTH_REQUIRED' IN v_src) = 0
     OR position('INSUFFICIENT_ROLE' IN v_src) = 0
     OR position('AUTH_REQUIRED' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('INSUFFICIENT_ROLE' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
     OR position('check_idempotency(' IN v_src) > 0
     OR position('save_idempotency(' IN v_src) > 0
     OR position('request_actor_id, request_fingerprint' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: the installed adjust_inventory does not authenticate and role-check before its bound receipt lookup.';
  END IF;

  -- The fix itself. The body pin above already proves byte-equality, so this is
  -- belt-and-braces against a future edit that keeps the pin in step but drops
  -- the test: it names the thing this migration exists to add.
  --
  -- COUNTED, not merely present, and that distinction is not theoretical. A
  -- mutation run on 2026-09-20 removed the real refusal and recomputed both
  -- pins; a bare presence test still PASSED, because an earlier draft of the
  -- body comment mentioned the class by name and that mention satisfied it. A
  -- substring test over a body that also documents itself proves nothing. So:
  -- the class must appear EXACTLY ONCE, and that one occurrence must be the
  -- refusal itself, matched with its operand and operator.
  v_cntrl_hits := (length(v_src) - length(replace(v_src, '[[:cntrl:]]', '')))
                  / length('[[:cntrl:]]');
  IF v_cntrl_hits <> 1 THEN
    RAISE EXCEPTION
      'POSTFLIGHT_CONTROL_CHAR: expected the control class exactly once in the installed adjust_inventory body (the refusal itself), found %. A comment naming the class defeats this check — keep it out of comments.',
      v_cntrl_hits;
  END IF;
  IF position('OR p_idempotency_key COLLATE "C" ~ ''[[:cntrl:]]''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_CONTROL_CHAR: the installed adjust_inventory does not refuse control-character idempotency keys.';
  END IF;

  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ACL: anon can execute %.', v_sig;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_ACL: % cannot execute %.', v_role, v_sig;
    END IF;
  END LOOP;

  -- 20260911120000's cutover trigger is not touched here, and must survive.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.idempotency_keys'::regclass
       AND t.tgname = 'refuse_unbound_adjust_inventory_receipt_20260911'
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
       AND t.tgtype = 7  -- FOR EACH ROW (1) | BEFORE (2) | INSERT (4)
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_TRIGGER: refuse_unbound_adjust_inventory_receipt_20260911 is missing, disabled or no longer BEFORE INSERT FOR EACH ROW on idempotency_keys.';
  END IF;
END
$verify$;

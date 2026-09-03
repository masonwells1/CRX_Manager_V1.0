-- ============================================================================
-- F06: persist WHICH FIELD THE OPERATOR TYPED on a chemical line (job_chemicals.driver)
-- ----------------------------------------------------------------------------
-- STATUS: NOT APPLIED
-- (This status line goes stale at apply time; the ledger is authoritative.)
--
-- PLAIN ENGLISH. On a chemical line the app lets the operator type EITHER the rate per
-- acre OR the total quantity, and fills in the other one (quantity = rate x acres). The
-- saved row never recorded which one was typed. So when a saved job is reopened and its
-- acres change, the line cannot know whether to hold the rate or hold the total; it holds
-- both, they disagree, save_job correctly refuses with CHEM_QUANTITY_NOT_DERIVED, and the
-- WHOLE job save rolls back with no on-screen warning. KNOWN_ISSUES entry
-- "OPEN 2026-09-01 -- F06". The tried-and-reverted alternative (guess the driver from
-- quantity == rate x acres) is unsound because a typed total satisfies that same equality
-- by construction (Codex P1, 2026-08-20); do not reintroduce it anywhere.
--
-- WHAT THIS CHANGES:
--   1. job_chemicals gains a nullable text column `driver` restricted by CHECK to
--      'rate' | 'qty' | NULL. NULL = unknown: every pre-F06 row (4 live rows, read
--      read-only 2026-09-03) and every row written by the two other writers
--      (20260703200000 close-quote-as-applied, 20260618230000 recipe pricing) stays NULL,
--      and the client leaves a NULL row exactly as saved -- today's safe behaviour.
--   2. save_job is re-emitted with the applied 20260820120000 body plus ONLY these deltas:
--      a `v_driver` variable; a validation at the top of the chemical loop that refuses
--      CHEM_DRIVER_INVALID (the thirteenth refusal) on any value other than NULL, '',
--      'rate' or 'qty'; `driver` added to the job_chemicals INSERT; the body marker bumped
--      chem_unit_invariant_v2 -> chem_unit_invariant_v3; and two comments updated.
--      NO refusal reads the driver and the derived money totals are untouched.
--   3. The function COMMENT is re-issued from the live text (20260826150000) with the
--      count corrected to THIRTEEN and the new refusal described.
--
-- WHAT THIS DOES NOT CHANGE: no data is rewritten, no row is deleted, no grant moves,
-- no other function is touched. The idempotency fingerprint already hashes whole chemical
-- elements, so a keyed retry with a changed driver is a changed intent with no new code.
--
-- PREFLIGHT PINS. Refuses to run unless the installed save_job body is byte-for-byte one
-- of exactly two bodies: the one reviewed here as the starting point (md5 227ab7b6bc2023724adf6952a221d2a8,
-- the 20260820120000 body, read live 2026-09-03 with no CR bytes and octet_length 75699),
-- or the one this file itself installs (md5 18d08d5f40aea91fe13ac3e5a686c549, octet_length 78120),
-- which is what makes a replay an identical reinstall. The replay arm is the EXACT
-- candidate hash and NOT the marker: keying a replay on marker presence would let this
-- file, replayed after a later hotfix that kept the marker, silently revert that hotfix on
-- a money-mutating RPC (gpt-5.6-sol exact-SHA review, 2026-09-03, HIGH). The marker still
-- exists so that 20260820120000 refuses to replay over THIS body.
--
-- COLUMN-DRIFT PIN. On a FRESH apply (the installed save_job is the reviewed starting
-- body, not this file's own) job_chemicals.driver and job_chemicals_driver_chk must both be
-- ABSENT: ADD COLUMN IF NOT EXISTS preserves whatever an unknown column already holds, and
-- even an exact-shaped column carrying legacy rows marked 'rate' would hand the client false
-- provenance -- precisely the silent rewrite of a hand-typed total this column exists to
-- prevent. Only a REPLAY (installed body = this file's candidate md5) may find them, and then
-- only in exactly the shape this file creates: nullable text, no default, not generated, and
-- the CHECK text verbatim (same review, HIGH x2 across two rounds). Checked BEFORE the ALTER,
-- in the same transaction. The idempotency binding-column assertion from 20260820120000 is
-- carried over as well (MEDIUM).
--
-- The pins, the ALTER and the replacement share one transaction, so a refused apply
-- leaves the column absent and the body untouched.
--
-- PROOF: scripts/smoke/prove-save-job-persist-driver.mjs (throwaway PostgreSQL 17
-- container; both pins, drift refusal + atomicity, staged column/constraint drift refused,
-- apply, replay, a modified-but-marked body refused on replay, the existing T1-T66
-- behaviour tests against the v3 body, the new driver tests, and named mutants).
--
-- ROLLBACK: re-issue the 20260820120000 CREATE OR REPLACE (its body is still byte-exact in
-- that file) and `ALTER TABLE public.job_chemicals DROP COLUMN driver`. The client tolerates
-- an absent column (it reads driver only when present), so the frontend need not roll back
-- first. Dropping the column loses nothing money-related: it is never read by any refusal,
-- total, invoice or report.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. COLUMN-DRIFT PIN. Runs before anything is created. A pre-existing column or
--    constraint is accepted only in exactly the shape this file creates.
-- ----------------------------------------------------------------------------
DO $coldrift$
DECLARE
  v_body_md5 text;
  v_col      boolean;
  v_type     text;
  v_notnull  boolean;
  v_gen      "char";
  v_hasdef   boolean;
  v_def      text;
BEGIN
  SELECT md5(p.prosrc) INTO v_body_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');

  SELECT true, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attgenerated, a.atthasdef
    INTO v_col, v_type, v_notnull, v_gen, v_hasdef
    FROM pg_attribute a
   WHERE a.attrelid = 'public.job_chemicals'::regclass
     AND a.attname = 'driver' AND NOT a.attisdropped;
  v_col := COALESCE(v_col, false);

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.job_chemicals'::regclass
     AND c.conname  = 'job_chemicals_driver_chk';

  -- A FRESH apply (the installed body is not this file's own) must find NEITHER the column
  -- NOR the constraint. ADD COLUMN IF NOT EXISTS preserves whatever an unknown column
  -- already holds, so an exact-shaped column carrying legacy rows already marked 'rate' or
  -- 'qty' would pass a shape check and hand the client false provenance -- it would then
  -- re-derive quantities on the next acreage edit from a driver nobody typed (gpt-5.6-sol
  -- exact-SHA review, 2026-09-03, HIGH). Only a REPLAY, recognised by the exact candidate
  -- body md5, may find the column, and then only in exactly the shape this file creates.
  IF v_body_md5 IS DISTINCT FROM '18d08d5f40aea91fe13ac3e5a686c549' AND (v_col OR v_def IS NOT NULL) THEN
    RAISE EXCEPTION
      'PREFLIGHT_COLUMN_DRIFT: job_chemicals.driver (present: %) or job_chemicals_driver_chk (present: %) already exists while the installed save_job body (md5 %) is not the one this file installs. A column this migration did not create may hold values it cannot vouch for; reconcile by hand before applying.',
      v_col, (v_def IS NOT NULL), COALESCE(v_body_md5, '<none>');
  END IF;

  IF v_col THEN
    IF v_type <> 'text' OR v_notnull OR v_gen <> '' OR v_hasdef THEN
      RAISE EXCEPTION
        'PREFLIGHT_COLUMN_DRIFT: job_chemicals.driver already exists but not in the shape this migration creates (type %, not null %, generated "%", has default %). Expected nullable text with no default. A drifted column would mislabel every legacy row; reconcile it by hand before applying.',
        v_type, v_notnull, v_gen, v_hasdef;
    END IF;
  END IF;

  IF v_def IS NOT NULL AND v_def IS DISTINCT FROM 'CHECK (((driver IS NULL) OR (driver = ANY (ARRAY[''rate''::text, ''qty''::text]))))' THEN
    RAISE EXCEPTION
      'PREFLIGHT_COLUMN_DRIFT: job_chemicals_driver_chk already exists with a different definition (%). Expected exactly: CHECK (((driver IS NULL) OR (driver = ANY (ARRAY[''rate''::text, ''qty''::text]))))',
      v_def;
  END IF;
END
$coldrift$;

-- ----------------------------------------------------------------------------
-- 1. The column. Additive and nullable; the CHECK is added idempotently so a replay of
--    this file is safe. No default: NULL is the honest value for every existing row.
-- ----------------------------------------------------------------------------
ALTER TABLE public.job_chemicals ADD COLUMN IF NOT EXISTS driver text;

DO $col$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.job_chemicals'::regclass
       AND conname  = 'job_chemicals_driver_chk'
  ) THEN
    ALTER TABLE public.job_chemicals
      ADD CONSTRAINT job_chemicals_driver_chk
      CHECK (driver IS NULL OR driver IN ('rate', 'qty'));
  END IF;
END
$col$;

COMMENT ON COLUMN public.job_chemicals.driver IS
  'F06 (2026-09-03): which field the operator TYPED on this line in the job chemical grid -- ''rate'' (the per-acre rate was typed and the quantity was derived as rate x acres) or ''qty'' (the total was typed and the rate was back-solved). NULL = unknown: rows saved before this column existed and rows written by the close-quote and recipe paths. The client re-derives the OTHER side when the job''s acreage changes only when this is set; a NULL row is left exactly as saved, because guessing from quantity == rate x acres is unsound (a typed total satisfies it by construction). Read by no refusal, no money total, no invoice and no report.';

-- ----------------------------------------------------------------------------
-- 2. PREFLIGHT PIN. Same shape as 20260820120000: the check and the replacement share one
--    transaction, so a refusal is atomic with the ALTER above.
-- ----------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_oid   oid;
  v_count integer;
  v_src   text;
BEGIN
  v_oid := to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING: the six-argument job-save RPC is not installed. This migration replaces a body; it does not create one.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = (SELECT proname FROM pg_proc WHERE oid = v_oid);
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_OVERLOAD: expected exactly 1 overload of the job-save RPC in public, found %. Reconcile before applying this migration.', v_count;
  END IF;

  -- The replacement body calls these at RUN time; assert them at apply time (unchanged
  -- from 20260820120000, kept because a rebuilt database is where they would bite).
  IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: public.check_idempotency_intent(text, text, uuid, text) is not installed, and the replacement body calls it on every keyed save.';
  END IF;
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: extensions.digest(bytea, text) is not installed (pgcrypto), and the replacement body hashes the request fingerprint with it.';
  END IF;

  -- Binding columns. The replacement body still binds every keyed receipt to the actor and
  -- the request fingerprint; without them that UPDATE fails at run time on the first keyed
  -- save. Carried over from 20260820120000 (dropping it was a MEDIUM in the 2026-09-03
  -- gpt-5.6-sol review).
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.idempotency_keys'::regclass
       AND attname IN ('request_fingerprint', 'request_actor_id')
       AND NOT attisdropped
     GROUP BY attrelid HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_HELPER: idempotency_keys is missing request_fingerprint / request_actor_id, which the replacement binds on every keyed save.';
  END IF;

  -- The column this body now writes must exist. It was added three statements up in this
  -- same transaction, so this can only fail on a hand-edited copy of the file.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.job_chemicals'::regclass
       AND attname = 'driver' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'PREFLIGHT_MISSING_COLUMN: job_chemicals.driver is absent, and the replacement body inserts into it.';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;

  -- 227ab7b6bc2023724adf6952a221d2a8 is the applied 20260820120000 body (marker chem_unit_invariant_v2),
  -- read live 2026-09-03. The live text carries no CR bytes; do NOT normalise line endings
  -- before comparing. 18d08d5f40aea91fe13ac3e5a686c549 is the EXACT body this file installs (octet_length
  -- 78120), so a replay is accepted only over an identical body -- a hotfixed body that
  -- merely kept the v3 marker is refused here rather than silently reverted.
  IF md5(v_src) <> '227ab7b6bc2023724adf6952a221d2a8'
     AND md5(v_src) <> '18d08d5f40aea91fe13ac3e5a686c549' THEN
    RAISE EXCEPTION
      'PREFLIGHT_BODY_DRIFT: live body md5 is %, expected 227ab7b6bc2023724adf6952a221d2a8 (the reviewed 20260820120000 body) or 18d08d5f40aea91fe13ac3e5a686c549 (this file''s own body, for a replay). The job-save RPC changed out of band since review. Diff the live body against both and re-review; applying this migration now would silently revert that change.',
      md5(v_src);
  END IF;

  RAISE NOTICE 'PREFLIGHT_OK: job-save RPC body matches the reviewed pin; the replacement may proceed.';
END
$preflight$;

CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid,
  p_job_payload jsonb,
  p_fields jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_job_id uuid;
  v_is_new boolean := (p_job_id IS NULL);
  v_field jsonb;
  v_chem jsonb;
  v_share jsonb;
  v_field_id uuid;
  v_season integer;
  v_job_date date;
  v_existing jsonb;
  v_fingerprint text;
  v_result jsonb;
  v_share_total numeric;
  -- Chemical-unit invariant + derived totals (this migration).
  v_acres numeric;
  v_raw_rate_unit text;
  v_rate_base text;
  v_denom_probe text;
  v_denom_canon text;
  v_base_folded text;
  v_stock_canon text;
  v_qty_unit text;
  v_price_unit text;
  v_qty numeric;
  v_rate numeric;
  v_carried numeric;
  v_form text;
  v_product_name text;
  v_driver text;
  v_total_cost_cents bigint;
  v_total_price_cents bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency: replay with the same key returns the original result without
  -- creating a second job (the create-path double-submit hazard).
  --
  -- This now routes through the canonical check_idempotency helper family the rest
  -- of the app already uses -- specifically check_idempotency_intent, the same helper
  -- nine live money RPCs call today (the whole return family plus create/post/void
  -- commission payment; read read-only from pg_proc 2026-08-24). Round 8 landed the
  -- plain key+operation helper here and round 9 tightened it to the intent form; the
  -- reasoning for both is kept below rather than rewritten, because the round-8 hole
  -- is still the reason the raw lookup can never come back.
  -- The previous code -- carried unchanged from the live body, so this
  -- is a PRE-EXISTING defect this migration closes rather than one it caused --
  -- did its own unlocked lookup filtered to operation = 'save_job', and then
  -- recorded with ON CONFLICT (idempotency_key) DO NOTHING. The live uniqueness
  -- constraint is idempotency_keys_idempotency_key_key, on the KEY ALONE and NOT
  -- on (key, operation) -- read read-only 2026-08-24. Those two facts together
  -- are the bug: a key already spent by ANOTHER operation is invisible to a
  -- lookup filtered by operation, so the job is created, the receipt INSERT is
  -- swallowed by the conflict, and the NEXT retry with that key finds nothing
  -- again and creates a SECOND JOB. A duplicate job is a duplicate bill.
  -- Two callers racing on one key could likewise both pass the unlocked lookup.
  --
  -- check_idempotency closes both: it takes pg_advisory_xact_lock on the key, so
  -- concurrent callers serialize, and it RAISES IDEMPOTENCY_CROSS_OP_KEY_REUSE
  -- rather than letting a foreign key silently through. Found by the exact-SHA
  -- gpt-5.6-sol proof gate (2026-08-24); Mason approved closing it here rather
  -- than in a follow-up, because a second migration replacing this same body is
  -- the non-atomic hazard round 3 already caught. No grant change is needed:
  -- check_idempotency is executable by postgres and service_role only, and this
  -- function is SECURITY DEFINER owned by postgres, so the inner call runs with
  -- the owner's rights. T26 pins the cross-operation refusal, T27 the replay.
  -- ROUND 9: bound to the ACTOR and to a FINGERPRINT of what was actually asked for,
  -- not merely to the key. check_idempotency alone still let a completed key be reused
  -- for a DIFFERENT job or a CHANGED payload: it matches on the key, so the caller got
  -- back the earlier success and the current request was never saved. The operator sees
  -- "saved" while the edited quantities, cents or job details went nowhere.
  --
  -- Reachability, stated honestly because the gate overstated it: the gate said the
  -- client key is "retained after uncertain failures". It is not. There is exactly one
  -- live caller (src/pages/JobDetail.tsx:2210) and runJobSave calls resetKey() at the
  -- START of every save attempt as well as after a success, so the ordinary UI mints a
  -- fresh key per attempt and cannot reach the silent-no-op. What remains real is the
  -- hardening gap itself -- any caller presenting a spent key gets the old result -- and
  -- that is worth closing on a SECURITY DEFINER money path regardless of today's client.
  --
  -- Like the rest of this block, the weakness is PRE-EXISTING: the live body binds
  -- nothing either. Mason approved closing it here (2026-08-24) rather than in a
  -- follow-up migration.
  --
  -- extensions.digest, not digest: pgcrypto is installed in the `extensions` schema
  -- (read read-only 2026-08-24) and this function pins search_path to public, pg_temp,
  -- so an unqualified call would not resolve at run time.
  --
  -- The arrays are canonicalised by sorting their elements before hashing, so a resend
  -- that merely reorders the chemical or field rows is still recognised as the SAME
  -- intent. jsonb already normalises object key order, so only array order needed it.
  --
  -- The claimed totals inside p_job_payload are deliberately left IN the fingerprint
  -- even though the money is derived and they are ignored: two requests that differ
  -- there are different requests, and failing closed is the safe direction.
  --
  -- Lock ordering is unchanged by this swap. check_idempotency and
  -- check_idempotency_intent take the SAME transaction-scoped advisory lock on the same
  -- key, at the same point -- before any business write -- so save_job acquires locks in
  -- the same order it always did. (20260819232000 warns that moving save_quote or
  -- convert_quote_to_order onto the intent helper needs a fresh same-key deadlock
  -- review; save_job is not named there, and it takes no barrier or row lock ahead of
  -- this point.)
  IF p_idempotency_key IS NOT NULL THEN
    v_fingerprint := encode(
      extensions.digest(
        convert_to(
          jsonb_build_object(
            'actor_id',   v_actor,
            -- p_performed_by is fingerprinted SEPARATELY from v_actor because it is a
            -- DIFFERENT input with a different effect: it is written to jobs.created_by at
            -- the INSERT below, so it is the audit identity the row ends up carrying. Line
            -- 337 only refuses it when it is non-NULL AND disagrees with the caller, so
            -- flipping it between NULL and the authenticated actor passes that check while
            -- changing what gets recorded. Omitted from the fingerprint, a retry on the same
            -- key with a changed p_performed_by replayed the earlier receipt and silently
            -- discarded the new audit identity -- the same silent-discard shape round 9
            -- fixed for the payload, missed here because this parameter is not part of the
            -- payload. Found by the gate on 2026-08-24 (MEDIUM).
            'performed_by', p_performed_by,
            'job_id',     p_job_id,
            'job_payload', COALESCE(p_job_payload, '{}'::jsonb),
            'fields', (
              SELECT COALESCE(jsonb_agg(e ORDER BY e::text), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) e
            ),
            'chemicals', (
              SELECT COALESCE(jsonb_agg(e ORDER BY e::text), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) e
            )
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    -- Returns NULL for a first call. On a valid replay it returns a WRAPPER --
    -- {"found": true, "result": ...} -- NOT the bare result that check_idempotency
    -- returns. Returning it unwrapped would hand the browser a payload shaped nothing
    -- like a save result, and assertRpcResult would reject it. Read from the installed
    -- body on 2026-08-24, not assumed from the name.
    v_existing := check_idempotency_intent(p_idempotency_key, 'save_job', v_actor, v_fingerprint);
    IF v_existing IS NOT NULL THEN
      IF v_existing -> 'result' IS NULL
         OR jsonb_typeof(v_existing -> 'result') IS DISTINCT FROM 'object'
         OR NULLIF(v_existing -> 'result' ->> 'job_id', '') IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      RETURN v_existing -> 'result';
    END IF;
  END IF;

  v_job_date := (p_job_payload->>'job_date')::date;
  -- U3 (Codex R2 P2): the live body used a JULY season cutoff (>= 7) while the
  -- system canon is Oct 1 (CLAUDE.md; create_job_from_quote_section and
  -- allocate_payment both use >= 10). transfer_job_to_invoice passes jobs.season
  -- to compute_application_service_fee for customer-specific rates, so a
  -- Jul-Sep job stamped into next season would look up the WRONG season's rate.
  -- Use the canonical live helper.
  v_season := compute_season(v_job_date);

  -- BODY MARKER: chem_unit_invariant_v3
  -- Do not remove or reword this string. The preflight pin at the top of this file keys
  -- its re-apply no-op on it, and any future revision of this body MUST bump the version
  -- suffix (v3 -> v4) so that replaying this migration is refused rather than silently
  -- reverting that revision. The previous token must not survive ANYWHERE in the body,
  -- not even in a comment: 20260820120000 keys its replay on finding its own marker text,
  -- so a stray mention would let that file replay over this body unrefused. (v2 -> v3 on
  -- 2026-09-03: F06, the calculator driver is now read from the payload and stored.) (v1 -> v2 on 2026-08-25, when round 26 added the
  -- punctuation-only folded-empty arm -- the drift reviewer caught that the revision had
  -- not bumped it, which would have let a pre-round-26 copy of this file replay over the
  -- revised body unrefused. No v1 body was ever applied anywhere, so no live or ledgered
  -- state distinguishes the two; the bump exists so that stays true.)
  -- ==========================================================================
  -- CHEMICAL UNIT INVARIANT. Runs BEFORE any write, so a refusal leaves the job
  -- exactly as it was. This predicate is SERVER-AUTHORED AND HAS NO SHIPPED CLIENT
  -- COUNTERPART -- see the retraction in the file header. An earlier draft of this
  -- comment claimed it mirrored chemLineBillingHazard condition for condition; that
  -- function does not exist on `main`, and the claim is retracted. Until PR #436
  -- lands there is NO on-screen warning before this refusal, which is precisely why
  -- that PR is an ordering prerequisite.
  --
  -- The acreage is the one the page uses: sumAcres(fieldRows), i.e. the sum of
  -- acres_to_treat over the fields being saved -- NOT p_job_payload.total_acres,
  -- which is caller-supplied and is exactly the kind of number this migration
  -- stops trusting.
  -- ==========================================================================
  SELECT COALESCE(SUM(COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0)), 0)
    INTO v_acres
    FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f;

  -- THE ACREAGE IS NOW VALIDATED, not merely summed, and round 24 is why (HIGH,
  -- gpt-5.6-sol, 2026-08-24). Every field acreage must be a finite, non-negative number.
  --
  -- Checked PER ELEMENT rather than on the total, because a negative acreage on one field
  -- can be cancelled by a positive one on another and a sum test would never see it. The
  -- range form also excludes NaN and Infinity in a single comparison, for the reason
  -- recorded throughout this file: numeric NaN sorts ABOVE every value, so `>= 0` admits it.
  --
  -- This is the residual earlier rounds recorded and left open -- job_fields.acres_to_treat
  -- carries no CHECK anywhere in the live schema -- closed on the RPC path. It does not
  -- replace the column constraint; it stops THIS entry point storing the shape.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_fields, '[]'::jsonb)) f
     WHERE NOT (COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0) >= 0
                AND COALESCE(NULLIF(f->>'acres_to_treat','')::numeric, 0) < 'Infinity'::numeric)
  ) THEN
    RAISE EXCEPTION
      'JOB_ACRES_NOT_FINITE: One of the fields on this job carries an acreage that is negative or not a number. Every field must carry a real, non-negative number of acres to treat.';
  END IF;

  FOR v_chem IN SELECT * FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) LOOP
    -- F06 (2026-09-03): WHICH FIELD THE OPERATOR TYPED on this line. The client's 3-way
    -- calculator back-solves the other field either way, so a saved (rate, quantity) pair
    -- is the same row whether the operator typed the rate or the total -- and on a later
    -- acreage change the client must know which side to hold. Stored, never interpreted
    -- here: none of the refusals below read it, and the money derivation is unchanged.
    -- NULL / '' means unknown (every pre-F06 row, and rows written by the close-quote and
    -- recipe paths, which never send it); the client leaves an unknown row exactly as
    -- saved. Anything else is REFUSED rather than coerced or dropped: a mis-attributed
    -- driver makes the client silently rewrite a hand-typed total on the next acreage
    -- change, which is the exact harm the column exists to prevent. Raised before any
    -- write, like every other refusal in this loop. The idempotency fingerprint above
    -- hashes whole chemical elements, so the driver is bound into it with no change.
    v_driver := NULLIF(v_chem->>'driver', '');
    IF v_driver IS NOT NULL AND v_driver NOT IN ('rate', 'qty') THEN
      v_product_name := NULL;
      IF COALESCE(v_chem->>'product_id', '') <> '' THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      END IF;
      RAISE EXCEPTION
        'CHEM_DRIVER_INVALID: % carries a calculator driver of "%", which is neither "rate" nor "qty", so the line cannot record which field was typed. Re-enter the rate per acre or the quantity on that line and save again.',
        COALESCE(v_product_name, 'This product'), v_driver;
    END IF;
    -- QUANTITY MUST BE FINITE AND NON-NEGATIVE, and it is checked FIRST -- ahead of every
    -- skip below, including the missing-product skip. A negative or non-finite quantity is
    -- a money defect in its own right, independent of the units: it flows into
    -- safe_cents_qty at the derived-totals step whether or not the units agree, so
    -- checking it only on the units path would leave the matching-units case open.
    --
    -- It also has to precede the product_id skip specifically, because the derived-totals
    -- SELECT sums EVERY element of p_chemicals -- including the ones this loop skips. With
    -- the check placed after that skip, a row carrying no product_id and a NaN quantity
    -- bypassed it entirely and then aborted inside safe_cents_qty with a raw "cannot
    -- convert NaN to bigint" instead of the operator-facing refusal. Fail-closed either
    -- way, but the wrong message (compliance review, round 3).
    --
    -- Written as a finite RANGE test, never as a NaN test. In PostgreSQL numeric, NaN is
    -- ordered ABOVE every other value, so `NaN > 0` is TRUE, and NaN is equal to itself,
    -- so `NaN <= NaN` is TRUE. A naive positivity test therefore admits NaN, and the
    -- tolerance comparison further down admits it a second time (Codex P1, round 3).
    v_qty := COALESCE(NULLIF(v_chem->>'quantity', '')::numeric, 0);
    IF NOT (v_qty >= 0 AND v_qty < 'Infinity'::numeric) THEN
      -- The name lookup is guarded: this arm now runs for rows with no product_id, and
      -- casting an empty string to uuid would replace the business error with a cast error.
      v_product_name := NULL;
      IF COALESCE(v_chem->>'product_id', '') <> '' THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      END IF;
      RAISE EXCEPTION
        'CHEM_QUANTITY_NOT_FINITE: % has a quantity of "%", which is not a finite, non-negative number, so it cannot be priced.',
        COALESCE(v_product_name, 'This product'), COALESCE(v_chem->>'quantity', '');
    END IF;

    -- A row with no product cannot have its UNITS checked: the conversion needs
    -- products.product_form. It is not silently accepted either -- job_chemicals.product_id
    -- is NOT NULL, so such a row aborts the whole save at the INSERT below.
    -- (buildJobChemicalsPayload does NOT filter these out, so this is a real path, not a
    -- theoretical one.)
    CONTINUE WHEN COALESCE(v_chem->>'product_id', '') = '';

    v_raw_rate_unit := lower(btrim(COALESCE(v_chem->>'rate_unit', '')));

    -- (2) A rate measured per something other than an acre. 'quantity = rate x acres'
    -- cannot be derived from it, so the quantity is simply the wrong amount. Refused
    -- rather than silently treated as per-acre.
    --
    -- BOTH denominator spellings are caught. Checking only for '/' left a real hole
    -- (Codex P1): 'oz per cwt' has no slash, so it fell through to the unit comparison --
    -- and when `unit` carried the SAME text it compared EQUAL and the row was accepted,
    -- with its quantity already derived as rate x acres against a denominator that is not
    -- acres. The word form is therefore refused too. A genuine per-acre rate in either
    -- spelling ('pt/ac', 'gal per acre') is excluded first and is unaffected.
    -- The two acre spellings accept the SAME set of abbreviations, in the same order.
    -- Three asymmetries were found across two review rounds, and every one of them was a
    -- FALSE REFUSAL of a legitimate per-acre rate, which matters more here than it looks:
    -- a refusal blocks the whole job, not the line. (i) the slash form accepted 'acres'
    -- while the word form took only 'acre'; (ii) neither form saw a hyphen, so 'oz-per-cwt'
    -- fell through to the unit comparison and passed whenever `unit` carried the same
    -- text; (iii) the word form took only 'acre'/'acres' while the slash form also took
    -- 'ac' and 'a', so 'pt per ac' -- an ordinary spelling -- was refused as non-acre.
    -- Alternation is longest-first because PostgreSQL regexps are POSIX. 'per' must still
    -- appear as a whole word between separators, so a plain hyphenated unit such as
    -- 'fl-oz' is untouched.
    -- STACKED denominators, and the reason this test is written subtractively rather than
    -- as a set of exclusions. Codex found (BLOCKER, 2026-08-24) that asking "does the rate
    -- unit END in a per-acre suffix?" and stopping there accepts 'oz/cwt/ac': it does end
    -- in '/ac', so every exclusion above was satisfied, and the base derivation below then
    -- took everything before the FIRST slash and silently discarded 'cwt'. The line
    -- normalised to a plain 'oz', compared EQUAL to a stock unit of 'oz', and SAVED -- a
    -- per-hundredweight rate billed as though it were per-acre, which is exactly the money
    -- error this rule exists to stop. 'oz per cwt per acre' was the same hole one spelling
    -- away. Reproduced in the container before the fix: T24 reported refused=f.
    --
    -- So: remove ONE trailing per-acre suffix, in either spelling, and then ask whether a
    -- denominator separator SURVIVES that removal. Anything still carrying a '/' or a
    -- whole-word 'per' is measured per something that is not acres, however many
    -- denominators deep it is. This is strictly stronger than the exclusion form and
    -- refuses nothing the exclusion form accepted: every legitimate spelling reduces to a
    -- bare unit ('pt/ac' -> 'pt', 'gal-per-acre' -> 'gal'), and a hyphenated unit such as
    -- 'fl-oz' carries no separator to survive. T24 and T25 pin both stacked forms.
    -- EXACTLY ONE suffix comes off, and the IF is what makes that true. Running both
    -- regexes unconditionally strips TWO, which was a BLOCKER the exact-SHA gpt-5.6-sol
    -- gate found on 2026-08-24: 'oz per acre/ac' lost '/ac' to the first pattern and
    -- ' per acre' to the second, the probe came back a bare 'oz' with no denominator
    -- left to catch, and a rate of oz per acre PER ACRE normalised to 'oz', matched a
    -- stock unit of 'oz' and was BILLED. 'oz-per-acre/ac' was the same hole one
    -- separator away. The stacked-denominator rule the round before was written to
    -- close only holds if the strip is singular -- 'remove one, refuse whatever
    -- survives' is not the same rule as 'remove every spelling, then look'.
    -- SEPARATORS ARE CANONICALISED BEFORE THE DENOMINATOR IS CLASSIFIED, for exactly the
    -- reason the fluid-ounce rule stopped enumerating them (round 16). This test used to look
    -- for `per` bounded by whitespace or hyphens, so 'oz_per_cwt' and 'oz.per.cwt' matched
    -- nothing, survived normalisation unchanged, and -- with a stock unit carrying the same
    -- text -- reached the equality branch and billed a per-hundredweight rate as per-acre
    -- (HIGH, gpt-5.6-sol 2026-08-24). Same class of defect, same fix: fold the separators
    -- instead of listing them.
    --
    -- '/' is deliberately PRESERVED by the fold, because here it is not a separator -- it is
    -- the denominator marker the rule is looking for. Everything else that is not a letter or
    -- a digit becomes a single space, after which the existing subtractive logic runs on a
    -- form with exactly one spelling: strip ONE trailing per-acre suffix, then refuse
    -- whatever denominator SURVIVES.
    --
    -- The canonical form also subsumes the leading-`per` arm added in round 15 -- 'per acre'
    -- folds to itself and is caught by the word-boundary test below -- so that arm is gone
    -- rather than left as a second way of saying the same thing.
    v_denom_canon := btrim(regexp_replace(lower(v_raw_rate_unit), '[^a-z0-9/]+', ' ', 'g'));
    v_denom_probe := regexp_replace(v_denom_canon, '\s*/\s*(acres|acre|ac|a)\s*$', '');
    IF v_denom_probe = v_denom_canon THEN
      v_denom_probe := regexp_replace(v_denom_probe, '\s+per\s+(acres|acre|ac|a)$', '');
    END IF;
    -- The LEADING form is caught too, and it was a real bypass: both patterns above and the
    -- surviving-'per' test below require whitespace or a hyphen BEFORE 'per', so a rate unit
    -- that STARTS with the denominator -- 'per cwt', 'per acre', 'per-acre' -- matched none of
    -- them. It then survived normalisation unchanged, and a stock `unit` carrying the same text
    -- reached the equality shortcut and billed. Worse, such a rate names no unit at all, so
    -- there was nothing to bill per in the first place. Found by the exact-SHA gpt-5.6-sol gate
    -- on 2026-08-24 (HIGH), after an earlier round had added this same shape to the PRE-APPLY
    -- query but NOT to the runtime guard -- fixing the report and leaving the enforcement is
    -- the same half-fix pattern this file has now been caught in three times.
    IF v_raw_rate_unit <> ''
       AND (position('/' IN v_denom_probe) > 0
            OR v_denom_probe ~ '(^| )per( |$)') THEN
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_RATE_DENOMINATOR_NOT_ACRES: % has a rate unit of "%", which is measured per something other than acres, so a per-acre quantity cannot be derived from it.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit;
    END IF;

    -- The unit the QUANTITY is counted in, and the unit the money is quoted in.
    -- baseUnitOfRate: take everything before the first '/', then drop a spelled-out
    -- ' per acre'. normalize_rate_unit then canonicalises synonyms (lbs -> lb, gl -> gal).
    v_rate_base := btrim(split_part(v_raw_rate_unit, '/', 1));
    -- The per-acre STRIPPER below stays character-for-character identical to the word-form
    -- pattern used in the probe above -- what deliberately differs is only that the probe
    -- takes ONE suffix while this takes a split_part plus one strip. That is sound because
    -- anything reaching here has already been PROVED to carry at most one per-acre
    -- denominator in one spelling; a stacked or mixed form was refused above and never
    -- arrives. If the two patterns ever
    -- disagree, a rate unit can be excluded from the non-acre refusal and then NOT
    -- stripped, so it reaches normalize_rate_unit whole, comes back unrecognised, and the
    -- line is refused by the unit comparison instead -- a refusal with the wrong message.
    v_rate_base := btrim(regexp_replace(v_rate_base, '[\s-]+per[\s-]+(acres|acre|ac|a)$', ''));
    v_qty_unit  := normalize_rate_unit(v_rate_base);
    v_price_unit := normalize_rate_unit(v_chem->>'unit');

    -- Note precisely what the blank handling below does NOT cover: normalize_rate_unit
    -- returns NULL only for
    -- BLANK input; an UNRECOGNISED unit comes back as itself (its ELSE branch). So an
    -- unrecognised unit is NOT skipped here -- it flows on, field_app_priced_quantity
    -- cannot size it, and the row is REFUSED. That is deliberate (an unpriceable unit
    -- must not bill), but it also means a metric pair such as 'g/ac' against 'kg' is
    -- refused even though the conversion is arithmetically well defined, because the
    -- live size tables carry no metric entries. Widening them is a separate change.
    -- A ZERO quantity bills nothing, so there is nothing to prove or disprove and nothing
    -- that can be billed wrongly. This skip has to sit ABOVE the blank-unit refusal, not
    -- below it: with it below, a line carrying a blank unit, a price, and quantity 0 was
    -- REFUSED even though transfer_job_to_invoice bills it as safe_cents_qty(price, 0) = 0.
    -- That contradicted the exemption rule stated below, and it was reachable from the
    -- ordinary UI -- reconcileChemAutofillUnits leaves `unit` blank on its fallback path
    -- while the tier price is already filled in, so a product picked before any acreage is
    -- entered produces exactly that shape and would have blocked the WHOLE job save.
    -- Found by the security review of this very change; T20 pins it.
    -- Negative and non-finite quantities were refused outright at the top of the loop.
    --
    -- ROUND 17: the skip is no longer UNCONDITIONAL, because as an unconditional exit it was
    -- the mirror image of the equality shortcut and leaked money the other way (HIGH,
    -- gpt-5.6-sol 2026-08-24). A line with a real price, a real rate and real acreage but
    -- quantity 0 saved and billed NOTHING -- so where the equality shortcut let a caller
    -- OVER-charge, this let one UNDER-charge, and the zero propagates into the invoice.
    --
    -- Mason's rule (2026-08-24): refuse only where a customer's money is actually at stake.
    -- Three exits stay, and each is a case where zero is genuinely the right answer:
    --   * customer_supplied -- contributes 0 to both totals by definition;
    --   * no PRICE -- nothing can be under-charged. This is the exemption that keeps live
    --     JOB-2026-0001 saveable: it carries quantity 0 against a 5/ac rate over 178.31
    --     acres with a cost but price 0. Its cost still misstates margin, which is a known
    --     and accepted residual, not an oversight;
    --   * no usable rate or acreage -- nothing was EXPECTED, so zero is not a shortfall.
    --     This is the one that matters operationally: it is the ordinary-UI path T20 was
    --     written for, where a product is picked before any acreage is entered. There
    --     acres = 0, so the expected quantity is 0 too and the line is simply correct.
    --
    -- What is left is exactly the harmful shape: priced, a positive quantity was expected,
    -- and none was recorded.
    --
    -- RE-RAISED AND RE-SETTLED (Mason, 2026-08-24). A later gate round asked for the third
    -- exemption to be narrowed to "acreage is genuinely zero", so that a priced line with
    -- POSITIVE acreage and no usable rate would be refused as unverifiable. Mason declined,
    -- and the reason is operational rather than theoretical: that shape is what the screen
    -- produces MID-ENTRY. The ordinary order of work is fields first, then products --
    -- choosing the fields sets the acreage, adding a product auto-fills the tier price, and
    -- the rate is typed afterwards. Between those two moments the line is priced, has
    -- acreage, has no rate, and carries quantity 0. Refusing it does not refuse a line; it
    -- rolls back the WHOLE job save, which is the round-7 defect three separate reviews
    -- already caught on this very migration. A zero-quantity line bills zero and appears on
    -- the invoice as a zero line, so nothing is charged wrongly and the operator can see it.
    -- Recorded in docs/manual/DECISION_LOG.md; do not re-narrow this without him.
    IF v_qty = 0 THEN
      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);
      CONTINUE WHEN COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) = 0;
      v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
      CONTINUE WHEN NOT (v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
                         AND v_acres > 0 AND v_acres < 'Infinity'::numeric);
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_QUANTITY_ZERO_BUT_EXPECTED: % is quoted at % per acre over % acres, so % should have been applied, but the line records a quantity of 0 while still carrying a price. The invoice bills the quantity, so this would charge the customer nothing. Enter the quantity actually applied, or clear the rate and the price if none was used.',
        COALESCE(v_product_name, 'This product'), v_rate, v_acres, v_rate * v_acres;
    END IF;

    -- A BLANK unit on either side proves nothing -- and until Mason settled it on
    -- 2026-08-23 such a row was simply SKIPPED. That was the largest remaining hole, and
    -- the security review was right to call it out: transfer_job_to_invoice goes on to
    -- bill the line at price_per_unit_cents x quantity regardless, so an unprovable line
    -- that still BILLS is the same hazard class this whole migration exists to close, and
    -- one live row was sitting in exactly that shape.
    --
    -- So it is now REFUSED -- but only when the line actually bills. Two exemptions, both
    -- deliberate: a customer-supplied line contributes 0 to both totals, and a line with
    -- neither a cost nor a price bills nothing. Refusing either would be pure friction,
    -- because a line that cannot bill cannot bill WRONGLY. The cost side is included in
    -- the test, not just the price: total_cost_cents feeds margin, so a blank-unit line
    -- with a cost and no price is still a wrong number.
    IF v_qty_unit IS NULL OR v_price_unit IS NULL THEN
      CONTINUE WHEN COALESCE((v_chem->>'customer_supplied')::boolean, false);
      CONTINUE WHEN COALESCE(NULLIF(v_chem->>'cost_per_unit_cents', '')::bigint, 0) = 0
                AND COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) = 0;

      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_UNIT_UNSPECIFIED: % is priced per unit but %, so the amount to bill cannot be checked. Fill in both the rate unit and the stock Unit, then re-enter the cost and price for that unit.',
        COALESCE(v_product_name, 'This product'),
        CASE WHEN v_qty_unit IS NULL AND v_raw_rate_unit <> '' THEN 'its rate unit names no unit to count the quantity in'
             WHEN v_qty_unit IS NULL AND v_price_unit IS NULL  THEN 'neither its rate unit nor its Unit is filled in'
             WHEN v_qty_unit IS NULL                           THEN 'its rate unit is blank'
             ELSE                                                   'its Unit is blank'
        END;
    END IF;

    -- (the zero-quantity skip moved ABOVE the blank-unit refusal -- see the comment there)

    -- The product's FORM is loaded BEFORE the equality shortcut, not after it. That
    -- ordering is the fix for a BLOCKER the exact-SHA gpt-5.6-sol proof gate found on
    -- 2026-08-24, and the ordering is the whole of it.
    --
    -- normalize_rate_unit collapses 'fl oz' -> 'oz' knowing nothing about the product.
    -- On a LIQUID product that alias is exactly right: the live unit_conversions table
    -- records 'oz' as "alias for fl oz", both liquid, both factor 1. On a DRY product it
    -- is wrong -- there 'oz' means a dry ounce, a WEIGHT, while 'fl oz' is a VOLUME --
    -- and field_app_priced_quantity, the authoritative converter the rest of the app
    -- bills through, agrees: its dry branch sizes 'fl oz' as NULL, i.e. not convertible,
    -- so the caller must error. This guard was collapsing the pair to oz = oz, taking the
    -- shortcut, and billing a line with NOTHING proven -- passing a shape its own
    -- converter calls unpriceable. A guard must never be more lenient than the SQL that
    -- does the billing.
    --
    -- Reachability, stated at its real size rather than inflated: no live product carries
    -- 'fl oz' on a dry form today (read read-only 2026-08-24 -- the 85 dry products use
    -- 'dry oz', 'lb', 'mg' and 'oz'). But the units compared here come from p_chemicals,
    -- NOT from the product catalog, and EXECUTE on this function is granted to
    -- authenticated -- which is the premise of this entire migration. A hand-built call
    -- reaches the shape regardless of how clean the catalog is.
    SELECT p.product_name, lower(COALESCE(p.product_form, ''))
      INTO v_product_name, v_form
      FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;

    -- On a DRY product a FLUID ounce is refused OUTRIGHT, on either side, whatever the
    -- other side says and whether or not the two sides normalise equal. The first
    -- version of this rule fired only when the normalised units were EQUAL, and that
    -- was a half-fix the gate returned as a fresh HIGH one round later: the equality
    -- shortcut is not the only way a fluid ounce reaches the money.
    --
    -- The path it missed is the CONVERSION path below, and it is worse than the one it
    -- closed. field_app_priced_quantity is called with v_qty_unit and v_price_unit --
    -- the NORMALISED units -- so 'fl oz' has already become 'oz' before the converter
    -- ever sees it. Handed the raw 'fl oz' the converter's dry branch sizes it NULL and
    -- refuses; handed 'oz' it sizes it 1 and happily converts 16:1 into pounds. So a dry
    -- product with rate 'fl oz/ac' against a stock unit of 'lb' did not take the
    -- shortcut at all -- it went through the conversion, turned a VOLUME into a WEIGHT,
    -- and derived authoritative cost and price totals from it. Normalisation erased the
    -- very distinction the converter would have refused on.
    --
    -- Hence the unconditional form. It is both simpler and strictly stronger than the
    -- equality-gated version, and it has no precondition left to get wrong: a dry
    -- product has no density in this system, so NOTHING downstream can carry a fluid
    -- ounce into a weight honestly. That includes 'fl oz' on BOTH sides -- self-
    -- consistent arithmetic on a unit the inventory and invoice sides cannot convert is
    -- not a saving grace, and an earlier test that required that shape to SAVE was
    -- wrong and is now inverted.
    --
    -- It stays gated on v_form = 'dry' and touches LIQUID lines not at all, which is the
    -- line that must not move: on a liquid product 'oz' IS 'fl oz' (the live
    -- unit_conversions table records exactly that, both factor 1) and T33 pins it. A
    -- NULL or blank product_form is treated as liquid here, matching the converter.
    -- Widening the rule beyond fluid ounces -- "the converter must agree" -- was
    -- considered and REJECTED: on a liquid product 'lbs/ac' against 'lb' normalises
    -- equal while the liquid size table carries no pound at all, so that form REFUSES an
    -- ordinary line, and one refused line blocks the WHOLE job save (performSave
    -- re-sends the entire grid). That is the round-7 defect three reviewers caught.
    --
    -- THE SPELLING TEST IS A CONCEPT TEST, NOT A LIST. The first version of this rule
    -- matched three literal strings -- 'fl oz', 'floz', 'fluid ounce' -- and the gate
    -- returned that as a fresh P1 one round later, which is the THIRD time this same
    -- rule has been caught incomplete. The escape is the PERIOD form: 'fl. oz'.
    -- normalize_rate_unit knows nothing about it (its CASE has no arm for it, so it
    -- falls through to ELSE base and hands the string BACK unchanged), so a dry line
    -- quoted 'fl. oz/ac' against a stock unit of 'fl. oz' normalises to 'fl. oz' on both
    -- sides, missed this test, hit the equality shortcut below, and derived
    -- authoritative cost and price totals from a VOLUME on a product billed by weight.
    -- That is not an exotic spelling: src/lib/blendMathValidator.ts documents in so many
    -- words that periods are insignificant and "'fl. oz' is 'fl oz'".
    --
    -- THE FOLD HAS NO CHARACTER LIST, AND THAT IS THE WHOLE POINT. Four consecutive rounds
    -- of this rule were defeated by a separator nobody had thought of yet:
    --
    --   round 12  three literal spellings          defeated by 'fl. oz'      (period)
    --   round 13  + periods and whitespace         defeated by 'fl<ZWSP>oz'  (zero-width)
    --   round 14  + zero-width and NBSP            defeated by 'fl-oz'       (ASCII hyphen)
    --   round 15  + ASCII hyphen                   defeated by 'fl<U+2010>oz' (Unicode hyphen)
    --
    -- Every one of those fixes enumerated the characters that had been NAMED, and every one
    -- was beaten by the next character along -- U+2010 and U+2011 are hyphens, U+202F is a
    -- narrow no-break space, and Unicode has plenty more where those came from. Enumeration
    -- cannot converge here, because the attacker picks the character and the list is always
    -- written afterwards.
    --
    -- So the list is gone. Everything that is not a letter or a digit is DELETED, and what
    -- remains must BE the word: 'floz', 'fluidounce'. There is no separator to smuggle in,
    -- because no separator survives -- which is why this form ends the class of bug rather
    -- than closing one more instance of it.
    --
    -- Verified on live PostgreSQL 17.6 over 31 spellings. All 19 fluid-ounce forms refuse,
    -- including every escape found in rounds 12-15 (period, ZWSP, ZWNJ, ZWJ, BOM, NBSP,
    -- U+2010, U+2011, U+202F), plus 'fl_oz' and even 'f l o z'. All 12 legitimate units pass
    -- untouched: 'oz', 'dry oz', 'dry<NBSP>oz', 'dry-oz', 'lb', 'ton', 'mg', 'gal', 'gal.',
    -- 'pt', 'ozs' -- and 'flour oz', the near-miss that a sloppier rule would eat, since it
    -- folds to 'flouroz' and the anchors require the word to be exactly fl|fluid + the unit.
    --
    -- The deletion also makes the NBSP question moot, which is worth saying because an
    -- earlier round reasoned carefully about it and that reasoning no longer applies: it does
    -- not matter whether a separator "separates", since 'dry oz' folds to 'dryoz' and simply
    -- fails the fl|fluid anchor. T41 still pins that the NBSP line saves.
    --
    -- So each side is folded to letters and digits only, and then matched as a concept:
    -- {fl|fluid} x {oz|ozs|ounce|ounces}, optional separator. 'fl. oz', 'fl.oz',
    -- 'fluid oz', 'fl ounces' and 'fl oz.' all land on the rule; a bare 'oz' does NOT,
    -- because on a dry product that is a legitimate dry ounce and refusing it would
    -- block ordinary jobs.
    --
    -- The expression is written ONCE and applied to both sides through a VALUES list
    -- rather than being spelled out twice. Two copies of a rule are two things that can
    -- drift apart, and a half-updated pair is exactly how this rule regressed before.
    IF v_form = 'dry'
       AND EXISTS (
         SELECT 1
           FROM unnest(ARRAY[v_rate_base, v_chem->>'unit']) AS raw_unit
          -- ANY DENOMINATOR IS STRIPPED FIRST, on BOTH sides. The rate side arrives already
          -- stripped (v_rate_base), but the stock side was passed in RAW -- so a dry line
          -- with rate_unit 'oz/ac' against a stock unit of 'fl oz/ac' folded to 'flozac',
          -- missed the anchored pattern, and then normalise_rate_unit collapsed BOTH sides to
          -- 'oz' anyway, so the equality branch accepted it and derived money from a volume
          -- price on a weight product (HIGH, gpt-5.6-sol 2026-08-24). The asymmetry was the
          -- whole defect: one side was being tested in a different form from the other.
          --
          -- 'fl oz/ac' still DENOTES fluid ounces -- the denominator says per what, not what.
          -- So each side is reduced to the unit it names before the concept test runs: fold
          -- separators (keeping '/' meaningful), drop everything from the first '/', drop a
          -- spelled-out 'per ...' tail, then delete every remaining non-alphanumeric.
          WHERE regexp_replace(
                  regexp_replace(
                    split_part(
                      btrim(regexp_replace(lower(COALESCE(raw_unit, '')), '[^a-z0-9/]+', ' ', 'g')),
                      '/', 1),
                    '\s+per\s+.*$', ''),
                  '[^a-z0-9]', '', 'g')
                ~ '^(fl|fluid)(oz|ozs|ounce|ounces)$'
       ) THEN
      RAISE EXCEPTION
        'CHEM_UNIT_FORM_MISMATCH: % is a DRY product, so it cannot be measured or priced in fluid ounces -- a fluid ounce measures volume and a dry product is billed by weight, so "%" against "%" cannot be converted and the amount to bill cannot be checked. Re-enter the rate and the stock Unit in the same dry unit (oz, lb or ton), then re-enter the cost and price for that unit.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit, COALESCE(v_chem->>'unit', '');
    END IF;

    -- FAIL CLOSED ON CHARACTERS THIS FILE CANNOT INTERPRET.
    --
    -- The round-20 backstop was defeated by making the DELETION do the attacker's work
    -- (HIGH, gpt-5.6-sol 2026-08-24). `oz<U+2215>сԝт` -- a Unicode division slash followed by
    -- CYRILLIC homoglyphs for "cwt" -- folds under '[^a-z0-9]' to plain 'oz', because every
    -- non-ASCII character is DELETED. The denominator does not survive as a residue for the
    -- rule to catch; it is erased outright. 'oz' is then a perfectly recognised unit, both
    -- sides match, and a per-hundredweight rate bills as per-acre. Every previous round of
    -- this rule assumed folding leaves SOMETHING behind. Against non-ASCII it leaves nothing.
    --
    -- So the fold is no longer allowed to discard anything silently. A small, deliberately
    -- enumerated set is normalised first -- Unicode spaces become a space, zero-width
    -- characters are deleted -- and then ANY remaining character outside the supported ASCII
    -- set refuses the line. The enumeration is for CONVENIENCE and the allowlist is for
    -- SAFETY: getting the convenience list wrong can only cause a refusal, never an
    -- acceptance, which is the opposite of every separator round before this one.
    --
    -- Ordering is deliberate. This sits AFTER the fluid-ounce rule so a dry line written
    -- 'fl<U+2010>oz' still reports the specific CHEM_UNIT_FORM_MISMATCH that tells the
    -- operator what is actually wrong, rather than a generic character complaint.
    --
    -- Gated on PRICE, per Mason's 2026-08-24 rule. Every live unit is plain ASCII
    -- (read read-only 2026-08-24: Gal, Pt, oz, dry oz, fl oz, lb, qt, g, mg, ea, unit), so
    -- this refuses nothing that exists.
    IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0
       AND EXISTS (
         SELECT 1
           FROM unnest(ARRAY[v_raw_rate_unit, v_chem->>'unit']) AS raw_unit
          WHERE translate(lower(COALESCE(raw_unit, '')),
                          chr(160) || chr(8239) || chr(8203) || chr(8204) || chr(8205) || chr(65279),
                          '  ') ~ '[^a-z0-9 ./-]'
       ) THEN
      SELECT p.product_name INTO v_product_name
        FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
      RAISE EXCEPTION
        'CHEM_UNIT_UNSUPPORTED_CHARACTER: % has a unit containing a character this system cannot read ("%" against "%"). That is usually a copy-and-paste from a spreadsheet or a web page carrying a lookalike letter or symbol. Re-type both the rate unit and the stock Unit using plain letters.',
        COALESCE(v_product_name, 'This product'), v_raw_rate_unit, COALESCE(v_chem->>'unit', '');
    END IF;

    -- STRUCTURAL BACKSTOP: A PRICED LINE MUST NAME A UNIT THIS SYSTEM KNOWS.
    --
    -- This exists because the gate found a FOURTH separator bypass -- 'oz<U+2215>cwt', a
    -- Unicode DIVISION SLASH -- and patching one more character would have been the fifth
    -- round of the same losing game. The denominator canon preserves ASCII '/' and folds
    -- every other punctuation mark to a space, so a slash homoglyph became 'oz cwt': no '/'
    -- and no whole-word 'per' survived, the denominator rule saw nothing, and a
    -- PER-HUNDREDWEIGHT rate would then be billed as per-acre.
    --
    -- Enumerating slash lookalikes loses the same way the fluid-ounce list lost four times.
    -- What actually distinguishes 'oz cwt' from a legitimate 'fl oz' is not the character
    -- between the words -- it is that 'oz cwt' IS NOT A UNIT. So the rule asks that instead.
    -- Whatever remains after the per-acre suffix is stripped must be a unit the system
    -- recognises: either normalize_rate_unit maps it to a canonical unit, or it is a spelling
    -- carried in the live unit_conversions table. A denominator smuggled in behind ANY
    -- separator, present or future, leaves a residue that is not a unit -- and is refused.
    --
    -- Verified read-only on live PostgreSQL 17.6: all 12 spellings in unit_conversions match
    -- under this fold, including 'fl. oz' -> 'fl oz' and 'dry oz'; 'ton', 'kg', 'l' and 'ml'
    -- are covered by the canonical-output arm even though the conversions table has no row
    -- for them; and 'oz cwt', 'cwt', 'oz bu' and 'bu' do not match, which is the point.
    --
    -- Gated on PRICE, following Mason's 2026-08-24 rule: refuse only where a customer's money
    -- is at stake. An unrecognised unit on a line that bills nothing cannot bill wrongly. The
    -- known consequence, recorded rather than buried: a cost-only line can still carry an
    -- unrecognised rate unit and misstate MARGIN -- the same accepted residual as the
    -- zero-quantity and unverifiable-quantity rules, following from the same decision. Live
    -- JOB-2026-0001 carries rate_unit '32' with price 0 and is exempt for exactly that
    -- reason; T3 and T47 pin that it still saves.
    -- The '' arm below is NOT an exemption -- round 26 (P1, 2026-08-25). It used to be:
    -- `v_base_folded <> '' AND ...` skipped this whole check when the fold left nothing,
    -- reading an empty fold as "the blank-unit rule's territory". That was true only for a
    -- unit that was blank BEFORE folding. A punctuation-only unit -- rate_unit '.' against
    -- stock '.' -- is nonblank raw (so CHEM_UNIT_UNSPECIFIED passed it), folds to '' (so
    -- this check skipped it), survives the unsupported-character probe (periods are
    -- allowed), and the two sides then compare EQUAL -- a priced line whose unit names no
    -- measurement saved, and job completion cannot convert what it deducts. A nonblank
    -- base that folds to nothing IS the strongest form of "not a unit the system
    -- recognises", so it now takes this refusal; a raw-blank base still belongs to the
    -- blank-unit rule and its deliberate zero-quantity/customer-supplied exemptions.
    IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN
      v_base_folded := btrim(regexp_replace(lower(COALESCE(v_rate_base, '')), '[^a-z0-9]+', ' ', 'g'));
      IF (v_base_folded = '' AND btrim(COALESCE(v_rate_base, '')) <> '')
         OR (v_base_folded <> ''
             AND normalize_rate_unit(v_base_folded) NOT IN
                 ('oz', 'pt', 'qt', 'gal', 'lb', 'ton', 'g', 'kg', 'l', 'ml')
             AND NOT EXISTS (
                   SELECT 1 FROM unit_conversions uc
                    WHERE btrim(regexp_replace(lower(COALESCE(uc.unit, '')), '[^a-z0-9]+', ' ', 'g'))
                          = v_base_folded))
      THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_RATE_UNIT_UNRECOGNIZED: % has a rate unit of "%", which does not name a unit this system recognises, so the amount to bill cannot be derived from it. Re-enter the rate using one of the units on the product.',
          COALESCE(v_product_name, 'This product'), v_raw_rate_unit;
      END IF;
    END IF;

    -- A STOCK UNIT MUST NAME A QUANTITY, NOT A RATE -- round 25 (HIGH, gpt-5.6-sol,
    -- 2026-08-24), and it is the denominator rule's missing half.
    --
    -- Every denominator rule in this file, through five rounds of hardening, examined
    -- `rate_unit` and nothing else. The stock `unit` was handed straight to
    -- normalize_rate_unit, whose FIRST action is to strip a trailing per-acre suffix -- so a
    -- caller-supplied stock unit of 'oz/ac' quietly became 'oz', matched a rate side that
    -- also reduced to 'oz', passed the quantity check, and derived authoritative money from
    -- a line whose stored unit is a RATE. The two sides were being held to different rules,
    -- which is the same asymmetry round 19 found in the fluid-ounce test and the same shape
    -- the file has now been caught in more than once.
    --
    -- The stock unit answers "how many of what", and 'oz/ac' is not a what -- it is a rate.
    -- On the rate side '/ac' is legitimate and gets stripped; here ANY denominator, per-acre
    -- included, is refused. The two rules differ because the two fields mean different
    -- things, and that difference is the reason this could not be fixed by reusing the rate
    -- rule verbatim.
    --
    -- Same canon as the rate probe -- fold everything that is not a letter, a digit or '/'
    -- to a space, keeping '/' because here too it is the marker rather than a separator --
    -- so the two rules cannot drift into recognising different spellings.
    --
    -- Gated on PRICE per Mason's 2026-08-24 rule, and the live blast radius is ZERO: read
    -- read-only 2026-08-24, every stock unit in the catalogue and on every job_chemicals row
    -- is a bare unit (Gal, Pt, oz, Dry oz, Lb, Qt, MG, Unit, Ea), and not one carries a
    -- slash or a 'per'.
    IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN
      v_stock_canon := btrim(regexp_replace(lower(COALESCE(v_chem->>'unit', '')),
                                            '[^a-z0-9/]+', ' ', 'g'));
      IF v_stock_canon <> ''
         AND (position('/' IN v_stock_canon) > 0
              OR v_stock_canon ~ '(^| )per( |$)') THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_STOCK_UNIT_IS_A_RATE: % carries a stock Unit of "%", which is measured per something. The Unit says what the quantity counts and what the price is quoted per, so it has to name a plain unit -- put the per-acre part in the rate unit instead.',
          COALESCE(v_product_name, 'This product'), COALESCE(v_chem->>'unit', '');
      END IF;
    END IF;

    -- EQUAL UNITS ARE NOT A FREE PASS FOR THE QUANTITY. This used to be a bare
    -- `CONTINUE WHEN v_qty_unit = v_price_unit`, and the gate found the money hole that left
    -- open (HIGH, gpt-5.6-sol, 2026-08-24): matching units proved the two sides were counted
    -- in the SAME unit, and nothing at all about HOW MANY. A hand-built call sending 10 acres
    -- at 2 oz/ac with quantity 200 oz passed -- both sides 'oz' -- and the derived totals then
    -- authoritatively stored 20,000 cents instead of 2,000. The caller controlled the money
    -- directly, on the exact path this migration exists to close.
    --
    -- The rule already existed for the mismatched branch below, which refuses when the
    -- quantity is not what rate x acres reads. Applying it only when the units DIFFER was the
    -- inconsistency; the quantity reaches the totals either way.
    --
    -- No converter is called here on purpose. The units are identical, so the carried quantity
    -- IS rate x acres and a conversion would add nothing but a failure mode: an exotic-but-
    -- self-consistent unit the conversion tables do not carry ('cc' against 'cc') would size
    -- NULL and start REFUSING a line that is perfectly well formed, and one refused line
    -- blocks the whole job save. Same tolerance as the mismatched branch: quantity is stored
    -- through fmt4, so the slack is EXACTLY that storage precision and nothing more.
    --
    -- The tolerance is ABSOLUTE, and it used to be RELATIVE -- GREATEST(0.0001, |expected| *
    -- 1e-6) -- which is a money bug at scale (HIGH, gpt-5.6-sol 2026-08-24). A proportional
    -- slack means the larger the number, the more the guard lets through: at 5,000 acres and
    -- a rate of 1e9 the accepted difference is 5 million units, so at $1 a unit the check
    -- would wave a $5,000,000 discrepancy straight past. Nothing bounds rate, acreage or
    -- quantity, so "one part per million" is not a small quantity here -- it is a percentage
    -- of whatever the caller chose.
    --
    -- WHAT THE TOLERANCE IS NOW, after rounds 23 and 24 and stated once here so the block
    -- below is read against the current rule and not an earlier one: GREATEST(0.0001,
    -- LEAST(0.00005 * acres, 0.1)). Every term earns its place -- 0.0001 is the quantity's
    -- own storage precision, 0.00005 * acres is the error a 4-decimal RATE introduces when
    -- the operator drives the line by total instead of by rate, and the 0.1 ceiling is what
    -- stops that second term from being sized by caller-supplied acreage. No term scales
    -- with the number under test, and no term is unbounded.
    IF v_qty_unit = v_price_unit THEN
      v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
      IF v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
         AND v_acres > 0 AND v_acres < 'Infinity'::numeric THEN
        -- THE TOLERANCE MODELS THE RATE'S OWN STORED PRECISION, and round 23 is why.
        --
        -- The app supports TWO calculation directions and does not tell the server which one
        -- the operator used for THIS check (chemCalculator.applyChemEdit tracks a `driver` of
        -- 'rate' or 'qty'; since F06 the payload sends it and the row stores it, but this
        -- check deliberately does not read it -- see the driver note at the top of the
        -- loop). Entering a RATE derives the
        -- quantity; entering a QUANTITY derives the rate as fmt4(quantity / acres) and HOLDS
        -- the typed total. The second direction cannot reproduce quantity = rate x acres,
        -- because the rate it stores has been rounded to four decimals.
        --
        -- The gate's example is an ordinary job, not an attack: 178.31 acres, operator types
        -- quantity 10, the UI stores rate 0.0561, and 0.0561 x 178.31 = 10.003191. A flat
        -- 0.0001 refuses it -- and refusing one line rolls back the WHOLE job save. That is
        -- the round-7 defect again, reached by tightening rather than by loosening, which is
        -- exactly the failure mode T51 was written to watch for and did not cover.
        --
        -- So the slack is the error the rate's own rounding can introduce and nothing more:
        -- a rate stored to 4 dp can be wrong by up to 0.00005, which over v_acres acres is
        -- 0.00005 * v_acres.
        --
        -- AND IT IS CAPPED, because round 24 caught me repeating round 18's mistake in a new
        -- shape (HIGH, gpt-5.6-sol, 2026-08-24). The round-23 message claimed acreage is
        -- "physically bounded by the field". THE SERVER DOES NOT KNOW THAT. Acreage is summed
        -- out of p_fields, which the caller writes, so an uncapped 0.00005 * v_acres is a
        -- caller-sized allowance exactly like the relative term round 18 deleted -- it just
        -- reads a different number out of the same payload. The gate's arithmetic: 1e12 acres
        -- at a rate of 1e-9 expects 1,000 units and opens a slack of 50,000,000, so a
        -- submitted quantity of 50,001,000 passes and bills every one of them.
        --
        -- LEAST(..., 0.1) is that ceiling, and a tenth of a unit is not a guess. The largest
        -- job in the live data covers 178.31 acres and needs 0.0089; the cap does not begin
        -- to bind until 2,000 acres, more than ten times the largest job ever recorded here.
        -- It is also the WHOLE exposure of this exit: whatever the caller claims its acreage
        -- to be, no quantity further than 0.1 from rate x acres is accepted.
        --
        -- A job past the knee is not stuck, and the message now says how: enter the RATE
        -- instead of the total. That is the other direction, where the app derives the
        -- quantity as fmt4(rate x acres) and lands within 0.00005 of it at ANY acreage.
        CONTINUE WHEN abs(v_qty - (v_rate * v_acres))
                      <= GREATEST(0.0001::numeric,
                                  LEAST(0.00005::numeric * v_acres, 0.1::numeric));
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_QUANTITY_NOT_DERIVED: % is quoted at % per acre over % acres, which is %, but the line carries a quantity of %. The amount billed comes from the quantity, so these must agree. Re-enter the rate per acre and let the total fill itself in, or correct the quantity.',
          COALESCE(v_product_name, 'This product'), v_rate, v_acres, v_rate * v_acres, v_qty;
      END IF;
      -- ROUND 17 closed what round 15 left open here, on Mason's decision of 2026-08-24.
      --
      -- The gap mattered more than round 15 admitted: with no usable rate there is nothing to
      -- derive from, and a hand-built call chooses its own payload -- so it could defeat the
      -- whole check by simply OMITTING the rate and naming any quantity it liked. A guard a
      -- caller can switch off is not a guard.
      --
      -- Mason's rule is to refuse only where a customer's money is at stake, so the refusal
      -- is conditioned on the line carrying a PRICE. A line with no price bills the customer
      -- nothing, so an unverifiable quantity on it cannot over-charge anyone; its cost can
      -- still misstate margin, which is the same accepted residual recorded at the
      -- zero-quantity exit above.
      IF COALESCE(NULLIF(v_chem->>'price_per_unit_cents', '')::bigint, 0) <> 0 THEN
        SELECT p.product_name INTO v_product_name
          FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        RAISE EXCEPTION
          'CHEM_QUANTITY_UNVERIFIABLE: % is priced per unit and carries a quantity of %, but without both a rate per acre and field acreage there is nothing to check that quantity against, and the invoice bills it. Enter the rate per acre and the acres treated, or clear the price.',
          COALESCE(v_product_name, 'This product'), v_qty;
      END IF;
      CONTINUE;
    END IF;

    -- PROOF OF SAFETY, and the only one: the quantity is what rate x acres reads once
    -- carried into the unit the price is quoted in. Without a usable rate and acreage
    -- nothing is proven, so the row is refused rather than escaping.
    v_rate := NULLIF(v_chem->>'rate_per_acre','')::numeric;
    -- EVERY operand is range-checked for FINITENESS, not merely for NULL or NaN. This
    -- closes the bypass Codex found (P1, round 3): with a single field carrying
    -- acres_to_treat = 'NaN', the old test `v_acres > 0` PASSED, because PostgreSQL
    -- orders numeric NaN above every other value. v_carried then came back NaN, and the
    -- tolerance line compared NaN <= GREATEST(0.0001, NaN) -- that is, NaN <= NaN, which
    -- is TRUE, since NaN is equal to itself. A mismatched line was therefore waved
    -- through AND the NaN acreage stored. A `< 'Infinity'` bound excludes NaN and
    -- Infinity in one test; a NaN test alone would still admit Infinity.
    IF v_rate IS NOT NULL AND v_rate > 0 AND v_rate < 'Infinity'::numeric
       AND v_acres > 0 AND v_acres < 'Infinity'::numeric THEN
      v_carried := field_app_priced_quantity(v_rate * v_acres, v_qty_unit, v_price_unit, v_form);
      -- quantity is stored through fmt4, so the slack is exactly that storage precision.
      -- v_carried is bounded for the same reason as its inputs: the helper can return a
      -- non-finite value, and a NaN tolerance compares TRUE against a NaN difference.
      IF v_carried IS NOT NULL
         AND v_carried > '-Infinity'::numeric
         AND v_carried < 'Infinity'::numeric
         AND abs(v_qty - v_carried)
             <= GREATEST(
                  0.0001::numeric,
                  -- The same rate-rounding slack as the equal-units branch, CARRIED THROUGH
                  -- THE CONVERTER because here the quantity lives in a different unit from
                  -- the rate. Converting 0.00005 * acres gives the error in the unit actually
                  -- being compared -- the unconverted figure would be far too generous in one
                  -- direction (oz -> gal divides by 128) and too tight in the other.
                  --
                  -- AND THE SAME ABSOLUTE CEILING, converted the same way, so the round-24
                  -- hole is closed on BOTH branches. Capping only the equal-units exit would
                  -- have left the identical caller-sized allowance one line further down: a
                  -- 1e12-acre payload whose units merely happen to differ. Converting the cap
                  -- rather than applying a flat 0.1 keeps it the SAME PHYSICAL AMOUNT on both
                  -- sides -- 0.1 gal is 12.8 oz, and the money exposure is what must match,
                  -- not the digits.
                  --
                  -- Both terms fall back to the flat 0.0001 if the converter cannot size
                  -- them, which is the strict reading, not the lax one; and LEAST of a real
                  -- conversion against that fallback is still 0.0001, so an unconvertible
                  -- cap tightens this exit rather than widening it.
                  LEAST(
                    COALESCE(
                      field_app_priced_quantity(0.00005::numeric * v_acres,
                                                v_qty_unit, v_price_unit, v_form),
                      0.0001::numeric),
                    COALESCE(
                      field_app_priced_quantity(0.1::numeric,
                                                v_qty_unit, v_price_unit, v_form),
                      0.0001::numeric))) THEN
        CONTINUE;
      END IF;
    END IF;

    -- The remedy text must not teach a quieter version of the same bug. An earlier draft
    -- said only "Set Unit to <qty_unit>" -- but changing the unit while LEAVING the
    -- per-pound cost and price in place applies a per-pound price per ounce: a 16x
    -- UNDER-bill that also silences this guard, because the units then agree. Both
    -- branches now say explicitly which numbers must be re-entered.
    RAISE EXCEPTION
      'CHEM_UNIT_MISMATCH: % is measured in % but its cost and price are quoted per %. Either set Unit to % AND re-enter the cost and price per %, or change the rate unit to %/ac AND re-enter the rate. Changing one without the other bills the wrong amount.',
      COALESCE(v_product_name, 'This product'), v_qty_unit, v_price_unit, v_qty_unit, v_qty_unit, v_price_unit;
  END LOOP;

  -- ==========================================================================
  -- (3) DERIVED MONEY TOTALS. The caller's total_cost_cents / total_price_cents are
  -- ignored outright. safe_cents_qty is an EXACT numeric multiply with ROUND half away
  -- from zero, applied PER LINE and then summed. customer_supplied product is applied
  -- but not billed, contributing 0.
  --
  -- THE PAGE AND THIS DO NOT AGREE TO THE CENT, and an earlier draft of this comment
  -- wrongly said they did. On `main`, JobDetail.tsx computes its displayed totals as
  -- Math.round(parseFloat(qty) * parseInt(cents)) -- IEEE-754 binary multiply, and
  -- Math.round is half-UP, not half-away-from-zero. Two divergences follow: float
  -- representation error (25c x 0.58 displays 14c, exact arithmetic gives 15c) and
  -- negative half-cents. From here on the SERVER value is the authoritative one and is
  -- what transfer_job_to_invoice bills, so the money is right -- but until PR #436 lands
  -- the exact-cents client path, the operator can see a figure one cent off what is
  -- stored. Per-line-then-sum ordering DOES match the page; only the arithmetic base
  -- differs. This is the second reason PR #436 is an ordering prerequisite.
  -- ==========================================================================
  SELECT
    COALESCE(SUM(
      CASE WHEN COALESCE((c->>'customer_supplied')::boolean, false) THEN 0
           ELSE safe_cents_qty(
                  COALESCE(NULLIF(c->>'cost_per_unit_cents','')::bigint, 0),
                  COALESCE(NULLIF(c->>'quantity','')::numeric, 0))
      END), 0)::bigint,
    COALESCE(SUM(
      CASE WHEN COALESCE((c->>'customer_supplied')::boolean, false) THEN 0
           ELSE safe_cents_qty(
                  COALESCE(NULLIF(c->>'price_per_unit_cents','')::bigint, 0),
                  COALESCE(NULLIF(c->>'quantity','')::numeric, 0))
      END), 0)::bigint
    INTO v_total_cost_cents, v_total_price_cents
    FROM jsonb_array_elements(COALESCE(p_chemicals, '[]'::jsonb)) c;

  IF v_is_new THEN
    INSERT INTO jobs (
      job_number, customer_id, status, job_date, scheduled_time,
      applicator_id, vehicle_id, recipe_id, application_service_id,
      notes, tags, batch_id, season,
      total_acres, total_cost_cents, total_price_cents,
      call_date, date_proposed, time_proposed, schedule_date, date_expires,
      consultant_id, loader_comment, additional_info, internal_memo,
      created_by, updated_by
    ) VALUES (
      next_job_number(),
      (p_job_payload->>'customer_id')::uuid,
      COALESCE(p_job_payload->>'status', 'scheduled'),
      v_job_date,
      CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'application_service_id' IS NOT NULL AND p_job_payload->>'application_service_id' != ''
        THEN (p_job_payload->>'application_service_id')::uuid ELSE NULL END,
      p_job_payload->>'notes',
      CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      p_job_payload->>'batch_id',
      v_season,
      -- DERIVED, not taken from the caller -- round 24, and the reason is the same one that
      -- makes the totals derived. The caller used to set `total_acres` independently of the
      -- field rows it sent, so a payload could claim a ten-acre job while sending zero
      -- billable acreage: the header read as real work, every per-acre check saw nothing to
      -- expect, and a priced line saved billing nothing. v_acres is the SUM OF THE FIELDS
      -- BEING SAVED, which is exactly what the page computes (sumAcres over acres_to_treat)
      -- and what every check above already reasons about. Live agreement verified read-only
      -- on 2026-08-24: all four jobs carry total_acres equal to their summed field acreage to
      -- the hundredth, so this changes no existing row and no ordinary save.
      v_acres,
      -- DERIVED, not taken from the caller.
      v_total_cost_cents,
      v_total_price_cents,
      NULLIF(p_job_payload->>'call_date','')::date,
      NULLIF(p_job_payload->>'date_proposed','')::date,
      NULLIF(p_job_payload->>'time_proposed','')::time,
      NULLIF(p_job_payload->>'schedule_date','')::date,
      NULLIF(p_job_payload->>'date_expires','')::date,
      CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      p_job_payload->>'loader_comment',
      p_job_payload->>'additional_info',
      p_job_payload->>'internal_memo',
      p_performed_by,
      v_actor
    )
    RETURNING id INTO v_job_id;
  ELSE
    SELECT id INTO v_job_id FROM jobs WHERE id = p_job_id FOR UPDATE;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'Job not found: %', p_job_id;
    END IF;

    UPDATE jobs SET
      customer_id = (p_job_payload->>'customer_id')::uuid,
      job_date = v_job_date,
      scheduled_time = CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      applicator_id = CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      vehicle_id = CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      recipe_id = CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      -- U3 (Codex R3 P2): three-way — key ABSENT (stale/cached client on the old
      -- payload shape) preserves the saved service; key present-but-empty is an
      -- explicit clear; a uuid sets it. Prevents an old client's ordinary save
      -- from silently wiping a billing-impacting field.
      application_service_id = CASE
        WHEN NOT (p_job_payload ? 'application_service_id') THEN application_service_id
        WHEN p_job_payload->>'application_service_id' IS NOT NULL AND p_job_payload->>'application_service_id' != ''
          THEN (p_job_payload->>'application_service_id')::uuid
        ELSE NULL END,
      notes = p_job_payload->>'notes',
      tags = CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      batch_id = p_job_payload->>'batch_id',
      season = v_season,
      -- DERIVED on the UPDATE path too, for the same reason as the INSERT above. Deriving it
      -- on one path only would leave the whole gap open on the other -- an EDIT is how a job
      -- would most plausibly acquire a header acreage its fields do not support.
      total_acres = v_acres,
      -- DERIVED, not taken from the caller.
      total_cost_cents = v_total_cost_cents,
      total_price_cents = v_total_price_cents,
      call_date = NULLIF(p_job_payload->>'call_date','')::date,
      date_proposed = NULLIF(p_job_payload->>'date_proposed','')::date,
      time_proposed = NULLIF(p_job_payload->>'time_proposed','')::time,
      schedule_date = NULLIF(p_job_payload->>'schedule_date','')::date,
      date_expires = NULLIF(p_job_payload->>'date_expires','')::date,
      consultant_id = CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      loader_comment = p_job_payload->>'loader_comment',
      additional_info = p_job_payload->>'additional_info',
      internal_memo = p_job_payload->>'internal_memo',
      updated_by = v_actor
    WHERE id = v_job_id;
  END IF;

  -- Replace fields (now incl. agronomy: planted_acres, crop, strip, pests)
  DELETE FROM job_fields WHERE job_id = v_job_id;
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, planted_acres, crop, strip, pests, sort_order)
    VALUES (
      v_job_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'acres_to_treat')::numeric,
      NULLIF(v_field->>'planted_acres','')::numeric,
      v_field->>'crop',
      v_field->>'strip',
      v_field->>'pests',
      COALESCE((v_field->>'sort_order')::integer, 0)
    );
  END LOOP;

  -- Replace per-field customer shares. Each field's shares must total 100%
  -- (mirrors the field-app split invariant so section #26 can split cleanly).
  -- A share whose field_id is NOT one of the job's fields (a stale defaults
  -- response or a hand-built payload) is REJECTED — otherwise the Jobs list /
  -- the #26 split would surface a customer/field that is not on the job (Codex P2).
  DELETE FROM job_field_shares WHERE job_id = v_job_id;
  IF p_job_payload->'field_shares' IS NOT NULL THEN
    -- Reject any share pointing at a field not in p_fields.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid NOT IN (
         SELECT (f->>'field_id')::uuid FROM jsonb_array_elements(p_fields) f
       )
    ) THEN
      RAISE EXCEPTION 'SHARE_FIELD_NOT_ON_JOB';
    END IF;

    -- Validate: per field, the sum of split_pct == 100 (within rounding).
    FOR v_field_id IN
      SELECT DISTINCT (s->>'field_id')::uuid
      FROM jsonb_array_elements(p_job_payload->'field_shares') s
    LOOP
      SELECT COALESCE(SUM((s->>'split_pct')::numeric), 0)
        INTO v_share_total
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid = v_field_id;
      IF ROUND(v_share_total, 2) <> 100 THEN
        RAISE EXCEPTION 'SHARE_NOT_100' USING DETAIL = 'Field shares must total 100%; got ' || v_share_total;
      END IF;
    END LOOP;

    FOR v_share IN SELECT * FROM jsonb_array_elements(p_job_payload->'field_shares') LOOP
      INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
      VALUES (
        v_job_id,
        (v_share->>'field_id')::uuid,
        (v_share->>'customer_id')::uuid,
        (v_share->>'split_pct')::numeric,
        COALESCE((v_share->>'is_primary')::boolean, false)
      );
    END LOOP;
  END IF;

  -- Replace chemicals (now incl. extras: diluent_rate, rei_hours, phi_days,
  -- warehouse, vendor)
  DELETE FROM job_chemicals WHERE job_id = v_job_id;
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals) LOOP
    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied,
      sort_order, driver
    )
    VALUES (
      v_job_id,
      (v_chem->>'product_id')::uuid,
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit',
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit',
      COALESCE((v_chem->>'cost_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'price_per_unit_cents')::bigint, 0),
      NULLIF(v_chem->>'diluent_rate','')::numeric,
      NULLIF(v_chem->>'rei_hours','')::integer,
      NULLIF(v_chem->>'phi_days','')::integer,
      v_chem->>'warehouse',
      v_chem->>'vendor',
      -- U4<<< customer-supplied product: applied but not drawn/deducted/billed. (#53/#54)
      COALESCE((v_chem->>'customer_supplied')::boolean, false),
      -- >>>U4
      COALESCE((v_chem->>'sort_order')::integer, 0),
      -- F06: validated at the top of the invariant loop (NULL, 'rate' or 'qty'; '' folds
      -- to NULL). The table CHECK job_chemicals_driver_chk is the second line of defence.
      NULLIF(v_chem->>'driver', '')
    );
  END LOOP;

  v_result := jsonb_build_object('success', true, 'job_id', v_job_id, 'is_new', v_is_new);

  -- The receipt MUST carry the binding columns, or the next replay of this very key
  -- hits check_idempotency_intent's deployment bridge -- an unbound receipt whose intent
  -- cannot be reconstructed fails closed with IDEMPOTENCY_INTENT_MISMATCH -- and a
  -- legitimate retry would be refused. Writing the row and then binding it mirrors
  -- 20260819232000 exactly. IDEMPOTENCY_RECEIPT_MISSING is not decorative: it fires if
  -- the INSERT was swallowed and no row is there to bind, which would otherwise leave a
  -- silently unbindable receipt behind.
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'save_job', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;

    UPDATE idempotency_keys
       SET request_fingerprint = v_fingerprint,
           request_actor_id    = v_actor
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'save_job';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

-- =============================================================================
-- ESTABLISH the ACL this file goes on to assert. On live these three statements
-- are a NO-OP: the grants were read read-only on 2026-08-23 and already stand at
-- exactly `postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres`,
-- with `anon` holding nothing.
--
-- The reason they are here is simply that A FILE WHICH ASSERTS A SECURITY PROPERTY
-- SHOULD ALSO ESTABLISH IT. No migration in this repository has ever REVOKEd this
-- function from `anon` or `PUBLIC`, and the only grant it has ever received is
-- `TO authenticated` (migration 20260624120000), so the postflight below was
-- asserting a state nothing in the repo sets.
--
-- An earlier version of this comment justified them by a specific FROM-SCRATCH
-- REBUILD scenario, and a later one withdrew that narrative on the grounds that
-- migration 20260215200000 creates a FIVE-argument save_job which "nothing ever
-- drops", so a replay would abort at PREFLIGHT_OVERLOAD. THAT REASON WAS WRONG and
-- is corrected here rather than quietly deleted: 20260331600000_consolidate_all_
-- rpc_overloads.sql collects every save_job overload, DROPS ALL OF THEM, and
-- recreates a single unified one; every migration after it (20260530020452,
-- 20260609190820, 20260624120000, 20260706020000, 20260706080000) recreates the
-- SAME six-argument signature. A clean replay therefore converges on exactly one
-- overload, which is also what live carries (read read-only 2026-08-24: one row,
-- pronargs 6). The rebuild narrative stays withdrawn anyway -- not because a replay
-- would abort, but because this file has never been replayed from scratch and an
-- unrun scenario is not evidence.
-- The prover does not replay the chain -- it builds a real-shape schema and
-- installs the reviewed pre-change body directly. What IS proven is narrower and
-- enough: prover phase 4 stages a deliberately bad ACL (anon granted, service_role
-- revoked) and requires the apply to correct it, and five mutation phases require
-- the apply to ABORT when the SECURITY DEFINER declaration, the pinned search_path,
-- the anon REVOKE, the PUBLIC REVOKE or the service_role GRANT is removed. Claim
-- only that.
--
-- asserting alone was the round-3 review finding.
--
-- caller-analysis: save_job :: the one live caller is the authenticated job-save
-- UI (src/pages/JobDetail.tsx:2210, via the shared client in src/lib/db.ts, which
-- carries the signed-in user's JWT and therefore the `authenticated` role). That
-- role is GRANTed on the line below and is unaffected. Nothing in the repository
-- calls this RPC as `anon` or over the public/service key: the body itself raises
-- AUTH_REQUIRED when auth.uid() IS NULL and then admits only active `admin` or
-- `sales_rep` profiles, so an anon caller could never have completed a save even
-- while holding EXECUTE. Live confirms no dependency on the revoked grants --
-- `anon` already holds nothing and there is no bare PUBLIC entry in proacl.
-- =============================================================================
REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated, service_role;

-- =============================================================================
-- POSTFLIGHT. Assert that the function ended up with every security property it is
-- supposed to have.
--
-- BE HONEST ABOUT WHAT THESE NOW PROVE. Before the ACL statements above existed, the four
-- grant assertions were independent evidence about state this file did not set. They are
-- not that any more: the REVOKEs and the GRANT execute in this same transaction three
-- statements earlier, so the ACL checks can no longer fail, and the SECDEF and search_path
-- checks restate what the CREATE OR REPLACE literally declares. That is the right trade --
-- establishing a security property beats asserting one, and a file that only asserted
-- would abort on a rebuilt database rather than fix it -- but it does mean the postflight
-- is now a belt-and-braces restatement rather than a probe.
--
-- What still makes them worth keeping: they are the tripwire the MUTATION PHASES fire.
-- prove-save-job-chem-unit-invariant.mjs installs five mutants -- downgrade to SECURITY
-- INVOKER, delete the search_path pin, delete the anon REVOKE, delete the PUBLIC REVOKE,
-- drop the service_role GRANT -- and requires the apply to abort with
-- POSTFLIGHT_NOT_SECURITY_DEFINER, POSTFLIGHT_SEARCH_PATH, POSTFLIGHT_ANON_EXECUTE,
-- POSTFLIGHT_PUBLIC_EXECUTE and POSTFLIGHT_GRANT_LOST respectively. So the assertions are
-- exercised against a broken file even though they cannot fail against a correct one.
-- That is not a formality: the PUBLIC mutant is what exposed the assertion-ORDERING bug
-- fixed below, where a PUBLIC grant reported itself under the anon message.
-- =============================================================================
DO $postflight$
DECLARE
  v_oid     oid;
  v_count   integer;
  v_secdef  boolean;
  v_config  text[];
  v_acl     text;
  v_owner   text;
BEGIN
  -- Written as a plain literal on purpose. An earlier draft built this name by
  -- concatenation; review flagged that a grep for the function name would then miss the
  -- two catalog assertions that pin it, which is the opposite of what an auditable
  -- security check should do. No guard in .claude/hooks/ keys on this name, so the
  -- concatenation bought nothing and cost readability.
  v_oid := to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_MISSING: the six-argument job-save RPC is absent after replacement.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = (SELECT proname FROM pg_proc WHERE oid = v_oid);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: expected exactly 1 overload after replacement, found % -- a second overload silently splits callers.', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, COALESCE(array_to_string(p.proacl, ','), '')
    INTO v_secdef, v_config, v_acl
    FROM pg_proc p WHERE p.oid = v_oid;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_NOT_SECURITY_DEFINER: the replacement dropped SECURITY DEFINER.';
  END IF;

  -- THE OWNER IS PINNED, and round 25 added it because every other property here was
  -- (MEDIUM, gpt-5.6-sol, 2026-08-24). SECURITY DEFINER means "runs with the OWNER's
  -- rights", so the owner is the privilege this function executes under -- and CREATE OR
  -- REPLACE deliberately PRESERVES the existing owner. Asserting prosecdef without
  -- asserting proowner therefore checks that the function borrows someone's rights while
  -- saying nothing about whose: a function re-owned by a lesser or a different role passes
  -- every other assertion in this block unchanged.
  --
  -- Read read-only from live 2026-08-24: save_job is owned by 'postgres', as are
  -- normalize_rate_unit, field_app_priced_quantity and check_idempotency_intent, so the
  -- inner calls this body makes run under the same owner they do today.
  --
  -- Fail-closed on a MISSING role for the same reason the grant checks are: "the expected
  -- owner does not exist" is not evidence that the owner is fine.
  SELECT r.rolname INTO v_owner
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = v_oid;
  IF v_owner IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION
      'POSTFLIGHT_OWNER: expected the job-save RPC to be owned by "postgres", found %. A SECURITY DEFINER function executes with its OWNER''s rights, so a changed owner changes what this function may do.',
      COALESCE(v_owner, '<none>');
  END IF;

  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SEARCH_PATH: expected a pinned search_path, found %', COALESCE(array_to_string(v_config, ','), '<none>');
  END IF;

  -- Every role NAME is checked for existence before it is handed to
  -- has_function_privilege(). Passing a name that no role carries does not return false --
  -- PostgreSQL raises 'role "..." does not exist', which aborts the apply with a raw
  -- catalog error instead of the named POSTFLIGHT_* assertion written to explain it. The
  -- apply still fails closed either way, so this is about the DIAGNOSIS, not the safety:
  -- on a rebuilt or non-Supabase database the operator would see a bare role error and
  -- have no idea which assertion tripped. Raised by CodeRabbit on 2026-08-24.
  --
  -- A MISSING role is itself a refusal, not a pass. Treating "the role does not exist" as
  -- "the grant is fine" would be the fail-open reading, and it is exactly how an ACL
  -- assertion turns into decoration.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ROLE_MISSING: role "authenticated" does not exist, so the EXECUTE grant this migration depends on cannot be verified.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ROLE_MISSING: role "service_role" does not exist, so the EXECUTE grant this migration depends on cannot be verified.';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT_LOST: authenticated no longer holds EXECUTE; the app would break.';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT_LOST: service_role no longer holds EXECUTE.';
  END IF;

  -- anon must never reach a SECURITY DEFINER write path, and the default PUBLIC
  -- grant must stay revoked. A bare "=X/" entry in the ACL is the PUBLIC grant.
  --
  -- PUBLIC is tested FIRST, and the order is load-bearing rather than cosmetic. A grant to
  -- PUBLIC reaches every role, so has_function_privilege('anon', ...) is TRUE whenever
  -- PUBLIC holds EXECUTE. With the anon test first, a PUBLIC grant reported itself as
  -- POSTFLIGHT_ANON_EXECUTE -- naming one role while every role was in fact exposed, and
  -- pointing a reader at the wrong REVOKE. The mutation phase caught this: the mutant that
  -- stages a PUBLIC grant aborted the apply, but with the anon message, so it proved
  -- nothing about the assertion it was written for. Broadest grant, reported first.
  IF v_acl ~ '(^|,)=X/' THEN
    RAISE EXCEPTION 'POSTFLIGHT_PUBLIC_EXECUTE: PUBLIC holds EXECUTE, so every role reaches this SECURITY DEFINER write path (acl=%)', v_acl;
  END IF;
  -- anon is guarded the OPPOSITE way round from the two grants above, and deliberately so.
  -- A role that does not exist cannot hold EXECUTE, so "anon is absent" genuinely satisfies
  -- this assertion and skipping is fail-CLOSED. The two grant checks above cannot be skipped
  -- on the same reasoning, because there "the role is absent" would leave a required grant
  -- unverified -- which is why that case raises instead.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_ANON_EXECUTE: anon holds EXECUTE on a SECURITY DEFINER write path.';
  END IF;
END
$postflight$;

-- ----------------------------------------------------------------------------
-- 3. F06 POSTFLIGHT. The security postflight above is unchanged from 20260820120000; this
--    block asserts what THIS file adds. Like the rest, it is the tripwire the mutation
--    phases of the prover fire.
-- ----------------------------------------------------------------------------
DO $postflight_f06$
DECLARE
  v_src text;
  v_def text;
BEGIN
  -- The column must be EXACTLY nullable text with no default and no generation
  -- expression -- the same shape the column-drift pin demands up front.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.job_chemicals'::regclass
       AND a.attname = 'driver' AND NOT a.attisdropped
       AND format_type(a.atttypid, a.atttypmod) = 'text'
       AND NOT a.attnotnull AND a.attgenerated = '' AND NOT a.atthasdef
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_COLUMN: job_chemicals.driver is missing or is not a nullable, default-free, non-generated text column after apply.';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.job_chemicals'::regclass
     AND c.conname  = 'job_chemicals_driver_chk';
  IF v_def IS DISTINCT FROM 'CHECK (((driver IS NULL) OR (driver = ANY (ARRAY[''rate''::text, ''qty''::text]))))' THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_CHECK: job_chemicals_driver_chk is missing or differs from the intended definition (got %).', COALESCE(v_def, '<none>');
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
  IF v_src IS NULL OR md5(v_src) <> '18d08d5f40aea91fe13ac3e5a686c549' THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_BODY: the installed body md5 is %, not the 18d08d5f40aea91fe13ac3e5a686c549 this file declares; the preflight replay pin would not recognise it.', COALESCE(md5(v_src), '<none>');
  END IF;
  IF position('chem_unit_invariant_v3' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_MARKER: the installed body does not carry chem_unit_invariant_v3.';
  END IF;
  IF position('chem_unit_invariant_v2' IN v_src) > 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_MARKER: the installed body still mentions the v2 marker token, so 20260820120000 could replay over it unrefused.';
  END IF;
  IF position('CHEM_DRIVER_INVALID' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_REFUSAL: the installed body does not raise CHEM_DRIVER_INVALID.';
  END IF;
  IF v_src !~ 'sort_order,\s*driver\s*\)' THEN
    RAISE EXCEPTION 'POSTFLIGHT_F06_INSERT: the installed body does not insert job_chemicals.driver.';
  END IF;
END
$postflight_f06$;

COMMENT ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) IS $sjc$Saves a job with its fields, customer shares, and chemical lines. Enforces the chemical-unit invariant server-side and DERIVES total_cost_cents / total_price_cents from the chemical lines via safe_cents_qty, ignoring caller-supplied totals. THIRTEEN refusals, all raised before any write. Units: CHEM_UNIT_MISMATCH (rate unit and price unit provably disagree), CHEM_UNIT_FORM_MISMATCH (a DRY product measured or priced in fluid ounces on either side, in ANY spelling -- both sides are reduced to the unit they name, so a denominator does not hide it), CHEM_UNIT_UNSPECIFIED (a line that BILLS while its rate unit or stock unit is blank), CHEM_UNIT_UNSUPPORTED_CHARACTER (a priced line whose unit contains a character this function cannot read -- the fold refuses rather than discarding, because deleting an unreadable character erases a denominator instead of catching it), CHEM_RATE_UNIT_UNRECOGNIZED (a priced line naming a unit that is neither a normalize_rate_unit canonical output nor a live unit_conversions spelling), CHEM_RATE_DENOMINATOR_NOT_ACRES (a rate measured per anything but acres, in slash, spelled-out, hyphenated, stacked or leading form) and CHEM_STOCK_UNIT_IS_A_RATE (a PRICED line whose STOCK unit carries a denominator of its own -- the Unit says what the quantity counts and what the price is quoted per, so "oz/ac" there names a rate rather than a quantity; every earlier denominator rule examined rate_unit only, and normalize_rate_unit silently stripped the per-acre suffix off the stock side). Quantities: CHEM_QUANTITY_NOT_FINITE (negative, NaN or Infinity), CHEM_QUANTITY_NOT_DERIVED (quantity disagrees with rate x acres -- enforced on the units-EQUAL path too, since matching units prove what is counted and nothing about how many), CHEM_QUANTITY_ZERO_BUT_EXPECTED (a PRICED line recording zero applied where a positive quantity was derivable) and CHEM_QUANTITY_UNVERIFIABLE (a PRICED line whose quantity cannot be checked at all, which closes the bypass of simply omitting the rate). Job fields: JOB_ACRES_NOT_FINITE (a field acreage that is negative, NaN or Infinity -- every field must carry a real, finite, non-negative number of acres to treat, checked before any write, so a non-finite acreage can neither bypass the invariant nor be stored through this RPC; the table-level residual, that OTHER writers and direct DML face no such check, is recorded in 20260820120000's KNOWN RESIDUALS block). This twelfth refusal was added in review round 24 (2026-08-24); the first draft of this comment counted eleven and was corrected by the follow-up comment-only migration. Calculator driver: CHEM_DRIVER_INVALID (a chemical line whose `driver` is neither "rate", "qty" nor blank -- F06, 2026-09-03: the payload now records which field the operator typed so a reloaded line can re-derive the other side when the acreage changes; blank means unknown and is left exactly as saved; the value is stored on job_chemicals.driver and read by no refusal and no money derivation). ZERO-QUANTITY LINES ARE NOT FLATLY EXEMPT -- that was true before round 17 and is not now. The exit survives only where zero is genuinely right: customer_supplied, no PRICE (nothing can be under-charged), or no usable rate/acreage (nothing was expected). Per the Mason 2026-08-24 rule the money refusals key on PRICE, so a cost-only line can still misstate margin -- an accepted, recorded residual. THE LIMIT OF ALL OF IT: every refusal checks that units are INTERNALLY CONSISTENT; none checks that a rate is PLAUSIBLE. A milligram per acre of a $931/lb product passes every one of these and invoices six orders of magnitude low. See the banner block in the header of this migration file. CLIENT MIRROR (current as of 2026-09-03, F06): JobDetail.tsx also mirrors CHEM_QUANTITY_NOT_DERIVED per line with the same tolerance, so an acreage change on a line whose driver is unknown is shown on screen instead of surfacing as a whole-save rollback. Earlier text: since PR #436 merged on 2026-08-25, JobDetail.tsx carries a save-BLOCKING client-side mirror -- chemRowDefects fails closed on blank or non-finite quantities, on a billing line whose rate unit or stock unit is blank (mirroring CHEM_UNIT_UNSPECIFIED), and on unrecognized rate denominators -- so the operator normally sees an on-screen refusal before the server does. This function remains the authoritative boundary: the client mirror is a courtesy for old tabs and direct API callers do not pass through it, and it must never be more lenient than the SQL. IDEMPOTENCY: a keyed save now goes through check_idempotency_intent (the same helper the return and commission-payment RPCs use), so the key is bound to the calling actor AND to a sha256 fingerprint of the requested job, fields and chemical lines, under an advisory lock. Reusing a spent key for a different operation raises IDEMPOTENCY_CROSS_OP_KEY_REUSE, from a different actor IDEMPOTENCY_ACTOR_MISMATCH, and with a changed payload IDEMPOTENCY_INTENT_MISMATCH -- the last of which is a REFUSAL WHERE THE OLD BODY SILENTLY RETURNED THE EARLIER SUCCESS AND SAVED NOTHING. An unchanged retry still replays to the same job, which is the whole point of the key.$sjc$;

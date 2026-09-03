-- idempotency-body-check: exempt -- none of the eight mutates a business row.
-- next_invoice_number allocates from a sequence, which is deliberately
-- non-idempotent by nature and cannot take p_idempotency_key without minting a
-- second overload and breaking the invoices.invoice_number column DEFAULT
-- described below. Pre-existing shape, not introduced here.
--
-- F2 (docs/manual/KNOWN_ISSUES.md): gate the eight SECURITY DEFINER number
-- generators behind an active profile and an appropriate role.
--
-- Before this migration all eight granted EXECUTE to `authenticated` and checked
-- nothing, so any logged-in principal -- including a deactivated profile and the
-- two customer-portal `entity_recipient` accounts -- could enumerate the next
-- business document number and contend for each generator's advisory lock.
-- `next_invoice_number` is worse than disclosure: it calls nextval() and
-- conditionally setval() on four invoice sequences, so an unauthorized caller
-- could advance live invoice numbering.
--
-- The gate goes INSIDE each body, not on the grants: src/pages/CycleCounts.tsx
-- and src/pages/JobDetail.tsx call two of these directly from the browser as
-- `authenticated`, so a REVOKE would break both screens. Grants are unchanged.
--
-- Role sets are the union of (a) the roles that can reach the creating surface
-- in src/lib/pagePermissions.ts and (b) the roles admitted by every live
-- SECURITY DEFINER RPC that calls the generator internally, so no existing
-- successful path regresses. Verified live 2026-09-03 read-only:
--   * 18 internal RPCs call these generators. `_complete_delivery_authorized_impl`
--     admits admin, sales_rep, or the delivery's OWN assigned driver, and it
--     already requires `is_active = true`. A driver completing their assigned
--     delivery reaches next_invoice_number via auto-invoice, so `driver` belongs
--     in the invoice and delivery sets. CORRECTED 2026-09-03 against LIVE prosrc
--     after adversarial review: an earlier draft of this comment said that
--     function "checks auth but not role", which is false. The conclusion did
--     not change, but the reason is load-bearing -- this derivation is exactly
--     what anyone widening or narrowing these sets is told to re-run below, and
--     the real path is TIGHTER than the wrong reason implied (assigned driver
--     only, active only), not looser.
--   * `complete_job` admits applicator, but its invoice branch goes through
--     `transfer_job_to_invoice`, which already requires admin/sales_rep -- so
--     applicator is NOT added to the invoice set and nothing regresses.
--   * No Edge Function and no cron job reaches a generator, directly or through
--     a caller, so gating on auth.uid() cannot break a background path. All 8
--     live cron.job entries and supabase/functions/ were checked;
--     process-blend-ticket is the only service_role function that touches
--     `invoices` and it only SELECTs.
--
-- FOURTH INVOCATION CHANNEL -- a column DEFAULT, which no function-body scan can
-- see. Confirmed live 2026-09-03: `invoices.invoice_number` carries
--     DEFAULT next_invoice_number('field_application'::text)
-- (set by 20260526151856, never dropped). So any INSERT INTO invoices that omits
-- invoice_number invokes the generator, and after this migration such an insert
-- raises AUTH_REQUIRED when it runs without a JWT -- a service_role insert, an
-- MCP/SQL-editor repair, or a future migration -- and INSUFFICIENT_ROLE under a
-- role outside {admin, sales_rep, driver}. That is a deliberate consequence, not
-- an oversight: creating an invoice with no identity is exactly what this change
-- refuses. Live check of all 12 routines that INSERT INTO invoices found exactly
-- one that omits invoice_number and thus relies on the DEFAULT,
-- `_create_split_invoices_from_order_provenance_impl_20260719`, which already
-- requires admin/sales_rep, so no current path regresses. Anyone widening or
-- narrowing the invoice role set must re-derive this channel too.
--
-- Every set excludes deactivated profiles and `entity_recipient`. Refusals use
-- the codebase's existing shape: AUTH_REQUIRED / INSUFFICIENT_ROLE. The gate is
-- placed BEFORE each advisory lock so an unauthorized caller cannot take the
-- lock either.
--
-- FIDELITY. Each body below is SEMANTICALLY IDENTICAL to the live definition --
-- same statements, advisory-lock keys, regexes, split_part indexes and lpad
-- widths -- with only the gate and its `v_actor uuid;` declaration added. That
-- is not merely asserted: scripts/smoke/prove-number-generator-gates.mjs strips
-- the gate back out of each applied body and requires the remainder to match the
-- live prosrc md5 read on 2026-09-03, so any accidental drift fails the proof.
-- The live bodies were read AFTER 20260831235900_serialize_gauntlet_write_boundaries
-- applied. That migration and five other 2026-08-31 files are applied live but
-- absent from `main`; all six are carried by PR #535's branch
-- codex/gauntlet-s9-safety-20260831, so merging it closes the gap. Until then
-- `main` alone cannot show the state these bodies were read from, which is
-- exactly why the pins in the PREFLIGHT below are taken from live rather than
-- from disk.
--
-- SEARCH_PATH IS PRESERVED, NOT CHANGED. The pins hash `prosrc` only, and
-- `proconfig` is not part of `prosrc`, so a settings change would be invisible
-- to them. Adversarial review flagged this on 2026-09-03, reading the on-disk
-- ancestors, where seven of the eight declare `SET search_path = public` and
-- next_commission_payment_number declares `SET search_path = ''` -- which would
-- have made the `public, pg_temp` below an undisclosed posture change. Checked
-- against LIVE `pg_proc.proconfig` the same day: all eight already carry
-- exactly `search_path=public, pg_temp`, so this migration reproduces the live
-- setting and changes nothing. The finding was a false positive caused by
-- reading disk instead of live -- which is precisely the hazard described
-- above, arriving from the other direction.

-- ---------------------------------------------------------------------------
-- PREFLIGHT -- refuse to overwrite a body that is not the one that was reviewed.
--
-- Every CREATE OR REPLACE below is unconditional. The md5 pins proving these are
-- the bodies this migration was written against previously lived ONLY in
-- scripts/smoke/prove-number-generator-gates.mjs -- an offline container proof
-- that never touches production -- so nothing verified the live bodies at APPLY
-- time. If any lane re-emitted one of the eight between the 2026-09-03 read and
-- this apply, the replacement would silently erase that change, and the
-- postflight would still pass, because it asserts generic markers (gate text,
-- advisory lock, ACL, search_path) and not the prior semantics. Six 20260831*
-- migrations are applied live with no file on `main`, so drift here is a
-- demonstrated condition in this repository, not a hypothetical. The window is
-- real and open: this migration waits for an explicit approval, so an arbitrary
-- amount of time can pass between the read and the apply.
--
-- For each generator this requires the current normalized prosrc md5 to be
-- EITHER the reviewed pre-image, OR the exact body this migration installs (so a
-- re-apply is a no-op rather than fatal). Anything else aborts the transaction
-- and names the function. The second case is an EXACT hash comparison and NOT a
-- "looks gated" token test -- a token test would accept a later migration's
-- improved body and silently revert it; see the comment on that branch.
--
-- KNOWN AND ACCEPTED: this makes the file un-appliable to a database rebuilt
-- from this repository's migrations, because the on-disk ancestors of these
-- bodies differ from live. That rebuild is already impossible for an unrelated
-- reason -- six 20260831* migrations are applied live with no file on `main` --
-- and production, the only target this file is written for, matches the pins.
-- Raised as HIGH by adversarial review 2026-09-03 and accepted deliberately:
-- refusing to silently overwrite production is worth more than a replay path
-- that does not currently work.
--
-- Hashes are md5 over prosrc with per-line trailing whitespace stripped:
-- next_cycle_count_number carries 9 characters of trailing whitespace live that
-- a checked-in .sql cannot reproduce; the other seven are unaffected by it.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_expected CONSTANT jsonb := jsonb_build_object(
    'next_application_record_number', 'f5ebf20dc5f4982097e4dfb226156ea8',
    'next_commission_payment_number', 'd614a9489826c8b4837a466f884b022b',
    'next_cycle_count_number',        'b8d37b2ba9ef790eaa8fca8bacdb9f5f',
    'next_delivery_number',           'd13c37ceaea3c2f00293bfb2b1a2a215',
    'next_invoice_number',            '871a39420353d23f3064261231c95531',
    'next_job_number',                'a8249edef5733015f6d8e8c669caf55e',
    'next_po_number',                 'c077318f1748f1d42c56c49439bfe985',
    'next_return_number',             'b02f5a71f91148152c0cb67ab5ba5d0a'
  );
  -- The bodies this migration itself installs, hashed the same way. Used for
  -- the re-apply case: see the comment on the second branch below.
  v_applied CONSTANT jsonb := jsonb_build_object(
    'next_application_record_number', '4d26d0ee0176d8e6b630314c34b1cc4e',
    'next_commission_payment_number', '6d4208fe79a2b021fd9752e862266f45',
    'next_cycle_count_number',        '2bce8cb943a36951bc605ed55f2636df',
    'next_delivery_number',           'ae70da873eeea640e59876fe1a169eed',
    'next_invoice_number',            'b53499d077bd84b78a6f8fec142741bc',
    'next_job_number',                '183721b3349f15162c068f58e2877b5d',
    'next_po_number',                 '448fc5d0dbfbba0a8ae11b96e4ee9fcb',
    'next_return_number',             '8e8acd85a14248cfeccfd7cc5a047c29'
  );
  v_name text;
  v_pin  text;
  v_count int;
  v_src  text;
  v_md5  text;
BEGIN
  FOR v_name, v_pin IN SELECT key, value FROM jsonb_each_text(v_expected) LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_count = 0 THEN
      RAISE EXCEPTION 'PREFLIGHT: public.% does not exist; refusing to create a gated generator where none was reviewed', v_name;
    END IF;
    IF v_count > 1 THEN
      RAISE EXCEPTION 'PREFLIGHT: public.% has % overloads; the reviewed state had exactly one', v_name, v_count;
    END IF;

    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    v_md5 := md5(regexp_replace(v_src, '[ \t]+$', '', 'gn'));

    IF v_md5 = v_pin THEN
      CONTINUE;
    END IF;

    -- Re-apply case. This deliberately requires the EXACT body this migration
    -- installs, not merely a body that looks gated. An earlier revision tested
    -- for the presence of AUTH_REQUIRED / INSUFFICIENT_ROLE / is_active, which
    -- accepted an unbounded set of bodies: a LATER migration that widened a role
    -- set or fixed a lpad width would still contain all three tokens, so
    -- re-running this file would have silently reverted that work while printing
    -- a reassuring NOTICE. That is the same "generic markers, not semantics"
    -- weakness this preflight exists to close, so it must not be reintroduced
    -- here. Raised by adversarial review 2026-09-03.
    IF v_md5 = v_applied ->> v_name THEN
      RAISE NOTICE 'PREFLIGHT: public.% already carries exactly this migration body; re-apply is a no-op.', v_name;
      CONTINUE;
    END IF;

    RAISE EXCEPTION 'PREFLIGHT: public.% is neither the reviewed pre-image (md5 %) nor the body this migration installs (md5 %); found %. Refusing to overwrite it -- a later change may be sitting here. Re-read the live body, re-review, and re-pin before applying.', v_name, v_pin, v_applied ->> v_name, v_md5;
  END LOOP;

  RAISE NOTICE 'PREFLIGHT: all eight generators match the reviewed pre-image or are already gated.';
END
$preflight$;

CREATE OR REPLACE FUNCTION public.next_application_record_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'applicator')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_application_record_number'));
  SELECT COALESCE(
    MAX(
      CASE
        WHEN record_number ~ ('^APP-' || v_year || '-\d+$')
        THEN CAST(split_part(record_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM application_records;
  v_next := 'APP-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_commission_payment_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text;
  v_seq  integer;
  v_num  text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commission_payment_number'));
  v_year := to_char(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(
    MAX(
      regexp_replace(payment_number, '^CP-' || v_year || '-', '')::integer
    ), 0) + 1
    INTO v_seq
    FROM public.commission_payments
   WHERE payment_number LIKE 'CP-' || v_year || '-%';
  v_num := 'CP-' || v_year || '-' || lpad(v_seq::text, 4, '0');
  RETURN v_num;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_cycle_count_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num integer;
  v_next_num integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::text;

  -- Advisory lock to prevent race conditions (use unique lock ID for cycle counts)
  PERFORM pg_advisory_xact_lock(8675309);

  -- Find the highest existing number for this year
  SELECT COALESCE(MAX(
    CASE
      WHEN count_number ~ ('^CC-' || v_year || '-\d+$')
      THEN (regexp_replace(count_number, '^CC-' || v_year || '-', ''))::integer
      ELSE 0
    END
  ), 0) INTO v_max_num
  FROM cycle_counts
  WHERE count_number LIKE 'CC-' || v_year || '-%';

  v_next_num := v_max_num + 1;

  RETURN 'CC-' || v_year || '-' || LPAD(v_next_num::text, 5, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_delivery_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('next_delivery_number'));
  SELECT COALESCE(
    MAX(
      CASE
        WHEN delivery_number ~ '^DEL-\d+$'
        THEN CAST(split_part(delivery_number, '-', 2) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM deliveries;
  v_next := 'DEL-' || lpad((v_max_num + 1)::text, 5, '0');
  RETURN v_next;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application'::text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text := extract(year FROM now())::text;
  v_seq int;
  v_max int;
  v_prefix text;
  v_sequence regclass;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  CASE p_invoice_type
    WHEN 'chemical_sale' THEN
      v_prefix := 'CS';
      v_sequence := 'public.cs_invoice_number_seq'::regclass;
    WHEN 'misc_charge' THEN
      v_prefix := 'MC';
      v_sequence := 'public.mc_invoice_number_seq'::regclass;
    WHEN 'credit_memo' THEN
      v_prefix := 'CM';
      v_sequence := 'public.cm_invoice_number_seq'::regclass;
    ELSE
      v_prefix := 'INV';
      v_sequence := 'public.invoice_number_seq'::regclass;
  END CASE;

  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));

  SELECT COALESCE(MAX(regexp_replace(invoice_number, '^' || v_prefix || '-[0-9]{4}-', '')::integer), 0)
    INTO v_max
    FROM public.invoices
   WHERE invoice_number ~ ('^' || v_prefix || '-' || v_year || '-[0-9]+$');

  v_seq := nextval(v_sequence);
  IF v_seq <= v_max THEN
    PERFORM setval(v_sequence, v_max, true);
    v_seq := nextval(v_sequence);
  END IF;

  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_job_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep', 'applicator')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_job_number'));
  SELECT COALESCE(
    MAX(
      CASE
        WHEN job_number ~ ('^JOB-' || v_year || '-\d+$')
        THEN CAST(split_part(job_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM jobs;
  v_next := 'JOB-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_po_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));
  SELECT COALESCE(
    MAX(
      CASE
        WHEN po_number ~ ('^PO-' || v_year || '-\d+$')
        THEN CAST(split_part(po_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM purchase_orders;
  v_next := 'PO-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END;
$function$;

CREATE OR REPLACE FUNCTION public.next_return_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;

  -- Advisory lock to serialize access
  PERFORM pg_advisory_xact_lock(hashtext('next_return_number'));

  -- Find the current max numeric suffix for the current year
  SELECT COALESCE(
    MAX(
      CASE
        WHEN return_number ~ ('^RMA-' || v_year || '-\d+$')
        THEN CAST(split_part(return_number, '-', 3) AS int)
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_num
  FROM returns;

  v_next := 'RMA-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');

  RETURN v_next;
END;
$function$;

-- Grants are deliberately NOT re-emitted: CREATE OR REPLACE preserves the
-- existing ACL, and the two browser call sites depend on `authenticated`
-- keeping EXECUTE. The postflight block below proves that held.

DO $postflight$
DECLARE
  v_name text;
  v_names text[] := ARRAY[
    'next_application_record_number',
    'next_commission_payment_number',
    'next_cycle_count_number',
    'next_delivery_number',
    'next_invoice_number',
    'next_job_number',
    'next_po_number',
    'next_return_number'
  ];
  v_proc pg_proc%ROWTYPE;
  v_count int;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'POSTFLIGHT: expected exactly 1 public.%, found %', v_name, v_count;
    END IF;

    SELECT p.* INTO v_proc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF NOT v_proc.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT: % must remain SECURITY DEFINER', v_name;
    END IF;
    IF v_proc.proconfig IS NULL
       OR NOT ('search_path=public, pg_temp' = ANY (v_proc.proconfig)) THEN
      RAISE EXCEPTION 'POSTFLIGHT: % must SET search_path = public, pg_temp (found %)',
        v_name, v_proc.proconfig;
    END IF;
    IF position('AUTH_REQUIRED' in v_proc.prosrc) = 0 THEN
      RAISE EXCEPTION 'POSTFLIGHT: % is missing the AUTH_REQUIRED gate', v_name;
    END IF;
    IF position('INSUFFICIENT_ROLE' in v_proc.prosrc) = 0 THEN
      RAISE EXCEPTION 'POSTFLIGHT: % is missing the INSUFFICIENT_ROLE gate', v_name;
    END IF;
    IF position('is_active = true' in v_proc.prosrc) = 0 THEN
      RAISE EXCEPTION 'POSTFLIGHT: % is missing the active-profile check', v_name;
    END IF;
    -- entity_recipient must never appear in any allowed-role list.
    IF position('entity_recipient' in v_proc.prosrc) > 0 THEN
      RAISE EXCEPTION 'POSTFLIGHT: % must not admit entity_recipient', v_name;
    END IF;
    -- The gate must precede the advisory lock, or an unauthorized caller can
    -- still take the lock before being refused. position() returns 0 for a
    -- missing token, which would make the comparison below degrade silently in
    -- one direction and fire spuriously in the other, so both operands are
    -- proven non-zero first: INSUFFICIENT_ROLE by the check above, and the lock
    -- by this one. This is a source-offset test, not an execution-order test --
    -- it holds because in all eight bodies the gate is the first thing after
    -- BEGIN and the lock is unconditional, never inside a branch.
    IF position('pg_advisory_xact_lock' in v_proc.prosrc) = 0 THEN
      RAISE EXCEPTION 'POSTFLIGHT: % lost its advisory lock', v_name;
    END IF;
    IF position('INSUFFICIENT_ROLE' in v_proc.prosrc)
       > position('pg_advisory_xact_lock' in v_proc.prosrc) THEN
      RAISE EXCEPTION 'POSTFLIGHT: % gates after its advisory lock', v_name;
    END IF;

    IF NOT has_function_privilege('authenticated', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT: authenticated lost EXECUTE on % -- the two browser call sites would break', v_name;
    END IF;
    IF has_function_privilege('anon', v_proc.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT: anon must not hold EXECUTE on %', v_name;
    END IF;
  END LOOP;

  RAISE NOTICE 'POSTFLIGHT OK: 8 number generators gated, grants preserved';
END;
$postflight$;

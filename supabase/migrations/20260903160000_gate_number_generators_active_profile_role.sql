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
--   * 18 internal RPCs call these generators; `_complete_delivery_authorized_impl`
--     checks auth but not role and the deliveries surface admits `driver`, so a
--     driver completing a delivery reaches next_invoice_number via auto-invoice.
--     `driver` is therefore in the invoice and delivery sets.
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
-- applied; note that migration, and four others from 2026-08-31, are applied live
-- but have no file in this repository (real disk-vs-live drift, tracked
-- separately), so `main` alone cannot show the state these were read from.

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

-- ============================================================================
-- next_invoice_number: derive the invoice-number YEAR from the Chicago business
-- date, never from the UTC calendar day
-- ----------------------------------------------------------------------------
-- STATUS: NOT APPLIED
-- (This status line goes stale at apply time; the ledger is authoritative.)
--
-- PLAIN ENGLISH. Invoice numbers look like CS-2026-0007. The live database clock
-- runs in UTC; the business runs in America/Chicago. This function takes the year
-- from a bare now(), which on live is the UTC calendar year. December is CST
-- (UTC-6), so midnight UTC on 1 January is 6 pm Chicago on 31 December: for the six
-- hours from 6 pm Chicago until Chicago's own midnight, UTC has already rolled to
-- the new year while the business day has not. An invoice created in that window on
-- 2026-12-31 would be numbered CS-2027-0001.
-- (Verified read-only against live on 2026-09-05: 2027-01-01 02:00 UTC is
-- 2026-12-31 20:00 Chicago — UTC year 2027, Chicago year 2026.)
--
-- That is not cosmetic. The same v_year is used three times in one function:
--   * the advisory lock key             'invoice_number:CS:<year>'
--   * the MAX() scan that finds the highest number already issued for the year
--   * the number that is actually returned and stored
-- So the affected invoices are not merely mislabelled — they are numbered from a
-- DIFFERENT counter than the rest of that evening's work, in a year whose sequence
-- has not started yet, and they will collide with the real first invoices of 2027.
--
-- Same defect class as 20260904160000 (invoice_date fallbacks) and 20260904180000
-- (season follows invoice_date), both applied live 2026-09-04. This is the settled
-- ~2026-07-10 rule: a bare now()/CURRENT_DATE on live is a bug wherever a business
-- date is meant.
--
-- WHAT THIS CHANGES: exactly one line of one function body, re-emitted from its LIVE
-- installed text (read read-only from pg_proc.prosrc on 2026-09-05):
--     v_year text := extract(year FROM now())::text;
--  -> v_year text := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
-- Nothing else in the body moves. The active-profile/role gate added by
-- 20260903160000 is carried through unchanged — this file is emitted FROM the
-- post-gate live body, not from any earlier version.
--
-- WHAT THIS DOES NOT CHANGE: no data is rewritten. Invoice numbers already issued
-- keep their exact values; nothing is renumbered and nothing is deleted. No grant
-- moves — CREATE OR REPLACE preserves the ACL, which is
-- {postgres=X/postgres,service_role=X/postgres} (EXECUTE is NOT held by anon or
-- authenticated), and this file deliberately contains no GRANT or REVOKE.
-- SECURITY DEFINER and SET search_path = public, pg_temp are re-declared here.
-- The OWNER is not re-declared, because CREATE OR REPLACE cannot change one — it is
-- preserved, and both flights now PIN it (proowner = postgres) rather than assume it.
-- For a SECURITY DEFINER function the owner IS the effective privilege, so an owner
-- changed out of band must not pass silently. The sequences themselves are untouched.
--
-- SCOPE — READ THIS BEFORE CONCLUDING THE FAMILY IS CLEAN.
-- An earlier draft of this header claimed "the other seven embed no year at all".
-- That was FALSE, and the way it was false is worth keeping: the sweep asked which
-- generators read a year from now(), and only this one does. But SIX of the others
-- read a year from CURRENT_DATE, and on this server CURRENT_DATE *is* the UTC
-- calendar date (current_setting('TimeZone') = 'UTC', re-verified read-only
-- 2026-09-05) — the same rollover, the same six-hour window, the same defect:
--     next_application_record_number  v_year := extract(year FROM current_date)
--     next_commission_payment_number  v_year := to_char(CURRENT_DATE, 'YYYY')
--     next_cycle_count_number         v_year := EXTRACT(YEAR FROM CURRENT_DATE)
--     next_job_number                 v_year := extract(year FROM current_date)
--     next_po_number                  v_year := extract(year FROM current_date)
--     next_return_number              v_year := extract(year FROM current_date)
-- Only next_delivery_number (DEL-nnnnn) genuinely embeds no year.
-- Each of those six uses v_year in its lock key, its MAX() scan and its returned
-- number, exactly as this one does. They are NOT fixed by this file and they carry
-- the same 31 December 2026 deadline; they are recorded as a follow-up in
-- docs/manual/KNOWN_ISSUES.md. Do not read this migration as closing the family.
--
-- PREFLIGHT PIN. Refuses to run unless the installed body is byte-for-byte either the
-- reviewed starting body or this file's own candidate body (so a replay is a no-op
-- rather than a failure). A drifted body aborts the transaction with nothing changed.
--     live      b53499d077bd84b78a6f8fec142741bc  (length 1458, no CR bytes)
--  -> candidate 7cbf50ddfe3abda50cc241f3374e98a3  (length 1497, no CR bytes)
-- The pins are md5 of pg_proc.prosrc — the stored body text — NOT of any rendered
-- CREATE statement, whose header formatting is not stable across servers. The live
-- body is LF-only, so there is no CRLF preimage to accept here.
--
-- BEFORE APPLYING (not done by this file): run a throwaway-container proof in the
-- style of scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs — pins reproduce,
-- drift refused, apply, replay identical, postflight passes, and the new expression
-- shown to yield 2026 at a UTC instant where the old one yields 2027.
-- ============================================================================

-- NO top-level BEGIN/COMMIT, deliberately. scripts/apply-migration-file.mjs wraps the
-- migration AND its schema_migrations ledger row in ONE transaction, and
-- assertWrappable() (.claude/hooks/migration-wrappability-lib.mjs) REFUSES any file
-- carrying its own transaction control — a self-committing file can leave the schema
-- changed with no ledger row. An earlier draft opened its own transaction here and was
-- therefore unappliable through the only sanctioned door. The three statements below
-- still share one transaction; the applier provides it, so a failed preflight or
-- postflight still rolls the CREATE back.

-- ── PREFLIGHT ───────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_count        integer;
  v_md5          text;
  v_len          integer;
  v_cr           integer;
  v_nargs        integer;
  v_ndefaults    integer;
  v_default_expr text;
  v_secdef       boolean;
  v_config       text;
  v_owner        text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'next_invoice_number: expected exactly 1 overload, found % — refusing to re-emit into an ambiguous name',
      v_count;
  END IF;

  -- SIGNATURE PIN. md5(prosrc) hashes only the text BETWEEN the $fn$ markers, so
  -- it is blind to the declaration: argument names, types and DEFAULTS all sit
  -- outside it. Without this check a re-emit that silently dropped the parameter
  -- default would match the body pin perfectly and pass every other assertion.
  SELECT p.pronargs, p.pronargdefaults, pg_get_expr(p.proargdefaults, 0::oid)
    INTO v_nargs, v_ndefaults, v_default_expr
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF v_nargs <> 1 OR v_ndefaults <> 1
     OR v_default_expr IS DISTINCT FROM '''field_application''::text' THEN
    RAISE EXCEPTION
      'next_invoice_number: live signature is not the reviewed one (pronargs %, pronargdefaults %, default %). Expected 1 / 1 / ''field_application''::text.',
      v_nargs, v_ndefaults, COALESCE(v_default_expr, '(none)');
  END IF;

  SELECT md5(p.prosrc), length(p.prosrc), position(chr(13) in p.prosrc)
    INTO v_md5, v_len, v_cr
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF v_md5 NOT IN (
    'b53499d077bd84b78a6f8fec142741bc',  -- reviewed live body (2026-09-05)
    '7cbf50ddfe3abda50cc241f3374e98a3'   -- this file's candidate (idempotent replay)
  ) THEN
    RAISE EXCEPTION
      'next_invoice_number: installed body has DRIFTED (md5 %, length %, cr-at %). Expected the reviewed live body or this file''s candidate. Re-review against the current body before applying.',
      v_md5, v_len, v_cr;
  END IF;

  -- SECURITY PRE-STATE. These three live OUTSIDE prosrc, so the body pin above says
  -- nothing about them. Checking them only in the postflight would be too late to be
  -- informative: the CREATE OR REPLACE re-declares SECURITY DEFINER and search_path,
  -- so a live function that had been silently downgraded to SECURITY INVOKER, or had
  -- its search_path stripped, would be quietly REPAIRED by this migration with no
  -- operator signal that live had been tampered with. Fail loudly here instead.
  SELECT p.prosecdef, p.proconfig::text, pg_get_userbyid(p.proowner)
    INTO v_secdef, v_config, v_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF NOT v_secdef THEN
    RAISE EXCEPTION
      'next_invoice_number: the LIVE function is not SECURITY DEFINER. Live has been changed out of band — re-review before applying.';
  END IF;

  IF v_config IS DISTINCT FROM '{"search_path=public, pg_temp"}' THEN
    RAISE EXCEPTION
      'next_invoice_number: the LIVE search_path is %, expected {"search_path=public, pg_temp"}. Live has been changed out of band — re-review before applying.',
      COALESCE(v_config, '(none)');
  END IF;

  -- For a SECURITY DEFINER function the OWNER *is* the effective privilege: the body
  -- runs as them. CREATE OR REPLACE cannot change an owner, so this migration silently
  -- inherits whoever it is — which is exactly why it must be pinned rather than assumed.
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION
      'next_invoice_number: owner is %, expected postgres. A SECURITY DEFINER body runs as its owner, so this is a privilege change — re-review before applying.',
      v_owner;
  END IF;
END;
$preflight$;

-- ── RE-EMIT ─────────────────────────────────────────────────────────────────
-- Byte-identical to the live body except the single v_year line.
-- The DEFAULT is part of the live declaration and MUST be restated. PostgreSQL
-- refuses to remove a parameter default via CREATE OR REPLACE ("cannot remove
-- parameter defaults from existing function"), and the hint it offers — DROP
-- FUNCTION first — is the dangerous path: a fresh CREATE would get the default
-- EXECUTE TO PUBLIC, and the DROP would hit the invoices.invoice_number column
-- default that depends on this function. Live callers also invoke it with zero
-- arguments (e.g. _save_field_app_invoice_impl_20260714).
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application'::text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid;
  v_year text := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
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
$fn$;

-- ── POSTFLIGHT ──────────────────────────────────────────────────────────────
DO $postflight$
DECLARE
  v_md5    text;
  v_len    integer;
  v_cr     integer;
  v_secdef boolean;
  v_config text;
  v_acl    text;
  v_oid    oid;
  v_count  integer;
  v_nargs        integer;
  v_ndefaults    integer;
  v_default_expr text;
  v_owner        text;
  v_unexpected   text;
  v_year_utc     text;
  v_year_chicago text;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'next_invoice_number: re-emit produced % overloads, expected 1', v_count;
  END IF;

  SELECT md5(p.prosrc), length(p.prosrc), position(chr(13) in p.prosrc),
         p.prosecdef, p.proconfig::text, p.proacl::text, p.oid,
         pg_get_userbyid(p.proowner)
    INTO v_md5, v_len, v_cr, v_secdef, v_config, v_acl, v_oid, v_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF v_md5 <> '7cbf50ddfe3abda50cc241f3374e98a3' THEN
    RAISE EXCEPTION
      'next_invoice_number: installed body md5 is % (length %), expected the candidate 7cbf50ddfe3abda50cc241f3374e98a3',
      v_md5, v_len;
  END IF;

  IF v_cr <> 0 THEN
    RAISE EXCEPTION 'next_invoice_number: installed body contains CR bytes at position %; expected LF-only', v_cr;
  END IF;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'next_invoice_number: SECURITY DEFINER was lost by the re-emit';
  END IF;

  IF v_config IS DISTINCT FROM '{"search_path=public, pg_temp"}' THEN
    RAISE EXCEPTION 'next_invoice_number: search_path is now %, expected {"search_path=public, pg_temp"}', v_config;
  END IF;

  -- The signature must survive the re-emit, including the parameter DEFAULT.
  SELECT p.pronargs, p.pronargdefaults, pg_get_expr(p.proargdefaults, 0::oid)
    INTO v_nargs, v_ndefaults, v_default_expr
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'next_invoice_number';

  IF v_nargs <> 1 OR v_ndefaults <> 1
     OR v_default_expr IS DISTINCT FROM '''field_application''::text' THEN
    RAISE EXCEPTION
      'next_invoice_number: the re-emit changed the signature (pronargs %, pronargdefaults %, default %). Live callers invoke this with zero arguments and invoices.invoice_number defaults through it.',
      v_nargs, v_ndefaults, COALESCE(v_default_expr, '(none)');
  END IF;

  -- CREATE OR REPLACE preserves the ACL; this asserts the SECURITY PROPERTY rather
  -- than an exact string, so a database rebuilt without Supabase's service_role and
  -- default privileges (where the ACL is just {postgres=X/postgres}) still passes.
  -- What must never be true is an application role holding EXECUTE on a
  -- SECURITY DEFINER number generator — that is the B4/B9 anon-EXECUTE class, and it
  -- is invisible to a prosrc hash, so this is the only check that can catch an
  -- out-of-band grant added since the review.
  -- A NULL proacl is NOT "no grants". It means DEFAULT privileges, and the default for
  -- a function is EXECUTE TO PUBLIC — so NULL is the MOST open state, not the safest.
  -- An earlier draft guarded this block with `v_acl IS NOT NULL`, which skipped the
  -- whole assertion in exactly that case (and, because the SELECT coalesced NULL to the
  -- string '(null)', the LIKE arms could never have matched it either). Rejected
  -- explicitly now.
  IF v_acl IS NULL THEN
    RAISE EXCEPTION
      'next_invoice_number: proacl is NULL, which means DEFAULT privileges — EXECUTE is held by PUBLIC. Revoke it from PUBLIC and grant deliberately before applying.';
  END IF;

  -- has_function_privilege resolves role MEMBERSHIP, so it also catches EXECUTE
  -- reaching anon/authenticated INDIRECTLY through a role they belong to — which a text
  -- match on the ACL string cannot see. to_regrole returns NULL instead of raising when
  -- the role is absent, so a repo-only rebuild without Supabase's bootstrap roles still
  -- passes.
  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'next_invoice_number: anon holds EXECUTE (acl %). Only postgres/service_role may hold it.', v_acl;
  END IF;

  IF to_regrole('authenticated') IS NOT NULL
     AND has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'next_invoice_number: authenticated holds EXECUTE (acl %). Only postgres/service_role may hold it.', v_acl;
  END IF;

  -- Belt and braces: the literal PUBLIC forms in the ACL string ({=X/… and ,=X/…).
  -- Redundant wherever anon/authenticated exist, and the only remaining signal on a
  -- rebuild where they do not.
  IF v_acl LIKE '{=X/%' OR v_acl LIKE '%,=X/%' THEN
    RAISE EXCEPTION
      'next_invoice_number: PUBLIC holds EXECUTE (%). Only postgres/service_role may hold it.', v_acl;
  END IF;

  -- The three checks above name anon, authenticated and PUBLIC, but the failure text
  -- claims "only postgres/service_role may hold it" — a stronger statement than they
  -- verify. A grant to some OTHER role (a reporting role anon is not a member of, or
  -- Supabase's authenticator) would have passed all three. Enumerate the ACL and hold
  -- the check to what the message actually promises.
  SELECT string_agg(DISTINCT g.grantee_name, ', ' ORDER BY g.grantee_name)
    INTO v_unexpected
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    CROSS JOIN LATERAL (
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
    ) AS g(grantee_name)
   WHERE p.oid = v_oid
     AND a.privilege_type = 'EXECUTE'
     AND g.grantee_name NOT IN ('postgres', 'service_role');

  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'next_invoice_number: EXECUTE is held by % (acl %). Only postgres/service_role may hold it.',
      v_unexpected, v_acl;
  END IF;

  -- Assert the POSITIVE direction too. Every check above is a refusal; none of them
  -- would notice a drift that REMOVED the legitimate grant, leaving a function nobody
  -- can call. Precedent: 20260903160000 raises on "service_role lost EXECUTE — the
  -- revoke was too broad". Skipped on a repo-only rebuild where the role is absent.
  IF to_regrole('service_role') IS NOT NULL
     AND NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION
      'next_invoice_number: service_role LOST EXECUTE (acl %) — the function is now uncallable by the application.',
      v_acl;
  END IF;

  -- The owner survived. CREATE OR REPLACE cannot change one, so this can only fail if
  -- live was already tampered with — but for a SECURITY DEFINER body the owner is the
  -- privilege it runs with, so it is asserted on both sides rather than assumed.
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION
      'next_invoice_number: owner is now %, expected postgres. A SECURITY DEFINER body runs as its owner.',
      v_owner;
  END IF;

  -- Behavioural assertion, at an instant INSIDE the divergence window.
  -- December is CST (UTC-6), so midnight UTC on 1 January is 6 pm Chicago on
  -- 31 December. The window where the two disagree is therefore 00:00-06:00 UTC
  -- on 1 January. 02:00 UTC is 2026-12-31 20:00 Chicago: UTC already says 2027,
  -- the business day is still 2026.
  -- Both sides name their zone explicitly so this does not depend on the
  -- session TimeZone (a bare extract(year FROM timestamptz) renders in it).
  SELECT extract(year FROM (timestamptz '2027-01-01 02:00:00+00' AT TIME ZONE 'UTC'))::text,
         extract(year FROM (timestamptz '2027-01-01 02:00:00+00' AT TIME ZONE 'America/Chicago')::date)::text
    INTO v_year_utc, v_year_chicago;

  IF v_year_utc <> '2027' OR v_year_chicago <> '2026' THEN
    RAISE EXCEPTION
      'next_invoice_number: timezone assertion failed — utc gave %, chicago gave % (expected 2027 / 2026)',
      v_year_utc, v_year_chicago;
  END IF;
END;
$postflight$;

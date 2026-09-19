-- ============================================================================
-- Six document-number generators: derive the YEAR in the number from the
-- Chicago business date, never from the UTC calendar day (issue #617)
-- ----------------------------------------------------------------------------
-- STATUS: NOT APPLIED
-- (This status line goes stale at apply time; the ledger is authoritative.)
--
-- PLAIN ENGLISH. Jobs, purchase orders, returns, cycle counts, application
-- records and commission payments are numbered like JOB-2026-0042. The live
-- database clock runs in UTC (current_setting('TimeZone') = 'UTC', re-verified
-- read-only 2026-09-19), so CURRENT_DATE is the UTC calendar date. December is
-- CST (UTC-6): from 6 pm Chicago until Chicago midnight on 31 December, UTC has
-- already rolled into the new year. A job created at 8 pm on 2026-12-31 would be
-- numbered JOB-2027-0001.
--
-- WHAT THE DEFECT IS: a wrong-year LABEL. Each generator takes MAX(...) + 1 over
-- the numbers already issued for v_year, under an advisory lock, and returns
-- '<PREFIX>-' || v_year || '-nnnn'. A wrong v_year files that document under the
-- wrong year; the real first document of 2027 simply takes -0002. The wrong year
-- creates no duplicate and overwrites nothing. (Separate and pre-existing, NOT
-- changed here: the advisory lock is released when the RPC's transaction ends, so
-- next_job_number and next_cycle_count_number, which the browser calls as a
-- PREVIEW before a separate save, can show two users the same next number. That
-- race exists today with either year expression.)
--
-- WHAT THIS CHANGES: exactly ONE line in each of six function bodies, re-emitted
-- from their LIVE installed text (pg_proc.prosrc, read read-only 2026-09-19):
--   next_application_record_number  extract(year FROM current_date)::text
--   next_job_number                  extract(year FROM current_date)::text
--   next_po_number                   extract(year FROM current_date)::text
--   next_return_number               extract(year FROM current_date)::text
--     -> extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text
--   next_cycle_count_number          EXTRACT(YEAR FROM CURRENT_DATE)::text
--     -> EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::text
--   next_commission_payment_number   to_char(CURRENT_DATE, 'YYYY')
--     -> to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY')
-- The expression is the one next_invoice_number's fix
-- (20260914100100_next_invoice_number_year_chicago) uses. Each live body holds
-- that year line exactly once and reads no other clock (verified read-only
-- 2026-09-19), so nothing else in any body moves. The prefixes are live:
-- returns are numbered RMA-<year>-nnnn (issue #617 wrote RET-).
-- next_delivery_number (DEL-nnnnn) embeds no year and is untouched.
--
-- WHAT THIS DOES NOT CHANGE: no data is rewritten; issued numbers keep their
-- values. No GRANT or REVOKE: CREATE OR REPLACE preserves each ACL, and the
-- POSTFLIGHT pins it per function, because the six differ (an unexpected live
-- grant therefore makes the postflight refuse and the whole apply roll back). next_job_number and
-- next_cycle_count_number are called straight from the browser
-- (src/pages/JobDetail.tsx, src/pages/CycleCounts.tsx), so `authenticated`
-- holds EXECUTE on those two and must keep it; the other four are reached only
-- through other SECURITY DEFINER functions and are held by postgres and
-- service_role alone. SECURITY DEFINER and SET search_path = public, pg_temp are
-- re-declared. The owner (postgres) cannot be changed by CREATE OR REPLACE and
-- is pinned on both sides. All six take no arguments, so there is no parameter
-- DEFAULT to preserve; the flights pin pronargs = 0 anyway.
--
-- IDEMPOTENCY-KEY EXEMPTION: none of the six writes anything. Each reads the
-- year's MAX() under a transaction-scoped advisory lock and returns a string, so
-- a retried call consumes nothing and cannot apply a business action twice —
-- the thing the p_idempotency_key rule protects against. Adding a key would also
-- change the signature, which CREATE OR REPLACE cannot do. Same conclusion as
-- next_invoice_number's recorded exemption.
--
-- WHY THIS STAMP (20260908140000). It must sort ABOVE the live ordering
-- high-water 20260908130000_bind_create_inventory_hold_receipt_to_intent and is
-- deliberately BELOW the parked, unapplied cohort 20260914100100..20260914100900
-- (eight files; there is no 20260914100700).
-- The pending-migration guard refuses a file stamped above an unapplied tracked
-- migration, and forcing one through would lift the live high-water over that
-- cohort and strand all eight. Stamped below them, this file can apply first
-- (the 31 December deadline may not wait for the cohort) and leaves the high-water
-- beneath them. No file in that cohort references any of these six functions
-- (20260914100100 names them only in comments), so the SQL is independent too.
-- It also sorts below unapplied migrations on unmerged branches: #664's
-- 20260911120000 (bind_adjust_inventory_receipt_to_intent) and the field-app
-- season files 20260908190000, 20260912165758, 20260913040359, 20260913152700.
-- Once this merges, the pending guard refuses all of them until this applies, so
-- APPLY THIS FIRST. Re-derive the stamp immediately before apply: if anything
-- applies live above 20260908140000 first, this file must be restamped.
--
-- PREFLIGHT PIN. Refuses to run unless every installed body is byte-for-byte the
-- reviewed live body or this file's own candidate body (so a replay is a no-op).
-- The candidate pins were computed ON LIVE as md5(replace(prosrc, old, new)).
--   function                         live                              candidate
--   next_application_record_number   4d26d0ee0176d8e6b630314c34b1cc4e  9bf10abef4830cd6b0ee3aea41c07469
--   next_commission_payment_number   6d4208fe79a2b021fd9752e862266f45  3f876d7588865bccd77b9b4a384ab8d7
--   next_cycle_count_number          2bce8cb943a36951bc605ed55f2636df  d6626bf1550a996716f4188c407975d4
--   next_job_number                  183721b3349f15162c068f58e2877b5d  b97a23c4ba96e772278e063111d3ebf6
--   next_po_number                   448fc5d0dbfbba0a8ae11b96e4ee9fcb  0fd0c7861511a67d5dbe12069914d7f9
--   next_return_number               8e8acd85a14248cfeccfd7cc5a047c29  0c5ab61fc8293ac2be8670289528d9c2
-- The pins are md5 of pg_proc.prosrc (LF-only; this file is pinned eol=lf).
--
-- PROOF: scripts/smoke/prove-number-generators-year-chicago.mjs (throwaway
-- PostgreSQL 17 container). APPLY only through scripts/apply-migration-file.mjs,
-- which wraps the file in one transaction; a bare psql -f would commit each
-- re-emit before the postflight could refuse it.
-- ============================================================================

-- NO top-level BEGIN/COMMIT: scripts/apply-migration-file.mjs wraps this file and
-- its ledger row in one transaction, and assertWrappable() refuses a file with its
-- own transaction control. A failed preflight or postflight rolls everything back.

-- ── PREFLIGHT ───────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_fn        record;
  v_count     integer;
  v_nargs     integer;
  v_md5       text;
  v_len       integer;
  v_secdef    boolean;
  v_config    text;
  v_owner     text;
  v_attrs     text;
BEGIN
  FOR v_fn IN
    SELECT *
      FROM (VALUES
        ('next_application_record_number', '4d26d0ee0176d8e6b630314c34b1cc4e', '9bf10abef4830cd6b0ee3aea41c07469'),
        ('next_commission_payment_number', '6d4208fe79a2b021fd9752e862266f45', '3f876d7588865bccd77b9b4a384ab8d7'),
        ('next_cycle_count_number',        '2bce8cb943a36951bc605ed55f2636df', 'd6626bf1550a996716f4188c407975d4'),
        ('next_job_number',                '183721b3349f15162c068f58e2877b5d', 'b97a23c4ba96e772278e063111d3ebf6'),
        ('next_po_number',                 '448fc5d0dbfbba0a8ae11b96e4ee9fcb', '0fd0c7861511a67d5dbe12069914d7f9'),
        ('next_return_number',             '8e8acd85a14248cfeccfd7cc5a047c29', '0c5ab61fc8293ac2be8670289528d9c2')
      ) AS pins(fn_name, live_md5, candidate_md5)
  LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn.fn_name;

    IF v_count <> 1 THEN
      RAISE EXCEPTION '%: expected exactly 1 overload, found % — refusing to re-emit into an ambiguous name',
        v_fn.fn_name, v_count;
    END IF;

    SELECT p.pronargs, md5(p.prosrc), length(p.prosrc),
           p.prosecdef, p.proconfig::text, p.proowner::regrole::text,
           concat_ws('/', l.lanname, p.provolatile, p.proisstrict, p.proparallel,
                     p.proleakproof, p.procost, p.prorettype::regtype, p.proretset,
                     p.prosupport::regproc)
      INTO v_nargs, v_md5, v_len, v_secdef, v_config, v_owner, v_attrs
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public' AND p.proname = v_fn.fn_name;

    -- md5(prosrc) is blind to the declaration, so pin the signature separately.
    IF v_nargs <> 0 THEN
      RAISE EXCEPTION '%: live signature has % arguments, expected 0. Re-review before applying.',
        v_fn.fn_name, v_nargs;
    END IF;

    IF v_md5 NOT IN (v_fn.live_md5, v_fn.candidate_md5) THEN
      RAISE EXCEPTION '%: installed body has DRIFTED (md5 %, length %). Expected the reviewed live body % or this file''s candidate %. Re-review against the current body before applying.',
        v_fn.fn_name, v_md5, v_len, v_fn.live_md5, v_fn.candidate_md5;
    END IF;

    -- These live OUTSIDE prosrc. The re-emit re-declares SECURITY DEFINER and
    -- search_path, so an out-of-band change would be silently "repaired" — fail
    -- loudly instead.
    IF NOT v_secdef THEN
      RAISE EXCEPTION '%: the LIVE function is not SECURITY DEFINER. Live has been changed out of band — re-review before applying.',
        v_fn.fn_name;
    END IF;

    IF v_config IS DISTINCT FROM '{"search_path=public, pg_temp"}' THEN
      RAISE EXCEPTION '%: the LIVE search_path is %, expected {"search_path=public, pg_temp"}. Re-review before applying.',
        v_fn.fn_name, COALESCE(v_config, '(none)');
    END IF;

    IF v_owner <> 'postgres' THEN
      RAISE EXCEPTION '%: owner is %, expected postgres. A SECURITY DEFINER body runs as its owner — re-review before applying.',
        v_fn.fn_name, v_owner;
    END IF;

    -- The re-emit declares language and return type but no volatility,
    -- strictness, parallel safety, leakproof, cost or SUPPORT function, so those
    -- reset to their defaults. Live holds exactly those defaults (read read-only
    -- 2026-09-19: plpgsql, VOLATILE, not strict, parallel unsafe, not leakproof,
    -- cost 100, returns text, not a set, no support function). Refuse if live was changed, rather than silently
    -- resetting it.
    IF v_attrs IS DISTINCT FROM 'plpgsql/v/f/u/f/100/text/f/-' THEN
      RAISE EXCEPTION '%: the LIVE function attributes are % (lang/volatile/strict/parallel/leakproof/cost/returns/setof/support), expected plpgsql/v/f/u/f/100/text/f/-. Re-review before applying.',
        v_fn.fn_name, v_attrs;
    END IF;
  END LOOP;
END;
$preflight$;

-- ── RE-EMIT ─────────────────────────────────────────────────────────────────
-- Each body is byte-identical to live except its single v_year line.

CREATE OR REPLACE FUNCTION public.next_application_record_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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

  v_year := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
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
$fn$;

CREATE OR REPLACE FUNCTION public.next_commission_payment_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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
  v_year := to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY');
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
$fn$;

CREATE OR REPLACE FUNCTION public.next_cycle_count_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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

  v_year := EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;

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
$fn$;

CREATE OR REPLACE FUNCTION public.next_job_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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

  v_year := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
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
$fn$;

CREATE OR REPLACE FUNCTION public.next_po_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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

  v_year := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;
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
$fn$;

CREATE OR REPLACE FUNCTION public.next_return_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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

  v_year := extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text;

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
$fn$;

-- ── POSTFLIGHT ──────────────────────────────────────────────────────────────
DO $postflight$
DECLARE
  v_fn          record;
  v_count       integer;
  v_nargs       integer;
  v_md5         text;
  v_len         integer;
  v_cr          integer;
  v_secdef      boolean;
  v_config      text;
  v_owner       text;
  v_acl         text;
  v_oid         oid;
  v_unexpected  text;
  v_attrs       text;
  v_year_utc     text;
  v_year_chicago text;
BEGIN
  FOR v_fn IN
    SELECT *
      FROM (VALUES
        -- browser_callable: authenticated holds EXECUTE on live and must keep it.
        -- expected_acl: the exact live proacl, read read-only 2026-09-19.
        ('next_application_record_number', '9bf10abef4830cd6b0ee3aea41c07469', false,
         '{postgres=X/postgres,service_role=X/postgres}'),
        ('next_commission_payment_number', '3f876d7588865bccd77b9b4a384ab8d7', false,
         '{postgres=X/postgres,service_role=X/postgres}'),
        ('next_cycle_count_number',        'd6626bf1550a996716f4188c407975d4', true,
         '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('next_job_number',                'b97a23c4ba96e772278e063111d3ebf6', true,
         '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('next_po_number',                 '0fd0c7861511a67d5dbe12069914d7f9', false,
         '{postgres=X/postgres,service_role=X/postgres}'),
        ('next_return_number',             '0c5ab61fc8293ac2be8670289528d9c2', false,
         '{postgres=X/postgres,service_role=X/postgres}')
      ) AS pins(fn_name, candidate_md5, browser_callable, expected_acl)
  LOOP
    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn.fn_name;

    IF v_count <> 1 THEN
      RAISE EXCEPTION '%: re-emit produced % overloads, expected 1', v_fn.fn_name, v_count;
    END IF;

    SELECT p.oid, p.pronargs, md5(p.prosrc), length(p.prosrc), position(chr(13) in p.prosrc),
           p.prosecdef, p.proconfig::text, p.proowner::regrole::text, p.proacl::text,
           concat_ws('/', l.lanname, p.provolatile, p.proisstrict, p.proparallel,
                     p.proleakproof, p.procost, p.prorettype::regtype, p.proretset,
                     p.prosupport::regproc)
      INTO v_oid, v_nargs, v_md5, v_len, v_cr, v_secdef, v_config, v_owner, v_acl, v_attrs
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public' AND p.proname = v_fn.fn_name;

    IF v_md5 <> v_fn.candidate_md5 THEN
      RAISE EXCEPTION '%: installed body md5 is % (length %), expected the candidate %',
        v_fn.fn_name, v_md5, v_len, v_fn.candidate_md5;
    END IF;

    IF v_cr <> 0 THEN
      RAISE EXCEPTION '%: installed body contains CR bytes at position %; expected LF-only', v_fn.fn_name, v_cr;
    END IF;

    IF v_nargs <> 0 THEN
      RAISE EXCEPTION '%: the re-emit changed the signature (% arguments, expected 0)', v_fn.fn_name, v_nargs;
    END IF;

    IF NOT v_secdef THEN
      RAISE EXCEPTION '%: SECURITY DEFINER was lost by the re-emit', v_fn.fn_name;
    END IF;

    IF v_config IS DISTINCT FROM '{"search_path=public, pg_temp"}' THEN
      RAISE EXCEPTION '%: search_path is now %, expected {"search_path=public, pg_temp"}', v_fn.fn_name, v_config;
    END IF;

    IF v_owner <> 'postgres' THEN
      RAISE EXCEPTION '%: owner is now %, expected postgres. A SECURITY DEFINER body runs as its owner.', v_fn.fn_name, v_owner;
    END IF;

    IF v_attrs IS DISTINCT FROM 'plpgsql/v/f/u/f/100/text/f/-' THEN
      RAISE EXCEPTION '%: the re-emit has attributes % (lang/volatile/strict/parallel/leakproof/cost/returns/setof/support), expected plpgsql/v/f/u/f/100/text/f/-',
        v_fn.fn_name, v_attrs;
    END IF;

    -- A NULL proacl means DEFAULT privileges — EXECUTE TO PUBLIC — the most open
    -- state, not "no grants".
    IF v_acl IS NULL THEN
      RAISE EXCEPTION '%: proacl is NULL, which means DEFAULT privileges — EXECUTE is held by PUBLIC. Revoke it from PUBLIC and grant deliberately before applying.',
        v_fn.fn_name;
    END IF;

    -- has_function_privilege resolves role membership, so it also catches EXECUTE
    -- reaching anon indirectly. A missing anon role cannot hold anything, so it
    -- is skipped — via a nested IF, because AND does not fix evaluation order and
    -- has_function_privilege raises on a missing role.
    IF to_regrole('anon') IS NOT NULL THEN
      IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION '%: anon holds EXECUTE (acl %). anon must never run a SECURITY DEFINER number generator.',
          v_fn.fn_name, v_acl;
      END IF;
    END IF;

    IF NOT v_fn.browser_callable AND to_regrole('authenticated') IS NOT NULL THEN
      IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION '%: authenticated holds EXECUTE (acl %). Only postgres/service_role may hold it.',
          v_fn.fn_name, v_acl;
      END IF;
    END IF;

    -- Enumerate the ACL so a grant to ANY other role is caught, not just the
    -- three named above.
    SELECT string_agg(DISTINCT g.grantee_name, ', ' ORDER BY g.grantee_name)
      INTO v_unexpected
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      CROSS JOIN LATERAL (
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      ) AS g(grantee_name)
     WHERE p.oid = v_oid
       AND a.privilege_type = 'EXECUTE'
       AND g.grantee_name NOT IN ('postgres', 'service_role')
       AND NOT (v_fn.browser_callable AND g.grantee_name = 'authenticated');

    IF v_unexpected IS NOT NULL THEN
      RAISE EXCEPTION '%: EXECUTE is held by % (acl %), which the reviewed ACL does not include.',
        v_fn.fn_name, v_unexpected, v_acl;
    END IF;

    -- The POSITIVE direction: the legitimate callers still hold EXECUTE. These
    -- roles MUST exist; a missing role is refused, never skipped.
    -- Nested IFs, not OR: PostgreSQL does not promise to evaluate the role-exists
    -- test first, and has_function_privilege raises on a missing role.
    IF to_regrole('service_role') IS NULL THEN
      RAISE EXCEPTION '%: service_role LOST EXECUTE or does not exist (the role is missing).', v_fn.fn_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '%: service_role LOST EXECUTE or does not exist (acl %).', v_fn.fn_name, v_acl;
    END IF;

    IF v_fn.browser_callable THEN
      IF to_regrole('authenticated') IS NULL THEN
        RAISE EXCEPTION '%: authenticated LOST EXECUTE or does not exist (the role is missing) — the app calls this directly and would break.',
          v_fn.fn_name;
      END IF;
      IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION '%: authenticated LOST EXECUTE or does not exist (acl %) — the app calls this directly and would break.',
          v_fn.fn_name, v_acl;
      END IF;
    END IF;

    -- EXACT ACL. The checks above reason about roles; this pins the whole
    -- contract, including grantors, the owner's direct item and WITH GRANT
    -- OPTION (an asterisk in the ACL text), none of which they can see.
    IF v_acl IS DISTINCT FROM v_fn.expected_acl THEN
      RAISE EXCEPTION '%: ACL is %, expected exactly % (grantor, grant option or grantee differs).',
        v_fn.fn_name, v_acl, v_fn.expected_acl;
    END IF;
  END LOOP;

  -- Timezone-data assertion (it does not call the six; the candidate md5 pins
  -- above are what bind the installed behaviour): 2027-01-01 02:00 UTC must
  -- resolve to 2026-12-31 20:00 Chicago on this server. Both sides name their
  -- zone, so this does not depend on the session TimeZone.
  SELECT extract(year FROM (timestamptz '2027-01-01 02:00:00+00' AT TIME ZONE 'UTC'))::text,
         extract(year FROM (timestamptz '2027-01-01 02:00:00+00' AT TIME ZONE 'America/Chicago')::date)::text
    INTO v_year_utc, v_year_chicago;

  IF v_year_utc <> '2027' OR v_year_chicago <> '2026' THEN
    RAISE EXCEPTION 'number generators: timezone assertion failed — utc gave %, chicago gave % (expected 2027 / 2026)',
      v_year_utc, v_year_chicago;
  END IF;
END;
$postflight$;

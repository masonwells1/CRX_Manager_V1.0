-- Remove logged-out (anon) EXECUTE on the three role-check helpers that RLS
-- policies call: is_admin(), is_applicator(), is_driver().
--
-- This is PART 2 OF 2 and it is the RISKY half. Part 1 (20260728193000) covers
-- 40 functions that appear in no table rule at all. These three are different:
-- they are evaluated INSIDE row-level-security policies, as the role doing the
-- query. Read the whole header before applying.
--
-- WHAT CHANGES, IN PLAIN ENGLISH
-- A policy calling is_admin() is normally a silent filter: a visitor without
-- admin rights just sees no rows. Once anon loses EXECUTE, that same query stops
-- being silent and raises a hard error instead:
--     42501 permission denied for function is_admin
-- Anything that reads one of those tables while logged out changes from
-- "empty list" to "request failed".
--
-- BLAST RADIUS, MEASURED AGAINST LIVE (read-only, 2026-07-28)
--   is_admin()      -- 30 tables carry a policy with audience PUBLIC (which
--                      includes anon) whose expression calls it
--   is_applicator() -- 6 tables
--   is_driver()     -- 1 table
--   70 PUBLIC-audience policies in total across those tables.
-- A policy written `TO authenticated` is never evaluated by anon and is not
-- affected; only the PUBLIC-audience ones above are in scope.
--
-- WHY THIS IS STILL JUDGED SAFE -- FOUR INDEPENDENT LINES OF EVIDENCE
-- 1. THE PRECEDENT IS ALREADY LIVE AND HEALTHY. is_sales_rep() is the same
--    shape of helper, is called by policies on 24 tables, and anon ALREADY has
--    no EXECUTE on it. Probed live as anon: `SELECT ... FROM customers` returns
--    exactly `42501 permission denied for function is_sales_rep`, today, in
--    production -- and production is fine. This exact failure mode is already
--    the status quo on a large set of tables and has broken nothing.
-- 2. THE LOGIN PAGE DOES NOT READ THESE TABLES AS anon. src/App.tsx:185 shows
--    `login` is the only route outside <ProtectedRoute>. AuthContext's
--    fetchProfile() queries `profiles` only from inside
--    supabase.auth.getSession().then(...) when a user exists, and from
--    onAuthStateChange -- so it always runs as `authenticated`, never anon.
-- 3. NO EDGE FUNCTION READS AS anon. All seven functions under
--    supabase/functions/ build their client with the caller's Authorization
--    header and return 401 "Invalid token" when there is no caller; privileged
--    work uses a separate service-role client, which is exempt from RLS.
-- 4. THE authenticated GRANT IS UNTOUCHED, and the proof block below asserts
--    that positively. The signed-in app is not affected by this change at all.
--
-- CALLER ANALYSIS
-- Caller graph regenerated 2026-07-28 (node scripts/generate-caller-graph.mjs).
-- caller-analysis: is_admin :: zero frontend, cron, and edge-function callsites. Called only from inside SQL -- RLS policy expressions on 30 tables and other SECURITY DEFINER bodies -- where it runs as the querying role. The signed-in app keeps its authenticated grant (asserted below), so every in-app policy evaluation is unchanged; only the logged-out path changes, from silent-empty to a hard 42501.
-- caller-analysis: is_applicator :: zero frontend, cron, and edge-function callsites. Same shape as is_admin -- policy-internal only, on 6 tables. authenticated grant retained and asserted below.
-- caller-analysis: is_driver :: zero frontend, cron, and edge-function callsites. Same shape as is_admin -- policy-internal only, on 1 table. authenticated grant retained and asserted below.
--
-- HOW TO UNDO
-- This is a grant change, not a schema change, so reverting is one statement
-- each: GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;  (and the same for
-- is_applicator / is_driver). No data is touched and nothing is dropped.

REVOKE EXECUTE ON FUNCTION public.is_admin()      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_applicator() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_driver()     FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- PROOF
-- Assertion 1: anon can no longer execute the three helpers.
-- Assertion 2: authenticated CAN still execute all three. This is the assertion
-- that matters -- if it ever fails, every signed-in user loses access to 30
-- tables at once, so it is checked explicitly rather than assumed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_targets text[] := ARRAY[
    'public.is_admin()',
    'public.is_applicator()',
    'public.is_driver()'
  ];
  v_sig text;
  v_oid oid;
  v_anon_leftover text := '';
  v_authed_lost   text := '';
BEGIN
  FOREACH v_sig IN ARRAY v_targets LOOP
    v_oid := v_sig::regprocedure::oid;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      v_anon_leftover := v_anon_leftover || v_sig || ', ';
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_authed_lost := v_authed_lost || v_sig || ', ';
    END IF;
  END LOOP;

  IF v_anon_leftover <> '' THEN
    RAISE EXCEPTION 'ANON_EXECUTE_REMAINS: %', v_anon_leftover;
  END IF;
  IF v_authed_lost <> '' THEN
    RAISE EXCEPTION 'AUTHENTICATED_EXECUTE_LOST (every signed-in user would lose 30 tables): %', v_authed_lost;
  END IF;
END;
$$;

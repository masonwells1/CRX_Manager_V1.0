-- ============================================================================
-- SMOKE TEST (rolled back by design): the forged-quote-version money path
-- ----------------------------------------------------------------------------
-- CRX-SEC-1. This is the behavioural half of the regression proof the
-- adversarial review of PR #389 asked for: "prove forged version JSON cannot
-- affect order cost or commission profit".
--
-- WHY A PRIVILEGE DENIAL IS THE PROOF. The money chain is:
--
--   forged quote_versions row, attacker-chosen current_cost at
--   snapshot_data.sections[].items[].current_cost
--     -> restore_quote_version arms crx.quote_cost_snapshot_passthrough and
--        stamps quote_items.cost_at_quote_cents from that JSON  (20260812115236)
--     -> convert_quote_to_order copies it into order_items.cost_per_unit and
--        the immutable cost_at_time_cents
--     -> canonical profit, margin reporting and commissions derive from there
--
-- Every later link is server-side and only reachable through RPCs that build
-- the snapshot themselves. The one attacker-controlled entry point is the FIRST
-- link — a direct table INSERT. Close that and the chain cannot start, which is
-- why this file proves the denial rather than replaying the whole chain: there
-- is no way to construct the downstream state to test.
--
-- WHAT IT CHECKS
--   authenticated direct quote_versions INSERT (forged cost) -> 42501
--   authenticated direct quote_versions UPDATE               -> 42501
--   authenticated direct quote_versions DELETE               -> 42501
--   authenticated direct quote_versions TRUNCATE             -> 42501
--     (TRUNCATE is checked separately on purpose: RLS policies do not apply to
--      TRUNCATE at all, so only the revoked grant stops it)
--   create_quote_version RPC as authenticated                -> STILL SUCCEEDS
--   authenticated SELECT on quote_versions                   -> STILL SUCCEEDS
--
-- The last two matter as much as the first four. A write boundary that also
-- broke version creation or version history would satisfy every negative check
-- and still be a regression.
--
-- RUN THIS ONLY AFTER 20260813080000 HAS APPLIED. Steps 1-4 are written as
-- real INSERT/UPDATE/DELETE/TRUNCATE statements, because a privilege denial is
-- only worth anything if the real statement is what gets refused. In the
-- POST-fix state they are refused before touching a row. In the PRE-fix state
-- `authenticated` still holds those grants, so the same statements would
-- rewrite and delete live version rows and TRUNCATE would take an ACCESS
-- EXCLUSIVE lock on this money-authoritative table, blocking every reader for
-- the length of the block. The whole file is ONE statement so nothing could
-- commit — but the lock and the churn are real. The prereq gate below therefore
-- refuses to run at all until the grants are actually gone.
--
-- That gate doubles as the grant-level assertion: SQLSTATE 42501 is raised by
-- an RLS WITH CHECK violation too, so the behavioural denials alone cannot tell
-- "the privilege is revoked" from "a policy happened to reject this row". The
-- claim this file makes is about the PRIVILEGE, so the privilege is checked
-- directly as well as behaviourally.
--
-- HOW TO RUN: execute this whole file as a SINGLE statement (Supabase MCP
-- execute_sql, or psql -1 / run-smoke.mjs) as postgres/service_role. The DO
-- block ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK', so nothing it
-- writes persists. ANY other error text = a real failure.
--
-- Auth: SECURITY DEFINER RPCs derive the actor from auth.uid(), which reads
-- request.jwt.claims — injected via set_config(..., is_local => true) using a
-- REAL active admin profile id. The admin branch is used deliberately: the
-- policy this migration drops was `is_admin() OR (is_sales_rep() AND owns the
-- quote)`, so an admin JWT is the case that WOULD have been allowed before the
-- fix. If the INSERT is refused for an admin it is refused for everyone.
--
-- Live-state preconditions (checked up front, raise SMOKE_PREREQ/SMOKE_SETUP if
-- unmet):
--   * 20260813080000 already applied — no direct write grant, at table OR
--     column level, for anon/authenticated;
--   * at least one active admin profile;
--   * at least one quote that is not soft-deleted;
--   * at least one product carrying a positive catalog cost.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin       uuid;
  v_quote_id    uuid;
  v_product_id  uuid;
  v_row_version bigint;
  v_forged      jsonb;
  v_before      bigint;
  v_after       bigint;
  v_result      jsonb;
  v_suffix      text := substr(md5(random()::text), 1, 8);
  v_priv        text;
  v_role        text;
  v_visible     bigint;
BEGIN
  -- ── 0. PREREQ: refuse to run until the boundary actually exists ───────────
  -- Steps 1-4 below are real write statements. Post-fix they are refused before
  -- touching a row; pre-fix they would succeed, and TRUNCATE would hold an
  -- ACCESS EXCLUSIVE lock on a money-authoritative table for the whole block.
  -- This gate is also the direct grant-level assertion: an RLS WITH CHECK
  -- violation raises 42501 too, so the behavioural denials alone cannot prove
  -- the PRIVILEGE is gone, which is the claim this file makes.
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'] LOOP
      IF has_table_privilege(v_role, 'public.quote_versions', v_priv) THEN
        RAISE EXCEPTION 'SMOKE_PREREQ: % still holds % on public.quote_versions — 20260813080000 has not applied. Refusing to run: steps 1-4 would perform real writes on live data and TRUNCATE would lock the table.', v_role, v_priv;
      END IF;
      -- REVOKE ... ON TABLE removes table-level ACLs only, and
      -- has_table_privilege reports only table-level. A column-level grant on
      -- snapshot_data would reopen the exact money path while every table-level
      -- check above still passed. (has_any_column_privilege supports only
      -- INSERT/SELECT/UPDATE/REFERENCES; the others are table-only privileges.)
      IF v_priv IN ('INSERT', 'UPDATE', 'REFERENCES')
         AND has_any_column_privilege(v_role, 'public.quote_versions', v_priv) THEN
        RAISE EXCEPTION 'SMOKE_PREREQ: % holds a COLUMN-level % on public.quote_versions. The table-level revoke does not remove that; the forged-snapshot path is still open.', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active
   ORDER BY id
   LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile to authenticate as';
  END IF;

  -- deleted_at IS NULL matters: create_quote_version looks the quote up with
  -- that same filter, so picking a soft-deleted quote would make step 5 report
  -- "the fix broke version creation" when nothing is broken at all.
  --
  -- The status filter matters for the same reason, and is the sharper trap.
  -- _create_quote_version_owner_impl ends with an UNCONDITIONAL
  --   UPDATE quotes SET status = 'sent' ...
  -- and sets no admin override, so _enforce_quote_status_transition judges it.
  -- That trigger admits NEW.status = 'sent' only from 'draft', 'revised' and
  -- 'accepted', plus the OLD.status = NEW.status early return that lets an
  -- already-'sent' quote through unchanged. Every other live status
  -- ('declined', 'expired', 'cancelled', 'closed_by_application',
  -- 'closed_short') raises "Invalid quote status transition", which step 5's
  -- handler would report as SMOKE_FAIL: the fix broke version creation. That is
  -- not hypothetical: on 2026-08-13 the oldest live quote was 'cancelled', so
  -- an unfiltered ORDER BY created_at picked exactly the one quote that
  -- false-fails. Keep this list in lockstep with the trigger's inbound edges to
  -- 'sent'; it is a property of the quote lifecycle, not of this boundary.
  SELECT id, row_version INTO v_quote_id, v_row_version
    FROM public.quotes
   WHERE deleted_at IS NULL
     AND status IN ('draft', 'revised', 'accepted', 'sent')
   ORDER BY created_at
   LIMIT 1;
  IF v_quote_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no live quote in draft/revised/accepted/sent to attach a version to. This is a fixture gap, NOT a failure of the write boundary: create_quote_version moves a quote to ''sent'', and no other status has a legal edge to it.';
  END IF;

  SELECT id INTO v_product_id
    FROM public.products
   WHERE current_cost IS NOT NULL AND current_cost > 0
   ORDER BY id
   LIMIT 1;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no product with a positive catalog cost to forge a cost basis against';
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  SELECT count(*) INTO v_before FROM public.quote_versions;

  -- The exact payload the attack needs, in the exact shape the restore path
  -- walks: sections[] -> items[] -> current_cost. A flat items[] payload would
  -- stamp nothing, so building one here would make this file advertise a proof
  -- it was not performing. The product_id is a real one so the line would
  -- genuinely resolve, and the cost basis is one cent, which passes the restore
  -- path's only validation (`current_cost <= 0` raises COST_BASIS_REQUIRED, so
  -- 0.01 is accepted) and would understate COGS on every line it restores.
  v_forged := jsonb_build_object(
    'sections', jsonb_build_array(
      jsonb_build_object(
        'items', jsonb_build_array(
          jsonb_build_object(
            'product_id', v_product_id,
            'current_cost', 0.01,
            'note', 'SMK-FORGED-' || v_suffix
          )
        )
      )
    )
  );

  -- ── 1. direct INSERT must be privilege-denied ─────────────────────────────
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    INSERT INTO public.quote_versions (
      quote_id, version_number, sent_by, sent_at, sent_method, snapshot_data, notes
    ) VALUES (
      v_quote_id, 999999, v_admin, now(), 'smoke', v_forged, 'SMK-FORGED-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct quote_versions INSERT was allowed — the forged-cost path is OPEN';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct quote_versions INSERT 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  -- ── 2. direct UPDATE must be privilege-denied ─────────────────────────────
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    UPDATE public.quote_versions
       SET snapshot_data = v_forged
     WHERE quote_id = v_quote_id;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct quote_versions UPDATE was allowed — an existing snapshot could be rewritten';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct quote_versions UPDATE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  -- ── 3. direct DELETE must be privilege-denied ─────────────────────────────
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    DELETE FROM public.quote_versions WHERE quote_id = v_quote_id;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated direct quote_versions DELETE was allowed — version history is not append-only';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected direct quote_versions DELETE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  -- ── 4. TRUNCATE must be privilege-denied ──────────────────────────────────
  -- Checked on its own because no RLS policy can stop TRUNCATE; before
  -- 20260813080000 the raw grant alone let an authenticated caller empty the
  -- whole table.
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    TRUNCATE public.quote_versions;
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated TRUNCATE of quote_versions was allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: expected quote_versions TRUNCATE 42501, got % (%)', SQLERRM, SQLSTATE;
  END;
  RESET ROLE;

  -- Nothing above may have changed the table.
  SELECT count(*) INTO v_after FROM public.quote_versions;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: quote_versions row count moved from % to % during the denial checks', v_before, v_after;
  END IF;

  -- ── 5. the LEGITIMATE path must still work ────────────────────────────────
  -- A boundary that also broke version creation would pass every check above.
  SET LOCAL ROLE authenticated;
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: SET LOCAL ROLE authenticated did not take effect (current_user=%)', current_user;
  END IF;
  BEGIN
    SELECT public.create_quote_version(
      v_quote_id, v_admin, 'smoke', 'SMK-QV-' || v_suffix, v_row_version
    ) INTO v_result;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'SMOKE_FAIL: create_quote_version RPC no longer works for an authenticated admin — the fix broke version creation: % (%)', SQLERRM, SQLSTATE;
  END;

  -- Version history must still render for the browser role.
  -- Counted, not merely executed: under RLS a policy that no longer matches
  -- returns ZERO ROWS rather than raising, so a bare PERFORM wrapped in an
  -- exception handler would pass just as happily against a table the browser
  -- can no longer read — the precise failure this check exists to catch. Step 5
  -- has already created a version for v_quote_id in this transaction, so a
  -- healthy read path cannot return zero here.
  BEGIN
    SELECT count(*) INTO v_visible
      FROM public.quote_versions
     WHERE quote_id = v_quote_id;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'SMOKE_FAIL: authenticated SELECT on quote_versions was refused — version history would stop rendering: % (%)', SQLERRM, SQLSTATE;
  END;
  IF v_visible IS NULL OR v_visible = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated sees zero versions for a quote that was just versioned — qversions_select no longer matches and version history would render empty';
  END IF;
  RESET ROLE;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_quote_version returned NULL instead of a result payload';
  END IF;

  -- Belt and braces, not an independent check: step 1 already failed the run if
  -- the forged INSERT had succeeded, so this can only ever find nothing. It is
  -- kept as a cheap direct assertion that the RPC-created row carries a
  -- server-built snapshot rather than anything the caller supplied.
  IF EXISTS (
    SELECT 1
      FROM public.quote_versions
     WHERE quote_id = v_quote_id
       AND snapshot_data::text LIKE '%SMK-FORGED-' || v_suffix || '%'
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the forged snapshot reached quote_versions despite the denials';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;

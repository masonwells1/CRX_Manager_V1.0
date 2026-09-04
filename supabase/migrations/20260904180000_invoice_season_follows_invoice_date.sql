-- ============================================================================
-- invoice season follows the invoice DATE, not an independent clock read
-- ----------------------------------------------------------------------------
-- STATUS: NOT APPLIED
-- (This status line goes stale at apply time; the ledger is authoritative.)
--
-- PLAIN ENGLISH. Every invoice carries two stamps that have to agree: the date on
-- it, and the SEASON it is filed under. Season decides which per-customer rate the
-- customer is charged (customer_application_rates) and which year-end statement the
-- invoice lands on. The season rolls over on October 1.
--
-- On 2026-09-04, migration 20260904160000_invoice_date_fallbacks_chicago moved the
-- server-side invoice_date fallback to the America/Chicago business date. That was
-- right, and it exposed a coupling underneath it: two of those bodies still took
-- their season from the current-season helper, which reads the UTC calendar day.
-- The two stamps were both wrong together before; now only one of them is right.
--
-- THE WINDOW THIS CLOSES. Between 7 pm America/Chicago on 2026-09-30 and midnight
-- UTC, the UTC calendar day is already 2026-10-01. An invoice saved in that window
-- is dated 2026-09-30 (season 2026) and stamped season 2027 -- priced against the
-- wrong season rate and filed on the wrong year-end statement. Same evening, every
-- year; 2026-09-30 is the next one.
--
-- SCOPE: this closes that window for the TWO invoice-creating bodies named below.
-- Other bodies still stamp invoices.season from the current-season helper
-- (issue_return_credit, the blend-ticket and delivery-split paths), and the
-- invoices.season column DEFAULT is itself that helper. Those are the same class and
-- are tracked in docs/manual/KNOWN_ISSUES.md; this file does not close them.
--
-- WHAT THIS CHANGES: each body below is re-emitted from its LIVE installed text
-- (read read-only on 2026-09-04, after the 20260904160000 apply) with season derived
-- from the SAME date the row is stamped with -- the pattern
-- _save_field_app_split_invoice_impl already uses:
--
--     compute_season(COALESCE(<payload invoice_date>, (now() AT TIME ZONE 'America/Chicago')::date))
--
--   1. _save_invoice_lineage_unaware_impl_20260827  (1 site)
--      the season fallback in the INSERT. A caller-supplied season still wins.
--   2. _save_field_app_invoice_impl_20260714  (2 sites)
--      a new v_season, computed once before the per-customer loop, is stamped on a NEW
--      invoice. The customer_application_rates lookup binds instead to v_invoice_season
--      -- the season the row ACTUALLY carries, returned by the INSERT or read back from
--      the UPDATE -- so "the fee is priced at the season this invoice is filed under"
--      holds on BOTH the create and the edit path.
--
-- WHY THE EDIT PATH DOES NOT REWRITE season: re-seasoning an existing invoice would
-- move it onto a different year-end statement, and on a governed split invoice the
-- provenance triggers (20260719044912 / 20260719060256) refuse a season change
-- outright. Binding the rate lookup to the stored season closes the same divergence
-- without rewriting any existing row. (Both reviewers raised this on 2026-09-04:
-- rls-security-reviewer M3 and migration-drift-reviewer H1.)
--
-- THREE ACCEPTED CONSEQUENCES OF THAT CHOICE, all confined to an EDIT that moves an
-- invoice date ACROSS October 1. None of them is in the 2026-09-30 evening window this
-- file exists to close; all are recorded in docs/manual/KNOWN_ISSUES.md and are OPEN
-- OWNER DECISIONS for Mason rather than defects fixed unilaterally here.
--   (a) The two stamps stay divergent on that edit: invoice_date moves, season does not.
--       So the opening claim -- date and season agree -- holds on CREATE, not on EDIT.
--       This is the price of never rewriting an existing record's season.
--   (b) In a MULTI-GROWER group, an edit that also ADDS a grower prices the pre-existing
--       invoices at their stored season and the new one at the invoice date's season, so
--       two growers on the SAME application can be billed at different seasons' rates.
--       Before this file all three priced from the clock, so the stamps could already
--       diverge but the prices could not (migration-drift-reviewer H1 round 2).
--   (c) If no customer_application_rates row exists for the stored season, the fee falls
--       back to the service default rate SILENTLY -- pre-existing behaviour on a newly
--       reachable path, e.g. an override entered for the new season after the roll
--       (rls-security-reviewer M-A round 2).
-- scripts/smoke/prove-invoice-season-follows-invoice-date.mjs PHASES 6c/6d/6e OBSERVE all
-- three, so they are recorded outcomes rather than inferences.
--
-- ONE MORE BEHAVIOUR DELTA, small and fail-closed: the payload invoice_date is now cast
-- to date ONCE before the per-customer loop, where it used to be cast only inside the
-- INSERT/UPDATE arms. A malformed invoice_date string therefore raises slightly earlier,
-- including on an edit where every customer is skipped (migration-drift-reviewer L4).
--
-- WHAT THIS DOES NOT CHANGE: no data is rewritten (no backfill; existing season and
-- invoice_date values stay exactly as stamped), no row is deleted, no grant moves
-- (CREATE OR REPLACE keeps each ACL; the postflight records each function's access
-- surface before the replacement and refuses any WIDENING of it), no signature,
-- return type, volatility or parallel-safety changes (all pinned pre and post), no
-- other statement in either body moves, and the client is untouched. The
-- invoice_date fallbacks from 20260904160000 are preserved and re-asserted here.
--
-- KNOWN, DELIBERATE BEHAVIOUR CHANGE: on the CREATE path, a caller that supplies an
-- invoice_date in a different season than today now files AND prices under that
-- date's season instead of the current one. That is the rule
-- _save_field_app_split_invoice_impl already follows after Codex round-3 P1
-- ("current_season alone mis-priced a backdated/prior-season job and filed the wrong
-- year"); this file makes the other two agree with it. It does mean a privileged
-- caller can choose the pricing season by choosing the invoice date on a NEW invoice.
--
-- OUT OF SCOPE, tracked separately (docs/manual/KNOWN_ISSUES.md):
--   * next_invoice_number() takes its year from extract(year FROM now()) -- UTC. Same
--     class, narrower window (2026-12-31 evening), later deadline, different function
--     and migration lineage.
--   * the single remaining UTC current-date token in _save_field_app_split_invoice_impl
--     (the commission order_date) is an OPEN OWNER DECISION for Mason and is untouched.
--
-- PREFLIGHT PINS. Refuses to run unless each installed body is byte-for-byte either
-- the reviewed starting body (the live md5 read 2026-09-04) or this file's own
-- candidate body (an identical replay). A drifted body aborts the whole transaction
-- untouched. Both bodies are LF on live, so there is no CRLF preimage this time.
--   _save_invoice_lineage_unaware_impl_20260827  live e1f1e0e641bd22f23505a7afc4384b2b -> candidate e3fc9bd9c1da4b2eb8082e91781e4915
--   _save_field_app_invoice_impl_20260714        live bf900b8bd31439b9fa2963b161e107ca -> candidate 29d699a8b0698424345a78e9aac9dcd1
--
-- PROOF: scripts/smoke/prove-invoice-season-follows-invoice-date.mjs (throwaway
-- PostgreSQL 17 container on the supported schema baseline): pins reproduce, drift
-- refused, apply, replay identical, postflight passes, and -- through the REAL
-- installed functions -- the season/date mismatch is reproduced before the candidate
-- and gone after it, on both sides of the 2026-09-30 / 2026-10-01 boundary, on the
-- CREATE and the EDIT path, and with the clock wiring itself instrumented.
-- ============================================================================

DO $preflight$
DECLARE
  v_row   record;
  v_count integer;
BEGIN
  -- Access surface of each function BEFORE the replacement, so the postflight can prove
  -- CREATE OR REPLACE did not widen it. ON COMMIT DROP makes the rows genuinely
  -- transaction-scoped: a TEMP table without it survives COMMIT for the whole session, so a
  -- statement-by-statement autocommit run would still see them and would falsely certify
  -- atomicity. With ON COMMIT DROP plus the recorded transaction id, a split run fails closed
  -- (rls-security-reviewer M2 / migration-drift-reviewer M5, 2026-09-04).
  CREATE TEMP TABLE IF NOT EXISTS crx_season_acl_pins (
    proname   text PRIMARY KEY,
    acl       text    NOT NULL,
    anon_exec boolean NOT NULL,
    auth_exec boolean NOT NULL,
    xid       text    NOT NULL
  ) ON COMMIT DROP;
  DELETE FROM pg_temp.crx_season_acl_pins;

  -- The rollover rule this whole fix depends on. If compute_season ever stops rolling
  -- the season at October 1, every claim in this file's header is wrong and the
  -- reviewer needs to know before the bodies move. IS DISTINCT FROM, not <>, so a NULL
  -- return fails closed instead of silently passing.
  IF compute_season(DATE '2026-09-30') IS DISTINCT FROM 2026
     OR compute_season(DATE '2026-10-01') IS DISTINCT FROM 2027 THEN
    RAISE EXCEPTION 'PREFLIGHT_SEASON_RULE: compute_season must return 2026 for 2026-09-30 and 2027 for 2026-10-01, got % and %.',
      compute_season(DATE '2026-09-30'), compute_season(DATE '2026-10-01');
  END IF;

  -- Overload count FIRST: with two overloads the non-STRICT SELECT ... INTO below would take
  -- an arbitrary row and every later message would name the wrong function.
  SELECT count(*) INTO v_count FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_invoice_lineage_unaware_impl_20260827';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_OVERLOAD: public._save_invoice_lineage_unaware_impl_20260827 must have exactly 1 overload before replacement, found %.', v_count;
  END IF;
  SELECT pr.oid, pr.pronargs, pr.prosecdef, pr.provolatile, pr.proparallel,
         pr.proisstrict, pr.proleakproof, pr.procost, pr.proretset,
         pr.prorettype::regtype::text AS rettype, md5(pr.prosrc) AS body_md5
    INTO v_row
    FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_invoice_lineage_unaware_impl_20260827';
  -- md5(prosrc) covers the BODY only. These header pins cover what it cannot: argument count,
  -- return type, security mode, volatility and parallel safety. CREATE OR REPLACE resets every
  -- attribute the command does not name, so unpinned header drift would be silently reverted
  -- (migration-drift-reviewer H2 + rls-security-reviewer L1, 2026-09-04).
  IF v_row.pronargs <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_SIGNATURE: public._save_invoice_lineage_unaware_impl_20260827 has % arguments, expected 3.', v_row.pronargs;
  END IF;
  IF v_row.rettype <> 'uuid' THEN
    RAISE EXCEPTION 'PREFLIGHT_SIGNATURE: public._save_invoice_lineage_unaware_impl_20260827 returns %, expected uuid.', v_row.rettype;
  END IF;
  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'PREFLIGHT_SECDEF: public._save_invoice_lineage_unaware_impl_20260827 is not SECURITY DEFINER; the reviewed header is. Reconcile before applying.';
  END IF;
  -- EVERY attribute CREATE OR REPLACE can reset, not just volatility: this file's header
  -- names none of them, so each would silently revert to its default. A live STRICT reverting
  -- to CALLED ON NULL INPUT would change what a NULL argument does
  -- (rls-security-reviewer L-1, 2026-09-04).
  IF v_row.provolatile <> 'v' OR v_row.proparallel <> 'u' OR v_row.proisstrict
     OR v_row.proleakproof OR v_row.procost <> 100 OR v_row.proretset THEN
    RAISE EXCEPTION 'PREFLIGHT_ATTRS: public._save_invoice_lineage_unaware_impl_20260827 is volatility %/parallel %/strict %/leakproof %/cost %/retset %, expected v/u/false/false/100/false; this file emits no such clause, so applying it would silently reset them.', v_row.provolatile, v_row.proparallel, v_row.proisstrict, v_row.proleakproof, v_row.procost, v_row.proretset;
  END IF;
  IF v_row.body_md5 <> 'e1f1e0e641bd22f23505a7afc4384b2b' AND v_row.body_md5 <> 'e3fc9bd9c1da4b2eb8082e91781e4915' THEN
    RAISE EXCEPTION 'PREFLIGHT_BODY_DRIFT: public._save_invoice_lineage_unaware_impl_20260827 live body md5 is %, expected e1f1e0e641bd22f23505a7afc4384b2b (the reviewed starting body as installed on production) or e3fc9bd9c1da4b2eb8082e91781e4915 (this file''s own candidate body, an identical replay).', v_row.body_md5;
  END IF;
  -- Record the CURRENT access surface so the postflight can prove CREATE OR REPLACE did not
  -- widen it. The claim is NOT WIDENED, not any absolute grant state: a clean-rebuild database
  -- legitimately starts from a different ACL than production, and this file must not refuse a
  -- disaster-recovery rebuild for that.
  INSERT INTO pg_temp.crx_season_acl_pins (proname, acl, anon_exec, auth_exec, xid)
  SELECT '_save_invoice_lineage_unaware_impl_20260827', coalesce(pr.proacl::text, ''), CASE WHEN to_regrole('anon') IS NULL THEN false ELSE has_function_privilege('anon', pr.oid, 'EXECUTE') END, CASE WHEN to_regrole('authenticated') IS NULL THEN false ELSE has_function_privilege('authenticated', pr.oid, 'EXECUTE') END, pg_current_xact_id()::text
    FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_invoice_lineage_unaware_impl_20260827';

  -- Overload count FIRST: with two overloads the non-STRICT SELECT ... INTO below would take
  -- an arbitrary row and every later message would name the wrong function.
  SELECT count(*) INTO v_count FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_field_app_invoice_impl_20260714';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_OVERLOAD: public._save_field_app_invoice_impl_20260714 must have exactly 1 overload before replacement, found %.', v_count;
  END IF;
  SELECT pr.oid, pr.pronargs, pr.prosecdef, pr.provolatile, pr.proparallel,
         pr.proisstrict, pr.proleakproof, pr.procost, pr.proretset,
         pr.prorettype::regtype::text AS rettype, md5(pr.prosrc) AS body_md5
    INTO v_row
    FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_field_app_invoice_impl_20260714';
  -- md5(prosrc) covers the BODY only. These header pins cover what it cannot: argument count,
  -- return type, security mode, volatility and parallel safety. CREATE OR REPLACE resets every
  -- attribute the command does not name, so unpinned header drift would be silently reverted
  -- (migration-drift-reviewer H2 + rls-security-reviewer L1, 2026-09-04).
  IF v_row.pronargs <> 7 THEN
    RAISE EXCEPTION 'PREFLIGHT_SIGNATURE: public._save_field_app_invoice_impl_20260714 has % arguments, expected 7.', v_row.pronargs;
  END IF;
  IF v_row.rettype <> 'jsonb' THEN
    RAISE EXCEPTION 'PREFLIGHT_SIGNATURE: public._save_field_app_invoice_impl_20260714 returns %, expected jsonb.', v_row.rettype;
  END IF;
  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'PREFLIGHT_SECDEF: public._save_field_app_invoice_impl_20260714 is not SECURITY DEFINER; the reviewed header is. Reconcile before applying.';
  END IF;
  -- EVERY attribute CREATE OR REPLACE can reset, not just volatility: this file's header
  -- names none of them, so each would silently revert to its default. A live STRICT reverting
  -- to CALLED ON NULL INPUT would change what a NULL argument does
  -- (rls-security-reviewer L-1, 2026-09-04).
  IF v_row.provolatile <> 'v' OR v_row.proparallel <> 'u' OR v_row.proisstrict
     OR v_row.proleakproof OR v_row.procost <> 100 OR v_row.proretset THEN
    RAISE EXCEPTION 'PREFLIGHT_ATTRS: public._save_field_app_invoice_impl_20260714 is volatility %/parallel %/strict %/leakproof %/cost %/retset %, expected v/u/false/false/100/false; this file emits no such clause, so applying it would silently reset them.', v_row.provolatile, v_row.proparallel, v_row.proisstrict, v_row.proleakproof, v_row.procost, v_row.proretset;
  END IF;
  IF v_row.body_md5 <> 'bf900b8bd31439b9fa2963b161e107ca' AND v_row.body_md5 <> '29d699a8b0698424345a78e9aac9dcd1' THEN
    RAISE EXCEPTION 'PREFLIGHT_BODY_DRIFT: public._save_field_app_invoice_impl_20260714 live body md5 is %, expected bf900b8bd31439b9fa2963b161e107ca (the reviewed starting body as installed on production) or 29d699a8b0698424345a78e9aac9dcd1 (this file''s own candidate body, an identical replay).', v_row.body_md5;
  END IF;
  -- Record the CURRENT access surface so the postflight can prove CREATE OR REPLACE did not
  -- widen it. The claim is NOT WIDENED, not any absolute grant state: a clean-rebuild database
  -- legitimately starts from a different ACL than production, and this file must not refuse a
  -- disaster-recovery rebuild for that.
  INSERT INTO pg_temp.crx_season_acl_pins (proname, acl, anon_exec, auth_exec, xid)
  SELECT '_save_field_app_invoice_impl_20260714', coalesce(pr.proacl::text, ''), CASE WHEN to_regrole('anon') IS NULL THEN false ELSE has_function_privilege('anon', pr.oid, 'EXECUTE') END, CASE WHEN to_regrole('authenticated') IS NULL THEN false ELSE has_function_privilege('authenticated', pr.oid, 'EXECUTE') END, pg_current_xact_id()::text
    FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_field_app_invoice_impl_20260714';
  RAISE NOTICE 'PREFLIGHT_OK: both bodies are at a pinned starting state; headers pinned; season rollover rule confirmed at October 1.';
END
$preflight$;

CREATE OR REPLACE FUNCTION public._save_invoice_lineage_unaware_impl_20260827(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    -- Manual miscellaneous charges are the one controlled orderless invoice
    -- type. Chemical sales still require a source order/blend ticket.
    IF v_order_id IS NULL
       AND v_blend_id IS NULL
       AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') <> 'misc_charge' THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    IF COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') = 'misc_charge'
       AND COALESCE(NULLIF(p_invoice->>'status', ''), 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'MISC_CHARGE_MUST_START_DRAFT: orderless miscellaneous charges must be reviewed before posting';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, payment_terms, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      -- Season follows the SAME date this row is stamped with (2026-09-04). It previously read
      -- the current-season helper, which is compute_season of the UTC current-date built-in --
      -- an INDEPENDENT clock read of the UTC calendar day. From 7 pm America/Chicago on 2026-09-30
      -- the helper returns 2027 while the line below stamps invoice_date 2026-09-30 (season 2026),
      -- and season drives customer_application_rates lookups and year-end statements.
      -- A caller-supplied season still wins; only the fallback changes. This is the INSERT path:
      -- the UPDATE path below still keeps whatever season the row already carries.
      COALESCE((p_invoice->>'season')::int,
               compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date))),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
      (p_invoice->>'due_date')::date,
      NULLIF(btrim(COALESCE(p_invoice->>'payment_terms', '')), ''),
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- An orderless miscellaneous charge must remain a miscellaneous charge.
    -- The edit payload does not carry source IDs, so enforce this against the
    -- stored invoice rather than trusting the client to keep the type locked.
    IF EXISTS (
      SELECT 1
       FROM invoices
       WHERE id = v_invoice_id
         AND invoice_type = 'misc_charge'
         AND order_id IS NULL
         AND blend_ticket_id IS NULL
         AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), invoice_type) <> 'misc_charge'
    ) THEN
      RAISE EXCEPTION 'ORDERLESS_INVOICE_TYPE_LOCKED: an orderless miscellaneous charge cannot be reclassified';
    END IF;

    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = CASE WHEN p_invoice ? 'due_date' THEN (p_invoice->>'due_date')::date ELSE due_date END,
      payment_terms = CASE WHEN p_invoice ? 'payment_terms' THEN NULLIF(btrim(p_invoice->>'payment_terms'), '') ELSE payment_terms END,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint);
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE WHEN x.rn = x.cnt AND x.cnt = x.cnt_all THEN
                     GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                     - COALESCE(SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                         OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                   ELSE compute_commission_amount(v_u8_profit, x.split_percentage)
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_field_app_invoice_impl_20260714(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_existing_group_id   uuid;
  v_existing_status     text;
  v_locked_count        int;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_total_applied_acres numeric := 0;
  v_this_applied        numeric;
  v_loc                 jsonb;
  v_chem                jsonb;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_fee_rate            bigint;
  v_loc_id              uuid;
  v_share_row           jsonb;
  v_share_pct           numeric;
  v_share_acres         numeric;
  v_field_id            uuid;
  v_field_applied_acres numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_orphan              record;
  v_req_salesman        uuid;
  v_salesman_id         uuid;
  v_skipped_customer_ids uuid[] := '{}';
  v_is_new_invoice      boolean;
  v_surcharge_acres     numeric;
  v_surcharge_cents     bigint;
  v_season              integer;
  v_invoice_season      integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save field application invoices';
  END IF;

  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user (salesman_id)';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'save_field_app_invoice';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT status, invoice_group_id INTO v_existing_status, v_existing_group_id
      FROM invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
    SELECT COUNT(*) INTO v_locked_count
      FROM invoices
     WHERE (id = p_invoice_id OR invoice_group_id = v_existing_group_id)
       AND v_existing_group_id IS NOT NULL
       AND deleted_at IS NULL
       AND status NOT IN ('draft', 'unposted');
    IF v_locked_count > 0 OR v_existing_status NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'Cannot edit field app invoice — % invoice(s) in this group are posted/voided. Use void/reissue.', GREATEST(v_locked_count, 1);
    END IF;

    IF v_existing_group_id IS NOT NULL THEN
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_group_id = v_existing_group_id
      );
      DELETE FROM field_app_locations WHERE invoice_group_id = v_existing_group_id;
      DELETE FROM invoice_items   WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
      DELETE FROM invoice_shares  WHERE invoice_id IN (SELECT id FROM invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL);
    ELSE
      DELETE FROM field_app_location_shares WHERE location_id IN (
        SELECT id FROM field_app_locations WHERE invoice_id = p_invoice_id
      );
      DELETE FROM field_app_locations WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_items  WHERE invoice_id = p_invoice_id;
      DELETE FROM invoice_shares WHERE invoice_id = p_invoice_id;
    END IF;
  END IF;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    v_this_applied := (v_loc->>'applied_acres')::numeric;
    IF v_this_applied IS NULL OR v_this_applied <= 0 THEN
      RAISE EXCEPTION 'ZERO_APPLIED_ACRES: applied acres must be greater than 0 for field % (enter applied acres, or remove the field)', v_loc->>'field_id';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_loc->>'field_id')::uuid);
    v_total_applied_acres := v_total_applied_acres + v_this_applied;
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_loc->>'field_id', v_this_applied);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'At least one field is required';
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from selected fields';
  END IF;

  IF v_existing_group_id IS NOT NULL THEN
    FOR v_orphan IN
      SELECT id, invoice_number, customer_id
        FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND deleted_at IS NULL
         AND customer_id NOT IN (
           SELECT (c->>'customer_id')::uuid FROM jsonb_array_elements(v_customers) c
         )
    LOOP
      UPDATE invoices SET
        status              = 'cancelled',
        invoice_group_id    = NULL,
        total_amount_cents  = 0,
        total_cost_cents    = 0,
        updated_at          = now()
      WHERE id = v_orphan.id;

      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'invoice_orphan_cancelled',
        'Field app invoice ' || v_orphan.invoice_number ||
          ' cancelled — customer removed from group during edit',
        p_performed_by, 'invoice', v_orphan.id, v_orphan.customer_id
      );
    END LOOP;
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := COALESCE(v_existing_group_id, gen_random_uuid());
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  -- Season stamped on a NEW invoice, derived from the same date that invoice is stamped with
  -- (2026-09-04). This previously read the current-season helper, which is compute_season of
  -- the UTC current-date built-in -- an INDEPENDENT clock read of the UTC calendar day. From
  -- 7 pm America/Chicago on 2026-09-30 that helper returns 2027 while invoice_date is stamped
  -- 2026-09-30 (season 2026), and season drives customer_application_rates lookups and
  -- year-end statements. Deriving it from the invoice date also files a backdated invoice under
  -- THAT season, which is the rule _save_field_app_split_invoice_impl already follows
  -- (Codex round-3 P1). p_invoice is loop-invariant, so this is computed once.
  v_season := compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date));

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;

    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM invoices
       WHERE invoice_group_id = v_existing_group_id AND customer_id = v_customer_id AND deleted_at IS NULL LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;

    IF v_invoice_id IS NULL AND v_existing_group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM invoices
       WHERE invoice_group_id = v_existing_group_id
         AND customer_id = v_customer_id
         AND deleted_at IS NOT NULL
    ) THEN
      v_skipped_customer_ids := array_append(v_skipped_customer_ids, v_customer_id);
      CONTINUE;
    END IF;

    v_is_new_invoice := (v_invoice_id IS NULL);

    IF v_invoice_id IS NULL THEN
      v_invoice_number := next_invoice_number();
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id,
        season
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
        v_salesman_id,
        p_invoice->>'header_notes',
        p_performed_by,
        0, 0,
        v_invoice_group_id,
        p_application_service_id,
        v_season
      ) RETURNING id, season INTO v_invoice_id, v_invoice_season;
    ELSE
      UPDATE invoices SET
        invoice_date            = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id             = CASE WHEN is_admin() THEN COALESCE(v_salesman_id, salesman_id) ELSE salesman_id END,
        header_notes            = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id  = p_application_service_id,
        invoice_group_id        = v_invoice_group_id,
        total_amount_cents      = 0,
        total_cost_cents        = 0,
        updated_at              = now()
      WHERE id = v_invoice_id
      -- Season is deliberately NOT rewritten on an edit: that would move an existing invoice to
      -- a different year-end statement, and the split-provenance triggers refuse it outright.
      -- Read back what the row carries so the rate lookup below prices at THAT season.
      RETURNING season INTO v_invoice_season;
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_field_id            := (v_share_row->>'field_id')::uuid;
      v_field_applied_acres := (v_share_row->>'field_applied_acres')::numeric;
      v_share_pct           := (v_share_row->>'split_pct')::numeric;
      v_share_acres         := (v_share_row->>'share_acres')::numeric;
      v_field_override      := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note  := v_share_row->>'pricing_note';

      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );

      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals)
    LOOP
      DECLARE
        v_chem_qty_a   numeric := 0;
        v_chem_qty_b   numeric := 0;
        v_rate         numeric;
        v_qa_unit_cost bigint;
        v_wh           text := NULLIF(v_chem->>'warehouse', '');
        v_vendor       text := NULLIF(v_chem->>'vendor', '');
        v_form         text;
        v_epa          text := NULLIF(v_chem->>'epa_registration', '');
        v_ta_unit      text := COALESCE(NULLIF(v_chem->>'rate_unit',''), NULLIF(v_chem->>'unit_size',''));
        v_conv         record;
        v_inv_unit     text;       -- PARKED-010: product's sold/pricing unit (inventory_unit)
        v_priced_qty   numeric;    -- PARKED-010: applied qty converted into the pricing unit
      BEGIN
        v_rate := COALESCE((v_chem->>'rate_per_acre')::numeric, 0);

        IF (v_chem->>'product_id') IS NOT NULL THEN
          SELECT p.product_form::text, COALESCE(v_epa, p.epa_registration), COALESCE(v_vendor, p.vendor), p.inventory_unit
            INTO v_form, v_epa, v_vendor, v_inv_unit
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
        END IF;

        FOR v_share_row IN
          SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
          WHERE (value ->> 'customer_id')::uuid = v_customer_id
        LOOP
          v_share_acres := (v_share_row->>'share_acres')::numeric;
          IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
            v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
          ELSE
            v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
          END IF;
        END LOOP;

        IF v_chem_qty_a > 0 THEN
          v_qa_unit_cost := COALESCE((v_chem->>'cost_cents')::bigint, 0);
          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_a, 4), v_ta_unit, v_form);
          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            (v_chem->>'description') || ' — included in grower share',
            ROUND(v_chem_qty_a, 4),
            v_chem->>'unit_size',
            0, 0, v_qa_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            false,
            'manual',
            v_wh, v_vendor, ROUND(v_chem_qty_a, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );
          v_invoice_cost := v_invoice_cost + safe_cents_qty(v_qa_unit_cost, v_chem_qty_a);
        END IF;

        IF v_chem_qty_b > 0 THEN
          v_unit_price   := NULL;
          v_quoted_price := NULL;
          v_price_source := NULL;

          IF v_chem ? 'manual_override' AND (v_chem->>'manual_override')::boolean = true
             AND (v_chem->>'unit_price_cents') IS NOT NULL THEN
            v_unit_price   := (v_chem->>'unit_price_cents')::bigint;
            v_price_source := 'manual';
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT qi.price_per_unit INTO v_qi_price
              FROM quote_items qi
              JOIN quote_sections qs ON qs.id = qi.section_id
             WHERE qi.product_id = (v_chem->>'product_id')::uuid
               AND qs.field_id   = ANY(v_field_ids)
             ORDER BY qi.id LIMIT 1;
            IF v_qi_price IS NOT NULL THEN
              v_unit_price   := ROUND(v_qi_price * 100)::bigint;
              v_quoted_price := v_unit_price;
              v_price_source := 'quoted';
            END IF;
          END IF;

          IF v_unit_price IS NULL AND (v_chem->>'product_id') IS NOT NULL THEN
            SELECT CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(p.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(p.tier2_price * 100), ROUND(p.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(p.tier3_price * 100), ROUND(p.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(p.tier1_price * 100), 0)
            END INTO v_unit_price
            FROM products p WHERE p.id = (v_chem->>'product_id')::uuid;
            v_price_source := 'tier';
          END IF;

          v_unit_price := COALESCE(v_unit_price, 0);
          v_unit_cost  := COALESCE((v_chem->>'cost_cents')::bigint, 0);

          -- PARKED-010 (field-app billing unit fix): the applied amount (v_chem_qty_b) is in the
          -- RATE unit (e.g. oz), but v_unit_price is per the product's SOLD unit (inventory_unit,
          -- e.g. $/gal). Convert the applied amount into the pricing unit BEFORE multiplying, so a
          -- 16 oz/ac product at $32.10/gal bills $/gal x gallons (not $/gal x ounces = ~128x high).
          -- Manual line (no product_id): no inventory_unit, so price in the rate unit as entered
          -- (identity). If the units genuinely do not convert (e.g. an oz rate on a product sold
          -- "per unit"), refuse rather than silently mis-bill.
          v_priced_qty := field_app_priced_quantity(v_chem_qty_b, v_ta_unit, COALESCE(v_inv_unit, v_ta_unit), v_form);
          IF v_priced_qty IS NULL THEN
            RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: cannot price "%" — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing this field application.',
              COALESCE(NULLIF(v_chem->>'description', ''), (v_chem->>'product_id')), v_ta_unit, COALESCE(v_inv_unit, v_ta_unit);
          END IF;
          -- Round once to the stored precision so quantity x unit_price == extended_cents
          -- (the invoice line stays internally consistent on any later re-compute).
          v_priced_qty := ROUND(v_priced_qty, 4);
          v_extended   := safe_cents_qty(v_unit_price, v_priced_qty);

          SELECT * INTO v_conv FROM convert_to_gl_lb(ROUND(v_chem_qty_b, 4), v_ta_unit, v_form);

          INSERT INTO invoice_items (
            invoice_id, product_id, description, quantity, unit_size,
            unit_price_cents, extended_cents, cost_cents,
            sort_order, rate_per_acre, rate_unit,
            quoted_price_cents, is_application_fee, price_source,
            warehouse, vendor, total_applied, total_applied_unit,
            total_applied_gl_lb, gl_lb_unit, epa_registration, product_form
          ) VALUES (
            v_invoice_id,
            (v_chem->>'product_id')::uuid,
            v_chem->>'description',
            ROUND(v_priced_qty, 4),
            COALESCE(v_inv_unit, v_chem->>'unit_size'),
            v_unit_price, v_extended, v_unit_cost,
            COALESCE((v_chem->>'sort_order')::int, 0),
            v_rate,
            v_chem->>'rate_unit',
            v_quoted_price, false, v_price_source,
            v_wh, v_vendor, ROUND(v_chem_qty_b, 4), v_ta_unit,
            v_conv.converted_value, v_conv.converted_unit, v_epa, v_form
          );

          v_invoice_total := v_invoice_total + v_extended;
          -- PARKED-010: cost (v_unit_cost is also per the SOLD unit) must use the converted
          -- quantity too, otherwise margin = revenue(gallons) - cost(ounces) is wildly wrong.
          v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_priced_qty);
        END IF;
      END;
    END LOOP;

    IF p_application_service_id IS NOT NULL THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = p_application_service_id
         -- Price the application fee at the season THIS INVOICE IS FILED UNDER, whether it was
         -- just inserted (v_season, from the invoice date) or already existed (its stored
         -- season). Reading the clock here instead let a row be filed in one season and priced
         -- in another (rls-security-reviewer M3 / migration-drift-reviewer H1, 2026-09-04).
         AND car.season                 = v_invoice_season
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
        INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    -- #32: FUEL SURCHARGE LINE (owner-configured; OFF + blank by default = NOTHING here).
    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_surcharge_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id
       AND (value->>'price_override_cents') IS NULL;

    v_surcharge_cents := compute_fuel_surcharge_cents(v_surcharge_acres, v_invoice_total);

    IF v_surcharge_cents > 0 THEN
      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id, 'Fuel Surcharge', 1,
        v_surcharge_cents, v_surcharge_cents, 0,
        9998, NULL, NULL, NULL,
        true, 'manual'
      );
      v_invoice_total := v_invoice_total + v_surcharge_cents;
    END IF;
    -- #32 END

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost,
      updated_at         = now()
    WHERE id = v_invoice_id;

    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
          'customer_id', v_customer_id,
          'total_cents', v_invoice_total
        ),
        v_invoice_total,
        'Field application invoice created'
      );
    END IF;

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0)
      INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'price_override_cents')::bigint
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END,
      CASE WHEN v_has_override
        THEN (SELECT (value->>'pricing_note')
              FROM jsonb_array_elements(v_shares -> 'rows') AS value
              WHERE (value->>'customer_id')::uuid = v_customer_id
                AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
        ELSE NULL
      END
    );
  END LOOP;

  FOR v_loc IN SELECT * FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO field_app_locations (
      invoice_id, invoice_group_id,
      field_id, map_number, total_acres, planted_acres,
      applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_invoice_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_invoice_group_id,
      (v_loc->>'field_id')::uuid,
      (v_loc->>'map_number')::int,
      (v_loc->>'total_acres')::numeric,
      (v_loc->>'planted_acres')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type',
      v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::int, 0)
    ) RETURNING id INTO v_loc_id;

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
        AND NOT ((value->>'customer_id')::uuid = ANY(v_skipped_customer_ids))
    LOOP
      INSERT INTO field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_loc_id,
        (v_share_row->>'customer_id')::uuid,
        (v_share_row->>'split_pct')::numeric,
        (v_share_row->>'share_acres')::numeric,
        0
      );
    END LOOP;
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Field app invoice ' ||
      CASE WHEN v_invoice_group_id IS NOT NULL
           THEN '(group of ' || v_customer_count || ') '
           ELSE '' END ||
      'saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_app_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
DECLARE
  v_row   record;
  v_count integer;
  v_acl   text;
  v_anon  boolean;
  v_auth  boolean;
  v_xid   text;
BEGIN
  -- Overload count FIRST, for the same reason as the preflight.
  SELECT count(*) INTO v_count FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_invoice_lineage_unaware_impl_20260827';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: public._save_invoice_lineage_unaware_impl_20260827 has % overloads after replacement.', v_count;
  END IF;
  SELECT pr.oid, pr.prosecdef, pr.proconfig, pr.proacl, pr.pronargs, pr.provolatile, pr.proparallel,
         pr.proisstrict, pr.proleakproof, pr.procost, pr.proretset,
         pr.prorettype::regtype::text AS rettype, md5(pr.prosrc) AS body_md5,
         position(E'\r' IN pr.prosrc) > 0 AS has_cr,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'current_season\s*\(\)', 'gi'))            AS cs,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'current_date', 'gi'))                      AS cd,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'now\(\)\s*::\s*date', 'gi'))              AS nd,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'compute_season\(COALESCE\(', 'g'))         AS csd,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'AT TIME ZONE ''America/Chicago''', 'g'))   AS chi
    INTO v_row
    FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_invoice_lineage_unaware_impl_20260827';
  IF v_row.body_md5 <> 'e3fc9bd9c1da4b2eb8082e91781e4915' THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: public._save_invoice_lineage_unaware_impl_20260827 installed body md5 % <> candidate e3fc9bd9c1da4b2eb8082e91781e4915.', v_row.body_md5;
  END IF;
  IF v_row.has_cr THEN
    RAISE EXCEPTION 'POSTFLIGHT_EOL: public._save_invoice_lineage_unaware_impl_20260827 installed body carries CR bytes; this file is LF.';
  END IF;
  -- NOTE ON WHAT THE FIVE TOKEN COUNTS BELOW ARE FOR. They sit downstream of the exact md5
  -- equality above, so on a clean apply they cannot fail independently -- md5 already fixes
  -- prosrc. They are load-bearing only for a MUTATED candidate that re-pins its own md5.
  -- Of the five, ONLY the season-clock count (cs) has mutation coverage:
  -- scripts/smoke/prove-invoice-season-follows-invoice-date.mjs PHASE 8a re-pins two mutants
  -- that reintroduce the clock helper and requires POSTFLIGHT_SEASON_CLOCK to fire. The other
  -- four (csd, cd, nd, chi) have NO mutant anywhere in the prover: they are unexercised intent
  -- guards stating what the next re-emit must preserve, not tests of this apply
  -- (migration-drift-reviewer M1 + M2 round 2, 2026-09-04).
  IF v_row.cs <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_SEASON_CLOCK: public._save_invoice_lineage_unaware_impl_20260827 still calls the current-season helper % time(s), expected 0 -- season must follow the invoice date, not an independent clock read.', v_row.cs;
  END IF;
  IF v_row.csd < 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_SEASON_SOURCE: public._save_invoice_lineage_unaware_impl_20260827 derives season from the invoice date % time(s), expected at least 1.', v_row.csd;
  END IF;
  -- Regression guard for the 2026-09-04 apply this file builds on. Counts two UTC spellings,
  -- case-insensitively; it does not claim to catch every possible UTC-date expression.
  IF v_row.cd <> 0 OR v_row.nd <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_UTC_DATE: public._save_invoice_lineage_unaware_impl_20260827 contains % current-date token(s) and % bare now()-to-date cast(s), expected 0 and 0.', v_row.cd, v_row.nd;
  END IF;
  -- TWO Chicago conversions are expected: the invoice_date fallback from 20260904160000 and
  -- the season derivation added here. At >= 1 the new season line alone satisfied this and a
  -- regressed invoice_date fallback would have passed (migration-drift-reviewer M2 round 1).
  -- The count is POSITION-BLIND: it proves there are two such expressions, NOT which lines
  -- they sit on, so two season-derived conversions would also satisfy it. The md5 pin is what
  -- actually fixes the positions (migration-drift-reviewer L1 round 2, 2026-09-04).
  IF v_row.chi < 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_CHICAGO: public._save_invoice_lineage_unaware_impl_20260827 carries % America/Chicago conversion(s), expected at least 2.', v_row.chi;
  END IF;
  IF NOT v_row.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (v_row.proconfig)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SECURITY: public._save_invoice_lineage_unaware_impl_20260827 must be SECURITY DEFINER with search_path=public, pg_temp (secdef %, config %).', v_row.prosecdef, v_row.proconfig;
  END IF;
  IF v_row.pronargs <> 3 OR v_row.rettype <> 'uuid' OR v_row.provolatile <> 'v' OR v_row.proparallel <> 'u'
     OR v_row.proisstrict OR v_row.proleakproof OR v_row.procost <> 100 OR v_row.proretset THEN
    RAISE EXCEPTION 'POSTFLIGHT_SIGNATURE: public._save_invoice_lineage_unaware_impl_20260827 is now %/%/%/%/strict %/leakproof %/cost %/retset %, expected 3/uuid/v/u/false/false/100/false.', v_row.pronargs, v_row.rettype, v_row.provolatile, v_row.proparallel, v_row.proisstrict, v_row.proleakproof, v_row.procost, v_row.proretset;
  END IF;
  -- CREATE OR REPLACE preserves the ACL; prove it did, against the surface recorded in the
  -- preflight of THIS transaction. Stating it as NOT WIDENED rather than as an absolute grant
  -- list is deliberate -- a clean-rebuild database starts from a different ACL, and a
  -- disaster-recovery rebuild must not be refused for that (the same lesson as the CRLF/LF
  -- preimage in 20260904160000). On production the surface is postgres only, plus service_role
  -- for the field-app impl, so neither web role reaches these impls except through a wrapper;
  -- that is established by the read-only read recorded in the changelog, not by this check.
  SELECT acl, anon_exec, auth_exec, xid INTO v_acl, v_anon, v_auth, v_xid
    FROM pg_temp.crx_season_acl_pins WHERE proname = '_save_invoice_lineage_unaware_impl_20260827';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT: no preflight access-surface record for public._save_invoice_lineage_unaware_impl_20260827; the preflight did not run in this transaction.';
  END IF;
  IF v_xid <> pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_ATOMICITY: the preflight ran in transaction %, this postflight is in % -- this file must be applied as ONE transaction.', v_xid, pg_current_xact_id()::text;
  END IF;
  IF coalesce(v_row.proacl::text, '') <> v_acl THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT: public._save_invoice_lineage_unaware_impl_20260827 ACL changed across the replacement: was %, now %.', v_acl, coalesce(v_row.proacl::text, '');
  END IF;
  IF (CASE WHEN to_regrole('anon') IS NULL THEN false ELSE has_function_privilege('anon', v_row.oid, 'EXECUTE') END AND NOT v_anon)
     OR (CASE WHEN to_regrole('authenticated') IS NULL THEN false ELSE has_function_privilege('authenticated', v_row.oid, 'EXECUTE') END AND NOT v_auth) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT: public._save_invoice_lineage_unaware_impl_20260827 became executable by anon/authenticated across the replacement; it must stay reachable only through its wrapper.';
  END IF;

  -- Overload count FIRST, for the same reason as the preflight.
  SELECT count(*) INTO v_count FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_field_app_invoice_impl_20260714';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_OVERLOAD: public._save_field_app_invoice_impl_20260714 has % overloads after replacement.', v_count;
  END IF;
  SELECT pr.oid, pr.prosecdef, pr.proconfig, pr.proacl, pr.pronargs, pr.provolatile, pr.proparallel,
         pr.proisstrict, pr.proleakproof, pr.procost, pr.proretset,
         pr.prorettype::regtype::text AS rettype, md5(pr.prosrc) AS body_md5,
         position(E'\r' IN pr.prosrc) > 0 AS has_cr,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'current_season\s*\(\)', 'gi'))            AS cs,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'current_date', 'gi'))                      AS cd,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'now\(\)\s*::\s*date', 'gi'))              AS nd,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'compute_season\(COALESCE\(', 'g'))         AS csd,
         (SELECT count(*) FROM regexp_matches(pr.prosrc, 'AT TIME ZONE ''America/Chicago''', 'g'))   AS chi
    INTO v_row
    FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
   WHERE ns.nspname = 'public' AND pr.proname = '_save_field_app_invoice_impl_20260714';
  IF v_row.body_md5 <> '29d699a8b0698424345a78e9aac9dcd1' THEN
    RAISE EXCEPTION 'POSTFLIGHT_BODY: public._save_field_app_invoice_impl_20260714 installed body md5 % <> candidate 29d699a8b0698424345a78e9aac9dcd1.', v_row.body_md5;
  END IF;
  IF v_row.has_cr THEN
    RAISE EXCEPTION 'POSTFLIGHT_EOL: public._save_field_app_invoice_impl_20260714 installed body carries CR bytes; this file is LF.';
  END IF;
  -- NOTE ON WHAT THE FIVE TOKEN COUNTS BELOW ARE FOR. They sit downstream of the exact md5
  -- equality above, so on a clean apply they cannot fail independently -- md5 already fixes
  -- prosrc. They are load-bearing only for a MUTATED candidate that re-pins its own md5.
  -- Of the five, ONLY the season-clock count (cs) has mutation coverage:
  -- scripts/smoke/prove-invoice-season-follows-invoice-date.mjs PHASE 8a re-pins two mutants
  -- that reintroduce the clock helper and requires POSTFLIGHT_SEASON_CLOCK to fire. The other
  -- four (csd, cd, nd, chi) have NO mutant anywhere in the prover: they are unexercised intent
  -- guards stating what the next re-emit must preserve, not tests of this apply
  -- (migration-drift-reviewer M1 + M2 round 2, 2026-09-04).
  IF v_row.cs <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_SEASON_CLOCK: public._save_field_app_invoice_impl_20260714 still calls the current-season helper % time(s), expected 0 -- season must follow the invoice date, not an independent clock read.', v_row.cs;
  END IF;
  IF v_row.csd < 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_SEASON_SOURCE: public._save_field_app_invoice_impl_20260714 derives season from the invoice date % time(s), expected at least 1.', v_row.csd;
  END IF;
  -- Regression guard for the 2026-09-04 apply this file builds on. Counts two UTC spellings,
  -- case-insensitively; it does not claim to catch every possible UTC-date expression.
  IF v_row.cd <> 0 OR v_row.nd <> 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_UTC_DATE: public._save_field_app_invoice_impl_20260714 contains % current-date token(s) and % bare now()-to-date cast(s), expected 0 and 0.', v_row.cd, v_row.nd;
  END IF;
  -- TWO Chicago conversions are expected: the invoice_date fallback from 20260904160000 and
  -- the season derivation added here. At >= 1 the new season line alone satisfied this and a
  -- regressed invoice_date fallback would have passed (migration-drift-reviewer M2 round 1).
  -- The count is POSITION-BLIND: it proves there are two such expressions, NOT which lines
  -- they sit on, so two season-derived conversions would also satisfy it. The md5 pin is what
  -- actually fixes the positions (migration-drift-reviewer L1 round 2, 2026-09-04).
  IF v_row.chi < 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_CHICAGO: public._save_field_app_invoice_impl_20260714 carries % America/Chicago conversion(s), expected at least 2.', v_row.chi;
  END IF;
  IF NOT v_row.prosecdef OR NOT ('search_path=public, pg_temp' = ANY (v_row.proconfig)) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SECURITY: public._save_field_app_invoice_impl_20260714 must be SECURITY DEFINER with search_path=public, pg_temp (secdef %, config %).', v_row.prosecdef, v_row.proconfig;
  END IF;
  IF v_row.pronargs <> 7 OR v_row.rettype <> 'jsonb' OR v_row.provolatile <> 'v' OR v_row.proparallel <> 'u'
     OR v_row.proisstrict OR v_row.proleakproof OR v_row.procost <> 100 OR v_row.proretset THEN
    RAISE EXCEPTION 'POSTFLIGHT_SIGNATURE: public._save_field_app_invoice_impl_20260714 is now %/%/%/%/strict %/leakproof %/cost %/retset %, expected 7/jsonb/v/u/false/false/100/false.', v_row.pronargs, v_row.rettype, v_row.provolatile, v_row.proparallel, v_row.proisstrict, v_row.proleakproof, v_row.procost, v_row.proretset;
  END IF;
  -- CREATE OR REPLACE preserves the ACL; prove it did, against the surface recorded in the
  -- preflight of THIS transaction. Stating it as NOT WIDENED rather than as an absolute grant
  -- list is deliberate -- a clean-rebuild database starts from a different ACL, and a
  -- disaster-recovery rebuild must not be refused for that (the same lesson as the CRLF/LF
  -- preimage in 20260904160000). On production the surface is postgres only, plus service_role
  -- for the field-app impl, so neither web role reaches these impls except through a wrapper;
  -- that is established by the read-only read recorded in the changelog, not by this check.
  SELECT acl, anon_exec, auth_exec, xid INTO v_acl, v_anon, v_auth, v_xid
    FROM pg_temp.crx_season_acl_pins WHERE proname = '_save_field_app_invoice_impl_20260714';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT: no preflight access-surface record for public._save_field_app_invoice_impl_20260714; the preflight did not run in this transaction.';
  END IF;
  IF v_xid <> pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_ATOMICITY: the preflight ran in transaction %, this postflight is in % -- this file must be applied as ONE transaction.', v_xid, pg_current_xact_id()::text;
  END IF;
  IF coalesce(v_row.proacl::text, '') <> v_acl THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT: public._save_field_app_invoice_impl_20260714 ACL changed across the replacement: was %, now %.', v_acl, coalesce(v_row.proacl::text, '');
  END IF;
  IF (CASE WHEN to_regrole('anon') IS NULL THEN false ELSE has_function_privilege('anon', v_row.oid, 'EXECUTE') END AND NOT v_anon)
     OR (CASE WHEN to_regrole('authenticated') IS NULL THEN false ELSE has_function_privilege('authenticated', v_row.oid, 'EXECUTE') END AND NOT v_auth) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GRANT: public._save_field_app_invoice_impl_20260714 became executable by anon/authenticated across the replacement; it must stay reachable only through its wrapper.';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: both invoice season stamps now follow the invoice date, the field-app fee is priced at the season its invoice carries, and the America/Chicago invoice_date fallbacks are intact.';
END
$postflight$;

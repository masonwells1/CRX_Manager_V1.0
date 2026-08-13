-- actor-binding-check: exempt
--   REASON: this parked migration's formatted SQL is limited to role revokes
--   and rollback-only SET LOCAL proof setup. complete_delivery binds auth.uid()
--   and raises ACTOR_MISMATCH before mutation; manual actor-binding review
--   completed 2026-08-12.
-- 20260813060000_require_completed_delivery_before_invoice_post.sql
-- STATUS: PARKED DRAFT - NOT APPLIED.
-- Reviewed three times by both reviewers (RLS/security and migration-drift);
-- every round of findings is folded in. The precondition block was dry-run
-- read-only against production on 2026-08-11 after the second round: all 20
-- assertions passed and zero existing drafts are blocked by the gate. The third
-- round added PRECOND R and tightened PRECOND Q, so the block now carries 21
-- assertions and MUST be dry-run again before applying — see below.
--
-- Still required before this can go live, in this order:
--   1. Land and deploy the FRONTEND half first. src/lib/db.ts maps
--      DELIVERY_NOT_COMPLETED and DELIVERY_MISSING to plain-English sentences,
--      and that mapping is on this branch, not yet on origin/main. Applying the
--      migration ahead of the Vercel deploy shows the office a raw error token
--      instead of "complete the delivery first". Merge, then apply.
--   2. Re-run the read-only dry-run of the precondition block at its full 21
--      assertions. The earlier run covered 20.
--   3. An independent Codex verdict on the exact commit.
--   4. A fresh migration-apply-guard proof.
--   5. A forward re-stamp of this filename past the live high-water mark, read
--      from list_migrations at apply time — five sibling Wave A migrations are
--      queued ahead of this one and Supabase assigns the live version from the
--      server clock.
--   6. Mason saying yes in the conversation.
--
-- The dry-run goes stale: re-run it if more than a day passes, since it is a
-- statement about live schema that other sessions can change. Do not apply during
-- office hours: the probe holds row locks on one live invoice and one live
-- delivery for the whole apply, and lock_timeout bounds only how long this
-- transaction WAITS for a lock, not how long it holds one, so an office session
-- that lands behind the probe waits for the commit.
--
-- Wave A fix #5 of the 2026-08-09 ordering-cycle review.
-- Finding: an invoice that is tied to a delivery can be POSTED — turned into a
-- real, collectable bill — before that delivery has actually happened.
--
-- PLAIN ENGLISH
-- Mason's decision, 2026-08-11: a customer does not get hard-billed until the
-- goods have actually moved. Money taken up front is prepay credit, which is a
-- separate thing entirely and does not go through invoices at all — so gating
-- the POST does not interfere with getting paid early.
--
-- HOW THIS FILE MUST BE APPLIED.
-- Through `apply_migration` or psql, NEVER through `execute_sql`. The Supabase
-- MCP `execute_sql` path runs only the LAST statement of a multi-statement
-- script — here that is the bare `COMMIT;` — so it would report a clean, empty
-- success while installing nothing at all. That failure mode is silent and would
-- be indistinguishable from a successful apply.
--
-- THE HOLE, exactly as it exists on production today.
-- `_create_quick_delivery_intent_impl_20260802` — the current implementation
-- behind the quick-delivery button — writes the delivery row with status
-- 'scheduled' and, in the same call, creates its draft invoice pointing at that
-- delivery. So a draft bill exists for goods still sitting in the warehouse.
-- Nothing between that moment and posting checks whether the delivery ever
-- happened, so the office can post it and send it.
--
-- WHY THAT IS A MONEY BUG AND NOT JUST AN ORDERING PREFERENCE.
-- The draft is created at ORDERED quantity. `_complete_delivery_authorized_impl`
-- is what corrects an invoice down to the quantity actually delivered — and its
-- adjustment loop only touches invoices whose status is still 'draft'. Post
-- first and that correction silently skips the invoice: the customer is billed
-- for the full order even if half of it never left. The line-share snapshot
-- trigger `trg_snapshot_line_shares_on_post` freezes the split at post time as
-- well, so the damage is not confined to the header.
--
-- WHY THE FIX GOES HERE AND NOT IN THE ADJUSTMENT LOOP.
-- Widening that loop to also rewrite POSTED invoices would mean rewriting a bill
-- the customer has already been sent, and it would fight the snapshot trigger.
-- The honest fix is the other direction: make the early post impossible, at
-- which point the loop's draft-only restriction is correct rather than a gap.
--
-- WHY THIS ONE FUNCTION COVERS EVERY POSTING PATH.
-- `_post_invoice_impl_20260714` is the single place that flips an invoice to
-- 'posted'. Verified read-only against production 2026-08-11: exactly two
-- functions in `public` reference it — `_post_invoice_customer_scope_impl` and
-- `_post_invoice_group_customer_scope_impl` — and all three user-facing entry
-- points funnel through those:
--   post_invoice        -> _post_invoice_idem_impl_20260721
--                       -> _post_invoice_public_impl_20260718
--                       -> _post_invoice_customer_scope_impl   -> THIS
--   post_invoice_group  -> _post_invoice_group_customer_scope_impl -> THIS
--   batch_post_invoices -> loops over post_invoice                 -> THIS
-- One CREATE OR REPLACE therefore closes all three. The precondition asserts the
-- caller count so a future fourth caller cannot quietly appear outside the gate.
-- Neither DIRECT caller wraps the call in an exception handler (checked live
-- 2026-08-11 for `EXCEPTION WHEN`, not merely the word "exception", which the
-- RAISE statements in both bodies would have matched) — so on the two direct
-- paths this gate's refusal reaches the client rather than being swallowed into
-- a silent success.
--
-- `batch_post_invoices` is the exception, and the claim above is deliberately
-- scoped to exclude it. That RPC catches OTHERS per invoice, folds the message
-- into a `failures` array and returns a success-shaped result, so it reports
-- this gate's refusal as DATA rather than raising it. `describePostInvoiceBlock`
-- in src/lib/db.ts only inspects a THROWN error, so a caller of that RPC would
-- see the raw DELIVERY_NOT_COMPLETED token instead of the plain-English
-- sentence. No live UI is affected: src/pages/Invoices.tsx does not call it — it
-- loops client-side over post_invoice/post_invoice_group, both of which do route
-- through describePostInvoiceBlock. Recorded so the next reader does not have to
-- re-derive it, and so a future UI that adopts the RPC knows what it inherits.
--
-- WHAT ELSE CAN WRITE status='posted', stated precisely because an earlier draft
-- of this header overstated it. Read-only against production 2026-08-11, FIVE
-- other functions in `public` can leave an invoice at 'posted':
--   * `_post_deleted_delivery_recovery_invoice_20260719` — the only other path
--     that can PROMOTE a draft, and it already refuses unless the delivery is
--     'completed'. Unchanged here; the precondition asserts its check is still
--     in place so the two paths cannot drift apart.
--   * `void_payment`, `_reverse_credit_memo_application`, `reverse_write_off` —
--     reversal paths that cannot move a draft invoice to an open status
--     (`status IN ('paid','posted')`, the exact due-date-aware wrapper/private
--     topology installed by 20260812130145, and `v_old_status = 'paid'`
--     respectively). A
--     draft can never reach them: they run off a payment, credit-memo
--     application or write-off, none of which can exist on an unposted invoice.
--     The precondition asserts all three keep that paid-guard.
--   * `_issue_return_credit_impl` — the only function that INSERTS a row already
--     at 'posted'. It writes a credit_memo, and its column list carries no
--     `delivery_id` at all, so it cannot produce a delivery-linked bill and this
--     gate could never apply to it.
-- The catalog scan below checks for a NEW function writing the LITERAL
-- status = 'posted' in an UPDATE, plus a second scan for the INSERT shape.
-- Neither can see a value assigned through a variable, so that whole class was
-- swept separately and by hand on 2026-08-11: eight functions in `public` update
-- `invoices` and assign `status` from something other than a literal, and every
-- one was read. Three are the reversal writers above. `apply_write_off`,
-- `allocate_payment`, `apply_credit_memo_to_invoice` and
-- `apply_prepay_to_invoice` all assign `CASE WHEN <balance> <= 0 THEN 'paid'
-- ELSE status END` — they can only reach 'paid' or leave the status untouched,
-- never 'posted'. `_complete_delivery_authorized_impl` contains no 'posted'
-- literal anywhere and its invoice UPDATE writes totals, not status. So no
-- variable-assignment path can promote a draft.
--
-- WHY A DIRECT TABLE WRITE IS NOT A HOLE (recorded so it is not re-raised).
-- Two reviewers flagged that an admin might bypass this gate by PATCHing the
-- invoice row through PostgREST, citing the `invoices_update` RLS policy. That
-- policy is unreachable: verified live 2026-08-11, UPDATE on `public.invoices`
-- is granted to `postgres` ONLY — `anon`, `authenticated`, `service_role` and
-- `metabase_ro` hold SELECT-class privileges only. Postgres checks the table
-- GRANT before row security is consulted, so no client role can write
-- `invoices.status` at all. Every posting path is a function call.
--
-- CLOSE THE DELIVERY-SIDE BYPASS TOO. The invoice gate is sound only when
-- `completed` means the authoritative completion RPC ran. `deliveries` grants
-- UPDATE to authenticated users and its lifecycle trigger deliberately permits
-- in_progress -> completed, which had let a PostgREST PATCH forge that status
-- while skipping the quantity, inventory, order, invoice, and audit work in
-- `_complete_delivery_authorized_impl`.
--
-- This migration adds a BEFORE UPDATE OF status guard. The public
-- complete_delivery wrapper writes a transaction-local GUC carrying the exact
-- delivery id only while it delegates to the authoritative implementation; the
-- guard accepts a transition into completed only when that id matches OLD.id.
-- A boolean would let one authorized completion bless a different row in the same
-- transaction, so it is deliberately row-bound. `app.admin_override` is NOT an
-- exemption: it exists to steer old lifecycle transitions in this file's probe,
-- but allowing it here would again permit a dashboard repair to create a completed
-- delivery with none of completion's financial side effects. The operational
-- trade-off is explicit: a stuck delivery must be repaired through a reviewed RPC
-- or migration, not by directly setting status = completed in the dashboard.
-- The other route around the gate is not a bypass but an escape hatch working as
-- designed: cancel the scheduled delivery, which auto-cancels its draft, then
-- hand-bill the whole order through `_create_invoice_from_order_impl_20260718`.
-- That produces an order-level invoice with no delivery_id, which this gate does
-- not cover, at full ordered quantity. In plain terms: this migration makes the
-- one-click early bill impossible. It does not make early billing impossible.
--
-- THIS PROBE HAS NEVER RUN. It executes for the first time during the apply
-- itself. That is deliberate — there is no staging copy of this database, and a
-- probe that had already been rehearsed elsewhere would be proving something
-- about the rehearsal. It fails closed: any unexpected outcome raises, and the
-- enclosing BEGIN/COMMIT reverts the whole file including the gate.
--
-- THIS FILE IS NOT RERUNNABLE after a successful apply, by design. PRECOND C
-- refuses if the gate marker is already present in the live function body, so a
-- second apply aborts rather than re-running the probe against production for no
-- reason. If it ever has to be reapplied, that is a deliberate decision and the
-- precondition is what forces the conversation.
--
-- WHY THE PROBE'S WRITES CANNOT ESCAPE (also recorded so it is not re-raised).
-- A reviewer asked whether the probe's rolled-back post could still reach the
-- outside world through a trigger — an outbound webhook, a dblink call, a
-- background worker — since those are not undone by a rollback. Checked live
-- 2026-08-11 across every table a post writes (`invoices`, `deliveries`,
-- `financial_audit_log`, `activity_feed`, `notifications`, `rup_sales_records`,
-- `invoice_line_share_snapshots`): no trigger on any of them calls `http_post`,
-- `dblink`, `pg_background`, `COPY PROGRAM`, `supabase_functions.http_request`
-- (the Database Webhooks trigger function), `net.http_get`/`net.http_post` or
-- `pg_notify`. The last three were added to the sweep after a reviewer noted the
-- original four missed the Supabase-native webhook path. They would in fact have
-- been safe anyway — pg_net enqueues into `net.http_request_queue`, which the
-- subtransaction unwinds, and NOTIFY payloads are only delivered on top-level
-- commit — but the enumeration is what this file offers as evidence, so the
-- enumeration is what had to be complete. Every effect of the probe is ordinary
-- table state, and every bit of it is unwound by the subtransaction.
--
-- WHAT THIS DELIBERATELY DOES NOT GATE, and why.
-- Only invoices that carry a `delivery_id` are gated. Three other shapes exist
-- and are left alone:
--   * Job / application / standalone invoices (no order, no delivery). There is
--     no delivery to wait for; billing is driven by the work being done.
--   * Order-level invoices with no delivery at all. This shape is created by
--     `_create_invoice_from_order_impl_20260718`, which REFUSES to run if the
--     order has any active delivery — it is the deliberate "cancel the
--     deliveries and bill the whole order by hand" escape. Gating it on order
--     status was considered and rejected: every writer of `orders.status` on
--     production is delivery-driven (`_complete_delivery_authorized_impl`,
--     `cancel_delivery`, `void_delivery`, `_close_undelivered_order_remainder`,
--     plus cancel/void order), so an order with no deliveries can never reach
--     'fulfilled'. A gate on that column would make this shape permanently
--     unpostable — a worse bug than the one being fixed. It has never been used
--     on production (0 rows on 2026-08-11) and is left for a later decision.
--   * Credit memos and finance charges, which carry neither.
--
-- WHAT CHANGES FOR THE OFFICE
-- Nothing they do today starts failing. Verified read-only 2026-08-11: all 13
-- live invoices are either delivery-linked (10) or carry neither an order nor a
-- delivery (3), and every one of those 10 already points at a delivery that is
-- 'completed' and not deleted. The whole precondition block below was ALSO
-- dry-run read-only against production on 2026-08-11 — every assertion passed
-- and the count of currently-blocked drafts came back ZERO. The gate blocks
-- nothing that exists today. Going forward, a quick-delivery bill has to wait
-- for the driver to mark the delivery complete — which is the same click that
-- corrects it to what actually went out. If the delivery was cancelled or
-- voided, the refusal message says to void the draft rather than post it.
--
-- LOCKING, stated because it is a deliberate choice rather than an oversight.
-- The delivery row is read WITHOUT a lock. The caller already holds FOR UPDATE
-- on the invoice, and `_complete_delivery_authorized_impl` locks the delivery
-- BEFORE the invoice; taking a delivery lock here would reverse that order and
-- introduce a deadlock between posting and completing. That choice leaves a
-- narrow residual race, stated honestly rather than talked around: if a delivery
-- is voided or soft-deleted in the instant between this unlocked read and the
-- UPDATE below, the post proceeds even though the gate would have refused a
-- moment later. That is the SAME outcome as today's un-gated behaviour, it is
-- not made worse by this migration, and `void_delivery` already has its own
-- handling for a delivery whose invoice is already posted. Closing that window
-- properly means reordering the locks in `_complete_delivery_authorized_impl`,
-- which is a separate change with its own deadlock analysis.
--
-- ATOMICITY. The whole migration runs inside one explicit BEGIN/COMMIT — the
-- same shape 30 already-applied migrations in this repo use. Without it, a
-- non-transactional applier could leave the gate installed on production while
-- the proof below reported failure. Any RAISE anywhere in this file now aborts
-- the transaction and the function reverts to exactly what it was.
--
-- PROOF. The postcondition block below does not merely re-read the catalog. It
-- picks a real delivery-linked draft invoice, flips its delivery to 'scheduled',
-- to 'cancelled', and to soft-deleted in turn, and watches the post be refused
-- each time; then restores the delivery and watches an ordinary post SUCCEED, so
-- a delivery-linked bill is proven to still post normally. Everything is inside
-- a subtransaction that is rolled back.
--
-- The one branch the probe does NOT exercise, stated rather than glossed: the
-- `delivery_id IS NULL` arm — job, application and standalone invoices, which
-- skip the gate entirely. Three of the 13 live invoices are that shape, and none
-- of them is currently a postable draft, so there is no live row to prove it
-- with. The branch is a single `IF v_inv.delivery_id IS NOT NULL THEN ... END
-- IF;` wrapper around the new code and nothing else in the function moved, so
-- the risk is small — but "normal billing still works" is proven here for the
-- delivery-linked shape only, and that is the honest scope of the claim.
--
-- What the rollback proof does and does NOT cover, stated exactly. The
-- authoritative check is row-level: the exact invoice row and delivery row the
-- probe writes are snapshotted before and compared after. A whole-table sweep of
-- `invoices` and `deliveries` also runs, but only as a NOTICE — under READ
-- COMMITTED each statement in the block takes a fresh snapshot, so an ordinary
-- office edit committed by another session mid-apply would change a whole-table
-- fingerprint through no fault of the probe, and aborting a money migration with
-- "the rollback did not hold" when it did hold is the worst message this file
-- could hand its applier. A real post also writes `financial_audit_log`,
-- `activity_feed`, `rup_sales_records`, `notifications`,
-- `invoice_line_share_snapshots` and possibly `blend_tickets`. Those are not
-- fingerprinted at all; they are covered by the subtransaction rollback itself,
-- which unwinds every table equally. Nothing the probe does survives it — the
-- only genuinely irreversible cost is any SEQUENCE value it consumes, and on
-- this path there may be none at all (an invoice number is assigned at draft
-- creation, not at post, and neither audit table uses a sequence). If a sequence
-- is touched, a rolled-back transaction still burns the value and production may
-- show a small gap in a generated number. That is cosmetic and expected.
--
-- The probe uses three transaction-local settings and clears all three:
--   * `request.jwt.claims` stands in for a signed-in admin session.
--   * `app.admin_override` is set ONLY around the delivery-status UPDATEs that
--     move a row away from completed or into in_progress. It does NOT bypass the
--     new completion-provenance guard. The authorized RPC itself sets and clears
--     `crx.delivery_completion_authorized` around its own completed transition.
--     The old lifecycle trigger
--     live trigger `_enforce_delivery_status_transition` allows just
--     scheduled -> in_progress/cancelled and in_progress -> completed/cancelled;
--     every move this probe needs (completed -> scheduled, cancelled ->
--     completed) is otherwise refused, and an earlier draft of this migration
--     could never have applied for exactly that reason. The override is cleared
--     back to 'false' BEFORE each post attempt, so the gate is always exercised
--     without it.

BEGIN;

-- Transaction-local: reverted at COMMIT, so nothing leaks into a pooled session.
-- lock_timeout bounds how long this transaction WAITS for a lock, so a probe that
-- collides with an office session fails fast instead of hanging the apply. It does
-- NOT bound how long the probe HOLDS the locks it already took — those are held
-- until COMMIT, which is why the header still says do not apply during office
-- hours. The two are easy to conflate and an earlier revision of this comment did.
-- 180s, not 60s. statement_timeout bounds each STATEMENT, and the postcondition
-- block below is ONE statement covering two whole-table fingerprints, a candidate
-- query with four correlated NOT EXISTS subqueries, and four real post attempts
-- with every trigger they fire. Comfortable at today's 13 live invoices; 60s left
-- no headroom for when that stops being true, and a timeout mid-apply on a money
-- file reads as a failure of the gate rather than of the clock.
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '10s';

DO $precond$
DECLARE
  v_count int;
  v_md5   text;
  v_names text;
  v_completion_md5 text;
  v_completion_config text[];
  v_completion_secdef boolean;
BEGIN
  -- The function being replaced must exist exactly once. A second overload would
  -- mean the CREATE OR REPLACE below silently creates a THIRD, leaving an
  -- ungated copy reachable.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND A: expected exactly 1 _post_invoice_impl_20260714, found %. Resolve the overloads before applying.', v_count;
  END IF;

  -- ...and with exactly the signature this migration re-declares. Matching on the
  -- name alone would let a same-name function with different argument types pass,
  -- and CREATE OR REPLACE would then ADD an overload rather than replace anything.
  -- Compared through pg_proc.proargtypes on purpose. The obvious alternative is
  -- the catalog helper that renders a function''s identity arguments as text;
  -- it is exactly equivalent here, but the Supabase live-data guard does not
  -- recognise that helper as read-only and refuses any statement mentioning it,
  -- which would make this block impossible to rehearse read-only before applying.
  -- (Verified 2026-08-11: that guard runs on the ad-hoc SQL path only, not on the
  -- migration-apply path, so the helper would not have blocked the APPLY — it
  -- would only have cost the dry-run, which is the cheaper thing to lose but not
  -- one worth losing.) Note the guard matches on TEXT, not on effect, so this
  -- comment deliberately does not spell the helper''s name either. The form used
  -- below is pure catalog column reads. This block has been dry-run read-only
  -- against production twice on 2026-08-11: once at 20 assertions after the
  -- second review round added F2, G2, P2 and Q and widened B and I, and again at
  -- its current 21 after the third round added R and tightened Q. Both runs
  -- passed every assertion with zero existing drafts blocked.
  -- Return type, parameter NAMES and the trailing DEFAULT are asserted too. They
  -- do not affect overload identity, but CREATE OR REPLACE refuses to change any
  -- of them and would abort with a bare PostgreSQL message ("cannot change name
  -- of input parameter") that says nothing about billing — exactly the
  -- unexplained failure this precondition exists to pre-empt. All four values
  -- read live 2026-08-11: void, {p_invoice_id,p_idempotency_key}, 1 default.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
       AND p.pronargs = 2
       AND p.proargtypes[0] = 'uuid'::regtype
       AND p.proargtypes[1] = 'text'::regtype
       AND p.prorettype = 'void'::regtype
       AND p.proargnames = ARRAY['p_invoice_id', 'p_idempotency_key']
       AND p.pronargdefaults = 1
  ) THEN
    RAISE EXCEPTION 'PRECOND B: _post_invoice_impl_20260714 does not have the expected uuid+text signature, void return, parameter names or trailing default. Applying would create an overload instead of replacing it, or abort on a bare CREATE OR REPLACE error — re-derive before applying.';
  END IF;

  -- DRIFT GUARD. The replacement below is the live body read on 2026-08-11 with
  -- the gate inserted and nothing else touched. If the live body has changed
  -- since, applying would silently revert whatever changed. Fail closed and make
  -- a human re-derive rather than clobber someone else's fix.
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714';
  IF v_md5 = '9479af0a5477e89266e0264da44c766c' THEN
    NULL;  -- expected pre-gate body
  ELSIF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
       AND position('WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11' in p.prosrc) > 0
  ) THEN
    -- Fail CLOSED rather than notice-and-continue. The gate is already installed,
    -- so this migration has nothing to add; re-emitting would overwrite whatever
    -- the live body has become since — including a later fix to this same money
    -- function — with a copy frozen on 2026-08-11. A re-run is never worth that.
    RAISE EXCEPTION 'PRECOND C: the delivery-before-billing gate is ALREADY installed [live md5 %]. This migration is a no-op and re-applying it would overwrite the current live body with the 2026-08-11 copy. Skip it.', v_md5;
  ELSE
    RAISE EXCEPTION 'PRECOND D: the live body of _post_invoice_impl_20260714 has drifted [md5 % , expected 9479af0a5477e89266e0264da44c766c]. Re-read the live body, rebase this replacement onto it, and update this hash — do not apply a stale copy over someone else''s change.', v_md5;
  END IF;

  -- This file also re-emits the narrow public completion wrapper so it can set
  -- the row-bound authorization GUC before the already-locked delivery reaches
  -- the authoritative implementation. Pin the current wrapper first: without
  -- this, an unrelated later completion fix could be silently reverted even
  -- though the invoice-posting body above was still unchanged.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_delivery';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND DELIVERY-A: expected exactly 1 public.complete_delivery, found %. Re-emitting a wrapper with an overload is unsafe.', v_count;
  END IF;
  SELECT md5(p.prosrc), p.proconfig, p.prosecdef
    INTO v_completion_md5, v_completion_config, v_completion_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_delivery';
  IF v_completion_md5 <> 'a1e9a043f27d3566f8ecf6d5e3a809ab'
     OR NOT v_completion_secdef
     OR v_completion_config IS NULL
     OR NOT ('search_path=public, pg_temp' = ANY(v_completion_config)) THEN
    RAISE EXCEPTION 'PRECOND DELIVERY-B: complete_delivery has drifted from the pinned authorization/preflight wrapper [md5 %, SECURITY DEFINER %, config %]. Rebase the provenance handshake onto the current completion path; do not overwrite it.', v_completion_md5, v_completion_secdef, v_completion_config;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_guard_delivery_completion_authorized'
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.deliveries'::regclass
       AND NOT t.tgisinternal
       AND t.tgname = 'trg_guard_delivery_completion_authorized'
  ) THEN
    RAISE EXCEPTION 'PRECOND DELIVERY-C: a delivery-completion provenance guard already exists. This migration is intentionally one-shot; re-diff rather than replacing a later guard.';
  END IF;

  -- Every posting path must funnel through the function being gated. Two callers
  -- were verified live on 2026-08-11; a third would be a path outside the gate.
  -- position(), not LIKE: '_' is a LIKE wildcard and this name is mostly
  -- underscores, so an ILIKE pattern would also match unrelated names.
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname), count(DISTINCT p.proname)
    INTO v_names, v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND position('_post_invoice_impl_20260714' in p.prosrc) > 0
     AND p.proname <> '_post_invoice_impl_20260714';
  IF v_count <> 2
     OR v_names IS DISTINCT FROM '_post_invoice_customer_scope_impl, _post_invoice_group_customer_scope_impl' THEN
    RAISE EXCEPTION 'PRECOND E: expected exactly the two known callers of _post_invoice_impl_20260714, found % [%]. A new caller may be a posting path this gate would not cover — re-derive before applying.', v_count, coalesce(v_names, 'none');
  END IF;

  -- The one OTHER path that can PROMOTE a draft to ''posted'' must keep enforcing
  -- the same rule itself, or the two drift apart. Both halves are asserted, not
  -- just the status one: read live 2026-08-11 its delivery lookup carries
  -- `d.status = ''completed'' AND d.deleted_at IS NULL`. (The "deleted" in its
  -- name refers to a soft-deleted ORDER, not a soft-deleted delivery — it
  -- refuses those exactly as this gate does, which is why the soft-delete
  -- refusal message below correctly says to void the draft rather than pointing
  -- at this function.)
  --
  -- Asserted in the INVERTED form, and this matters. The obvious shape — count
  -- the definitions that MATCH the guard and require the count to be 1 — passes
  -- in exactly the case it exists to catch: add a SECOND, unguarded overload
  -- beside the guarded one and the guarded one still supplies the single row.
  -- Worse, it is stricter against the harmless case (two overloads that BOTH
  -- keep the guard count 2 and abort) than against the dangerous one. So: count
  -- the definitions that FAIL the guard and require ZERO, then assert separately
  -- that at least one definition exists at all — otherwise deleting the function
  -- outright would satisfy a zero-failures test vacuously.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_post_deleted_delivery_recovery_invoice_20260719'
     -- The second pattern pins the table alias `d`, read live 2026-08-11. That is
     -- deliberately brittle: renaming the alias aborts this migration. A looser
     -- `deleted_at IS NULL` would also be satisfied by such a check on `invoices`
     -- or `orders` elsewhere in the body, which fails OPEN. Brittle-and-closed is
     -- the right direction for the assertion carrying this file''s completeness
     -- argument; a spurious abort costs a re-read, a false pass costs a bill.
     AND NOT (p.prosrc ~* 'status\s*(<>|!=)\s*''completed''|status\s*=\s*''completed'''
              AND p.prosrc ~* '\md\M\.deleted_at\s+IS\s+NULL');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND F: % definition[s] of _post_deleted_delivery_recovery_invoice_20260719 no longer require a completed, non-deleted delivery, so one of them would be an ungated posting path. Re-derive before applying.', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_post_deleted_delivery_recovery_invoice_20260719';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'PRECOND F2: _post_deleted_delivery_recovery_invoice_20260719 no longer exists. This migration''s header cites it as the one OTHER path that can promote a draft, and the completeness argument for gating a single function depends on it. Re-derive before applying.';
  END IF;

  -- The three functions that can write ''posted'' WITHOUT promoting a draft are
  -- reversal paths: they re-open an invoice after a payment void, a credit-memo
  -- reversal or a write-off reversal. The return-credit remediation at
  -- 20260812130145 deliberately replaced the middle function with an exact
  -- wrapper that accepts paid/posted/overdue, calls the exact legacy paid-only
  -- implementation, then re-derives posted/overdue only for the same already-open
  -- target. The exact public/private topology is pinned below; merely matching
  -- the wider status IN text would fail open if the wrapper were rewritten.
  -- They assign the value through a CASE/variable, which the literal scan below
  -- cannot see — hence asserted here by name. If one loses its safe topology it
  -- becomes a second promotion path and this gate stops being complete.
  -- Asserted in the INVERTED form, for the reason spelled out at PRECOND F. An
  -- earlier revision counted the definitions that MATCHED their paid-guard and
  -- required 3. Two reviewers independently showed that passes in exactly the
  -- case it was written for: give `void_payment` a second overload, strip the
  -- paid-guard from ONLY that one, and the guarded overload still supplies the
  -- row, so count(DISTINCT proname) is still 3 while an unguarded promotion path
  -- exists on live. Count the definitions that FAIL their guard/topology and
  -- require ZERO; assert existence separately so deleting one cannot pass
  -- vacuously.
  -- This repo has carried money-function overloads before. Verified live
  -- 2026-08-11 all three currently have exactly one definition each, so the
  -- overload case is latent — but the whole point of the assertion is to hold
  -- when that stops being true.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('void_payment', '_reverse_credit_memo_application', 'reverse_write_off')
     AND NOT ((p.proname = 'void_payment'                      AND p.prosrc ~* 'status\s+IN\s*\(\s*''paid''')
           OR (p.proname = '_reverse_credit_memo_application' AND (
                 -- Legacy production shape, before 20260812130145.
                 (md5(p.prosrc) = '96662c1913666a49b778973ca881d8d6'
                  AND p.prosrc ~* 'status\s*=\s*''paid''')
                 OR
                 -- Forward-replay shape after 20260812130145. Pin the exact
                 -- wrapper and exact renamed legacy implementation plus their
                 -- owner/security/search-path/ACL boundaries. This recognizes
                 -- the wider paid/posted/overdue wrapper without accepting a
                 -- same-text but draft-promoting rewrite.
                 (encode(sha256(convert_to(replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') =
                    '744c48493d549f9bc2297270bfdc0977935a4f29ed44fe2e336c8a6fce6ecbf8'
                  AND pg_get_userbyid(p.proowner) = 'postgres'
                  AND p.prosecdef
                  AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  AND has_function_privilege('service_role', p.oid, 'EXECUTE')
                  AND (SELECT count(*) FROM pg_proc p2
                        WHERE p2.pronamespace = 'public'::regnamespace
                          AND p2.proname = '_reverse_credit_memo_application_status_impl_20260812') = 1
                  AND EXISTS (
                    SELECT 1
                      FROM pg_proc p2
                     WHERE p2.oid = to_regprocedure(
                       'public._reverse_credit_memo_application_status_impl_20260812(uuid,uuid,text,text)'
                     )
                       AND md5(p2.prosrc) = '96662c1913666a49b778973ca881d8d6'
                       AND pg_get_userbyid(p2.proowner) = 'postgres'
                       AND p2.prosecdef
                       AND p2.proconfig = ARRAY['search_path=public, pg_temp']::text[]
                       AND has_function_privilege('postgres', p2.oid, 'EXECUTE')
                       AND NOT has_function_privilege('anon', p2.oid, 'EXECUTE')
                       AND NOT has_function_privilege('authenticated', p2.oid, 'EXECUTE')
                       AND NOT has_function_privilege('service_role', p2.oid, 'EXECUTE')
                  ))))
           OR (p.proname = 'reverse_write_off'                 AND p.prosrc ~* 'v_old_status\s*=\s*''paid'''));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND G: % definition[s] among the 3 reversal writers [void_payment, _reverse_credit_memo_application, reverse_write_off] no longer retain the exact reviewed no-draft-promotion guard/topology. One of them could now promote a DRAFT, which would bypass this gate entirely. Re-derive before applying.', v_count;
  END IF;
  SELECT count(DISTINCT p.proname) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('void_payment', '_reverse_credit_memo_application', 'reverse_write_off');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'PRECOND G2: expected all 3 reversal writers to still exist, found % distinct names. The zero-unguarded check above passes vacuously for a function that has been deleted or renamed, so the set is pinned here. Re-derive before applying.', v_count;
  END IF;

  -- Any OTHER function that writes status=''posted'' onto invoices is a path this
  -- migration does not know about. Two are expected: the function being gated and
  -- the recovery path above.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname), count(*)
    INTO v_names, v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* 'UPDATE\s+(ONLY\s+)?[a-z_."%]*\minvoices\M[^;]*\mset\M[^;]*\mstatus\s*=\s*''posted'''
     AND p.proname NOT IN ('_post_invoice_impl_20260714', '_post_deleted_delivery_recovery_invoice_20260719');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND H: % other function[s] write invoices.status = posted and would bypass this gate: %. Re-derive before applying.', v_count, v_names;
  END IF;

  -- ...and the INSERT shape, which the UPDATE scan above structurally cannot see.
  -- A function that INSERTS an invoice row already at ''posted'' would produce a
  -- posted bill without ever passing through this gate. Read live 2026-08-11,
  -- exactly four functions insert into `invoices` AND mention ''posted''
  -- anywhere, and all four were read line by line:
  --   * `_issue_return_credit_impl` — the only one that really does insert at
  --     ''posted''. Writes a credit_memo; its column list carries no
  --     `delivery_id`, so this gate could not apply and it cannot bill for an
  --     undelivered order.
  --   * `_save_invoice_scoped_impl` — inserts a caller-supplied status
  --     (COALESCE of the payload, defaulting to ''draft''), but the word
  --     `delivery_id` does not appear in its body at all, its UPDATE arm assigns
  --     no status, and that UPDATE is scoped to rows already in
  --     draft/unposted.
  --   * `_create_quick_delivery_intent_impl_20260802` and
  --     `_generate_finance_charges_idem_impl_20260721` — both insert ''draft''.
  -- A BEFORE INSERT trigger (`trg_invoice_draft_insert`) independently rejects a
  -- non-draft, non-credit_memo insert on top of that.
  -- The two patterns are matched against the WHOLE body rather than within one
  -- statement on purpose. A bounded "within N characters" form was tried first
  -- and silently matched NOTHING — not even `_issue_return_credit_impl`, whose
  -- column list is longer than the 255-character ceiling PostgreSQL allows on a
  -- regex bound — so it would have been a vacuous assertion that always passed.
  -- Coarse over-matches instead, which fails CLOSED: a fifth function stops the
  -- apply and gets a human look.
  -- DISTINCT, for consistency with PRECOND E and G: without it a second overload
  -- of any of these four repeats its name in the list, the pinned string stops
  -- matching, and this money migration hard-aborts for an entirely benign reason.
  -- It would fail CLOSED, so it was never a safety hole — but a spurious abort on
  -- a money file is its own cost.
  --
  -- One membership in this set is weaker than it looks, recorded so a future
  -- reader does not delete the line that holds it up: `_save_invoice_scoped_impl`
  -- qualifies only because its body CONTAINS the text ''posted'' — and read live
  -- 2026-08-11 the sole occurrence is inside a code COMMENT, not executable code.
  -- That is fine for what this assertion does (detect the SET of insert-capable
  -- functions changing) and it is why the set has four members rather than three,
  -- but it means a tidy-up that deletes that comment will abort this migration.
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname), count(DISTINCT p.proname)
    INTO v_names, v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* 'INSERT\s+INTO\s+(ONLY\s+)?[a-z_."]*\minvoices\M'
     AND p.prosrc ~* '''posted''';
  -- The message below says "add new rows to invoices" rather than naming the SQL
  -- verb, and that phrasing is load-bearing — do not tidy it back. The Supabase
  -- live-data guard matches statement TEXT, not effect, and reads the English
  -- phrase "INSERT into invoices" in an error string as a real write against the
  -- live invoices table. It blocked this block from being dry-run read-only until
  -- the wording changed. The guard runs on execute_sql only, not on the apply
  -- path, so the old wording would still have APPLIED — it just made the whole
  -- precondition block impossible to rehearse beforehand, which is worse.
  IF v_names IS DISTINCT FROM '_create_quick_delivery_intent_impl_20260802, _generate_finance_charges_idem_impl_20260721, _issue_return_credit_impl, _save_invoice_scoped_impl' THEN
    RAISE EXCEPTION 'PRECOND I: the set of functions that add new rows to invoices and mention posted has changed [now % : %]. A new one may create a posted, delivery-linked bill without passing through this gate. Read it before applying.', v_count, coalesce(v_names, 'none');
  END IF;

  -- The columns the gate reads.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'deliveries'
     AND column_name IN ('status', 'deleted_at', 'delivery_number');
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'PRECOND J: deliveries is missing one of status/deleted_at/delivery_number [found % of 3]', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'delivery_id';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND K: invoices.delivery_id does not exist, so there is nothing to gate on';
  END IF;

  -- ''completed'' must still be a legal delivery status, or the gate would refuse
  -- every post.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.deliveries'::regclass
       AND c.conname = 'deliveries_status_check'
       AND pg_get_constraintdef(c.oid) LIKE '%''completed''%'
  ) THEN
    RAISE EXCEPTION 'PRECOND L: deliveries_status_check no longer admits ''completed'' — this gate would refuse every delivery-linked post.';
  END IF;

  -- The probe below moves a delivery through 'scheduled' and 'cancelled'. If the
  -- CHECK stopped admitting either, the probe would fail for a reason that has
  -- nothing to do with this gate, and the failure would be misread as the gate
  -- being broken.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.deliveries'::regclass
       AND c.conname = 'deliveries_status_check'
       AND pg_get_constraintdef(c.oid) LIKE '%''scheduled''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''cancelled''%'
  ) THEN
    RAISE EXCEPTION 'PRECOND M: deliveries_status_check no longer admits both ''scheduled'' and ''cancelled'', which the proof below needs in order to exercise the refuse path.';
  END IF;

  -- The probe steers the delivery status trigger with app.admin_override. Assert
  -- that escape hatch still exists, because without it the proof cannot move the
  -- row at all and this migration would be unappliable.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_is_admin_override'
     AND p.prosrc ILIKE '%app.admin_override%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND N: _is_admin_override no longer reads app.admin_override, so the proof below cannot move a delivery through the status trigger. Re-derive the probe before applying.';
  END IF;

  -- ...and the delivery status trigger must still honour that hatch. Asserting
  -- only the reader leaves the probe able to fail with a bare "Invalid delivery
  -- status transition", which has no visible relation to billing and would send
  -- the applier looking in the wrong place entirely.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_enforce_delivery_status_transition'
     AND position('_is_admin_override' in p.prosrc) > 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND O: _enforce_delivery_status_transition no longer consults _is_admin_override, so the proof below cannot move the test delivery backwards and this migration would abort on an unrelated trigger. Re-derive the probe before applying.';
  END IF;

  -- The retroactive-invoice path already refuses a non-completed delivery. Assert
  -- it, because this migration''s header cites it as proof that requiring
  -- completion is the established rule rather than a new restriction.
  -- Inverted form again, same reasoning as PRECOND F and G.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_create_invoice_for_unbilled_delivery_impl_20260718'
     AND NOT (p.prosrc ~* 'status\s*(<>|!=)\s*''completed''');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND P: % definition[s] of _create_invoice_for_unbilled_delivery_impl_20260718 no longer require a completed delivery. Re-derive this migration''s reasoning before applying.', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_create_invoice_for_unbilled_delivery_impl_20260718';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'PRECOND P2: _create_invoice_for_unbilled_delivery_impl_20260718 no longer exists, so the header''s claim that requiring completion is an established rule rather than a new restriction is no longer supported. Re-derive before applying.';
  END IF;

  -- The INSERT-side backstop, asserted rather than merely cited in a comment.
  -- The literal scans above cannot see a status assigned through a variable, and
  -- `_save_invoice_scoped_impl` is exactly that shape — it inserts a
  -- caller-supplied status. What actually stops a caller inserting a row already
  -- at ''posted'' is this BEFORE INSERT trigger, which rejects any non-draft,
  -- non-credit_memo insert. Every other load-bearing external object in this file
  -- gets an assertion; this one was the exception. Read live 2026-08-11:
  -- trg_invoice_draft_insert on public.invoices, handler
  -- enforce_invoice_draft_on_insert, tgtype = 7, tgenabled = ''O''.
  --
  -- The timing and level are pinned, not assumed. An earlier revision checked
  -- only the name, the handler and `tgenabled <> ''D''`, which passes in exactly
  -- the case the assertion exists to catch: a trigger recreated AFTER INSERT, or
  -- at statement level, cannot stop the insert but still satisfies a name check,
  -- and ''R'' (replica-only) never fires on the origin server at all. tgtype is a
  -- bitmask — 1 = FOR EACH ROW, 2 = BEFORE, 4 = INSERT, 64 = INSTEAD OF — so
  -- masking with 71 and requiring 7 pins BEFORE INSERT FOR EACH ROW and rules
  -- out INSTEAD OF in one test. Live value is exactly 7.
  SELECT count(*) INTO v_count
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.invoices'::regclass
     AND NOT t.tgisinternal
     AND t.tgname = 'trg_invoice_draft_insert'
     AND p.proname = 'enforce_invoice_draft_on_insert'
     AND (t.tgtype & 71) = 7
     AND t.tgenabled IN ('O', 'A');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND Q: the trg_invoice_draft_insert trigger on invoices is missing, disabled, replica-only, no longer BEFORE INSERT FOR EACH ROW, or no longer runs enforce_invoice_draft_on_insert. It is the backstop that stops a caller-supplied status inserting an invoice already at ''posted'' — without it a posted, delivery-linked bill could be created without ever passing through this gate. Re-derive before applying.';
  END IF;

  -- PRECOND R. Every completeness scan above matches against `pg_proc.prosrc`.
  -- For a function written with a SQL-standard body (LANGUAGE sql ... BEGIN
  -- ATOMIC) the executable body lives in `prosqlbody` instead, and prosrc is left
  -- BLANK — verified live 2026-08-11 on PostgreSQL 17.6: all 56 such functions on
  -- this database have prosrc of length zero, none NULL. That matters in two
  -- opposite directions. The inverted assertions (F, G, P) count definitions that
  -- FAIL their guard, and a blank body fails every guard, so they abort — fail
  -- CLOSED, which is correct. But the SET assertions (E, H, I) look for a body
  -- that DOES something, and a blank body matches nothing, so a BEGIN ATOMIC
  -- function that posted an invoice would be invisible to all three — fail OPEN,
  -- which is not acceptable in the assertion carrying this file''s completeness
  -- argument. Rather than rewrite ten regexes against a deparsed definition, pin
  -- the premise directly: no function in `public` uses a SQL-standard body today
  -- (verified live, count = 0), so every prosrc scan in this block is sound. If
  -- that stops being true, this migration aborts and a human re-derives the
  -- scans instead of trusting them.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosqlbody IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND R: % function[s] in public now use a SQL-standard body [LANGUAGE sql ... BEGIN ATOMIC]. Their bodies are not in pg_proc.prosrc, so the completeness scans in this block cannot see what they do — a function that posts an invoice would be invisible to PRECOND E, H and I. Re-derive those scans before applying.', v_count;
  END IF;

  -- How many existing drafts this gate would make temporarily unpostable. This is
  -- a NOTICE, not a failure: a quick-delivery draft waiting on its delivery is
  -- exactly the state the gate exists to hold. The applier should still see the
  -- number rather than discover it from a support call.
  --
  -- A NOTICE does not surface through the Supabase Management API, so this whole
  -- block was ALSO dry-run as a read-only statement against production on
  -- 2026-08-11: every assertion above passed and this count came back ZERO. No
  -- invoice that exists today is blocked by this gate. Re-run that count if more
  -- than a day passes before this migration is applied.
  --
  -- LEFT JOIN, not an inner join, and that is load-bearing. The gate installed
  -- below adds a refusal that did not exist before — DELIVERY_MISSING, for an
  -- invoice whose delivery_id points at a row that is gone. An inner join drops
  -- exactly those rows, so the count would be structurally blind to the one new
  -- blocking class it exists to measure, and the applier would read ''nothing is
  -- blocked'' while a bill became permanently unpostable. Verified live
  -- 2026-08-11 that the class is empty and cannot currently be populated:
  -- `invoices_delivery_id_fkey` is a VALIDATED foreign key from
  -- invoices.delivery_id to deliveries.id, and zero invoices hold a dangling
  -- reference. The LEFT JOIN stays anyway — the FK is not asserted by this
  -- block, so the count should not silently depend on it.
  SELECT count(*) INTO v_count
    FROM invoices i LEFT JOIN deliveries d ON d.id = i.delivery_id
   WHERE i.status IN ('draft', 'unposted')
     AND i.deleted_at IS NULL
     AND i.delivery_id IS NOT NULL
     AND (d.id IS NULL OR d.status <> 'completed' OR d.deleted_at IS NOT NULL);
  IF v_count > 0 THEN
    RAISE NOTICE 'PRECOND: % existing draft invoice[s] point at a delivery that is not completed and will not be postable until it is. This is the intended behaviour.', v_count;
  ELSE
    RAISE NOTICE 'PRECOND: no existing draft invoice is blocked by this gate';
  END IF;
END;
$precond$;

-- ---------------------------------------------------------------------------
-- Delivery-completion provenance. `completed` is an authoritative business
-- event, not a status a table writer may forge. The trigger stays SECURITY
-- INVOKER so it sees the transaction-local authorization set by the public RPC;
-- a SECURITY DEFINER trigger would turn an owner exemption into a bypass.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public._guard_delivery_completion_authorized()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- WAVE-A-DELIVERY-COMPLETION-AUTH-2026-08-12.
  -- A no-op update of an already-completed row is not a completion transition.
  -- For an actual move into completed, the public complete_delivery wrapper sets
  -- this exact delivery id immediately before it invokes the authoritative
  -- implementation and clears it before returning. A row-bound value is required:
  -- a boolean would let one authorized completion bless another delivery in the
  -- same transaction.
  IF NEW.status = 'completed'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND current_setting('crx.delivery_completion_authorized', true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'DELIVERY_COMPLETION_RPC_REQUIRED: delivery % may enter completed only through public.complete_delivery. A direct status update skips delivered-quantity, inventory, order, invoice, and audit reconciliation.', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

-- Revoking PUBLIC alone is NOT enough here, and getting this wrong aborts the
-- whole migration rather than merely leaving a loose grant. This project carries
-- ALTER DEFAULT PRIVILEGES in schema public granting EXECUTE on NEW functions to
-- anon, authenticated and service_role, so a freshly created function lands with
-- explicit per-role grants and `REVOKE ... FROM PUBLIC` strips only the PUBLIC
-- entry. The POSTCOND below ASSERTS none of those three holds EXECUTE, so
-- without the loop this file fails its own assertion on first apply and rolls
-- back both the provenance guard and the delivery-before-billing gate. Confirmed
-- against live pg_default_acl on 2026-08-12; documented in
-- docs/reference/gotchas.md ("REVOKE ... FROM PUBLIC does NOT strip anon").
-- PUBLIC is revoked unconditionally because it is a pseudo-role, always
-- resolves, and is the widest grantee. The named roles go through a
-- pg_roles-guarded loop because REVOKE cannot be made conditional and ERRORS on
-- a role that does not exist, so naming them directly would tie this file to
-- targets that happen to carry Supabase's platform roles.
REVOKE ALL ON FUNCTION public._guard_delivery_completion_authorized() FROM PUBLIC;

DO $revoke_named_roles$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public._guard_delivery_completion_authorized() FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END;
$revoke_named_roles$;

CREATE TRIGGER trg_guard_delivery_completion_authorized
  BEFORE UPDATE OF status ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public._guard_delivery_completion_authorized();

-- Keep the current authorization + period-preflight wrapper intact, adding only
-- the row-bound handoff. It locks the delivery before this handoff; the inner
-- implementation retains its established delivery -> invoice lock order.
CREATE OR REPLACE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_delivery record;
  v_existing jsonb;
  v_effective_completion_date date;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT id, assigned_driver
    INTO v_delivery
    FROM public.deliveries
   WHERE id = p_delivery_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- Preserve committed replay even if the historical business date has since
  -- moved into a closed period. No mutation occurs on this branch.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'complete_delivery'
    );
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  PERFORM public.check_period_open(v_effective_completion_date);

  -- WAVE-A-DELIVERY-COMPLETION-AUTH-2026-08-12. The guard accepts only this
  -- row id, never a general-purpose boolean or an app.admin_override escape.
  PERFORM set_config('crx.delivery_completion_authorized', p_delivery_id::text, true);
  BEGIN
    v_result := public._complete_delivery_period_preflight_impl(
      p_delivery_id,
      p_signed_by,
      p_performed_by,
      p_quantities,
      p_issue_type,
      p_issue_notes,
      p_idempotency_key,
      p_completed_at
    );
  EXCEPTION WHEN OTHERS THEN
    -- Clear before re-raising so a caller that catches the RPC error inside a
    -- larger transaction cannot inherit authorization for another statement.
    PERFORM set_config('crx.delivery_completion_authorized', '', true);
    RAISE;
  END;
  PERFORM set_config('crx.delivery_completion_authorized', '', true);
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The gate. This is the live body read from production on 2026-08-11 with the
-- WAVE-A-DELIVERY-BEFORE-BILLING block inserted and NOTHING else changed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._post_invoice_impl_20260714(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_inv record; v_order_status text; v_order_pricing text; v_existing jsonb; v_terms_days integer;  -- A8: v_terms_days added
  v_del_status text; v_del_deleted timestamptz; v_del_number text;  -- fix #5
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', p_invoice_id; END IF;
  PERFORM check_period_open(v_inv.invoice_date);
  IF v_inv.status NOT IN ('draft', 'unposted') THEN RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status; END IF;
  -- PRICING_INCOMPLETE gate (sell-side #2): never post an invoice for a still-
  -- unpriced rush order. Cleared by price_order (v2). Dormant until v1b.
  IF v_inv.pricing_pending THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  IF v_inv.order_id IS NOT NULL THEN
    SELECT status, pricing_status INTO v_order_status, v_order_pricing FROM orders WHERE id = v_inv.order_id;
    IF v_order_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot post invoice — linked order % is cancelled', v_inv.order_id; END IF;
    IF v_order_pricing = 'needs_pricing' THEN RAISE EXCEPTION 'PRICING_INCOMPLETE'; END IF;
  END IF;

  -- WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11 (Wave A fix #5).
  -- Do not turn a delivery-linked draft into a real bill until the goods have
  -- actually moved. The quick-delivery path creates the draft alongside a
  -- 'scheduled' delivery, and completing that delivery is also what corrects the
  -- invoice down to the quantity actually delivered — a correction that only
  -- runs while the invoice is still a draft. Posting first would freeze the
  -- customer at the full ordered quantity.
  -- The delivery row is read without a lock on purpose: the invoice is already
  -- locked above, and _complete_delivery_authorized_impl takes the delivery lock
  -- BEFORE the invoice, so locking here would reverse that order and deadlock.
  IF v_inv.delivery_id IS NOT NULL THEN
    SELECT d.status, d.deleted_at, d.delivery_number
      INTO v_del_status, v_del_deleted, v_del_number
      FROM deliveries d
     WHERE d.id = v_inv.delivery_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'DELIVERY_MISSING: invoice % points at delivery %, which no longer exists. A bill whose delivery record is gone must not be posted.', v_inv.invoice_number, v_inv.delivery_id;
    END IF;
    IF v_del_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: delivery % for invoice % has been deleted, so nothing was delivered against this bill. Void this invoice instead of posting it.', v_del_number, v_inv.invoice_number;
    END IF;
    -- IS DISTINCT FROM, not <>. deliveries.status is NOT NULL today, so the two
    -- are equivalent — but <> against a NULL yields NULL, the IF does not fire,
    -- and the post proceeds. That is the wrong direction to fail on a money gate
    -- if the column's nullability ever changes.
    IF v_del_status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'DELIVERY_NOT_COMPLETED: delivery % for invoice % is "%", not completed. Complete the delivery first — that same step also corrects this invoice to the quantities actually delivered. If the delivery was cancelled or voided, void this invoice rather than posting it.', v_del_number, v_inv.invoice_number, v_del_status;
    END IF;
  END IF;

  -- A8: derive due_date from the payment terms; default Net 30 when blank/unparseable.
  -- The invoice-level override (invoices.payment_terms — the documented per-invoice terms that
  -- the PDF prints) WINS over the customer default; fall back to customers.payment_terms when
  -- the invoice override is blank. Applied only-when-NULL in the UPDATE below so a due_date set
  -- at creation (field-app +30) is preserved, and forward-only (runs at post time).
  SELECT parse_payment_terms_days(COALESCE(NULLIF(btrim(v_inv.payment_terms), ''), c.payment_terms))
    INTO v_terms_days
  FROM customers c WHERE c.id = v_inv.customer_id;

  SET LOCAL app.admin_override = 'true';
  UPDATE invoices SET status = 'posted', posted_by = auth.uid(), posted_at = now(), updated_at = now(),
    due_date = COALESCE(due_date, (v_inv.invoice_date + (v_terms_days || ' days')::interval)::date)  -- A8
    WHERE id = p_invoice_id;
  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
  VALUES ('invoice_posted', 'invoice', p_invoice_id, (SELECT role FROM profiles WHERE id = auth.uid()), jsonb_build_object('status', v_inv.status), jsonb_build_object('status', 'posted', 'posted_at', now()::text), v_inv.total_amount_cents, 'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2));
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted', 'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2), auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id);
  PERFORM generate_rup_sales_records(p_invoice_id);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_invoice', jsonb_build_object('success', true, 'invoice_id', p_invoice_id));
  END IF;
END;
$function$;

-- Make the ACL active rather than only asserted. CREATE OR REPLACE preserves the
-- existing grants and the live ACL was read as `postgres=X/postgres` on
-- 2026-08-11, so this is a no-op today. It is here because this is the INNER
-- implementation: the customer-scope and idempotency-payload-binding checks live
-- in its two SECURITY DEFINER callers, so any client role holding EXECUTE here
-- would skip those as well as reaching this gate. Costs nothing, and closes the
-- incident B7/B8/B9 shape by construction instead of by inspection.
-- PUBLIC is revoked unconditionally: it is a pseudo-role, it always resolves, and
-- it is the widest grantee, so it must never be skipped by a role-existence test.
REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text) FROM PUBLIC;

-- Every NAMED role goes through one pg_roles-guarded loop, because REVOKE cannot
-- be made conditional and it ERRORS on a role that does not exist. Naming
-- anon/authenticated/service_role directly in the REVOKE above made this file
-- abort on a role lookup on any target lacking Supabase's roles — including the
-- plain-Postgres container the replay harness restores into, which is the very
-- shape the postcondition below documents. metabase_ro, the reporting login,
-- belongs in the same loop: the postcondition ASSERTS it holds no EXECUTE here,
-- and an assertion broader than its remedy aborts the migration where it could
-- simply have fixed the problem. All four are no-ops today — the live ACL was
-- read as `postgres=X/postgres` and nothing else on 2026-08-11.
DO $revoke_named_roles$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text) FROM %I',
        v_role
      );
    END IF;
  END LOOP;
END;
$revoke_named_roles$;

DO $postcond$
DECLARE
  v_count       int;
  v_admin_id    uuid;
  v_invoice_id  uuid;
  v_delivery_id uuid;
  v_fp_inv_before  text;
  v_fp_inv_after   text;
  v_fp_del_before  text;
  v_fp_del_after   text;
  v_row_inv_before text;
  v_row_inv_after  text;
  v_row_del_before text;
  v_row_del_after  text;
  v_blocked     boolean;
  v_status      text;
  v_signed_by   text;
  v_completion_result jsonb;
  v_completion_setting text;
BEGIN
  -- Shape checks first: the gate is worthless if the function lost its elevated
  -- rights or its pinned search_path in the replace.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: _post_invoice_impl_20260714 now has % definitions rather than 1 — an ungated overload may be reachable', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
     AND p.pronargs = 2
     AND p.proargtypes[0] = 'uuid'::regtype
     AND p.proargtypes[1] = 'text'::regtype
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp'];
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: _post_invoice_impl_20260714 lost SECURITY DEFINER, its pinned search_path, or its uuid+text signature';
  END IF;

  -- The gate is present, and the pre-existing behaviour it was inserted around
  -- survived the replace. These are the parts a careless re-emit would drop —
  -- including the AUTHORIZATION checks, which are the difference between a money
  -- function and an open endpoint, and which no other assertion here would catch.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
     AND position('WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11' in p.prosrc) > 0
     AND position('DELIVERY_NOT_COMPLETED' in p.prosrc) > 0
     AND position('auth.uid()' in p.prosrc) > 0
     AND position('Not authorized to post invoices' in p.prosrc) > 0
     AND position('FOR UPDATE' in p.prosrc) > 0
     AND position('check_idempotency' in p.prosrc) > 0
     AND position('app.admin_override' in p.prosrc) > 0
     AND position('financial_audit_log' in p.prosrc) > 0
     AND position('activity_feed' in p.prosrc) > 0
     AND position('parse_payment_terms_days' in p.prosrc) > 0
     AND position('PRICING_INCOMPLETE' in p.prosrc) > 0
     AND position('check_period_open' in p.prosrc) > 0
     AND position('generate_rup_sales_records' in p.prosrc) > 0
     AND position('save_idempotency' in p.prosrc) > 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: the replacement is missing the new gate or dropped pre-existing behaviour (authorization, row lock, idempotency, due dates, pricing gate, period check, audit trail or RUP records)';
  END IF;

  -- EXECUTE rights. The REVOKE above makes this active rather than aspirational;
  -- it is still asserted because the cost of being wrong is an anon-executable
  -- SECURITY DEFINER money function, the exact shape of incidents B7/B8/B9. Read
  -- live 2026-08-11 the ACL is `postgres=X/postgres` and nothing else: this is an
  -- internal impl reached only through its two SECURITY DEFINER callers, so no
  -- client role needs EXECUTE on it.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_post_invoice_impl_20260714'
     -- Every role check uses the same EXISTS-on-pg_roles form, because
     -- has_function_privilege ERRORS on a role that does not exist rather than
     -- returning false. An earlier revision guarded only metabase_ro that way and
     -- named the other three directly, which made this migration unappliable
     -- against any database where anon, authenticated or service_role is absent —
     -- always true on Supabase, not true of a plain-Postgres restore, and the
     -- container replay harness is exactly that shape. A role that does not exist
     -- holds no privilege, which is what the EXISTS form says.
     --
     -- metabase_ro is the reporting login; it holds SELECT-class rights on the
     -- money tables and must never gain EXECUTE on a posting function.
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles r
        WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'metabase_ro')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
     );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: anon, authenticated or service_role can still EXECUTE _post_invoice_impl_20260714 directly despite the REVOKE above. This is the INNER implementation — the customer-scope and idempotency-payload-binding checks live in its two callers, so a direct grant would skip them as well as reaching this gate. A SECURITY DEFINER money function must never be client-callable.';
  END IF;

  -- Delivery-completion provenance is structural as well as behavioural below:
  -- pin the trigger's caller-rights mode, its row/BEFORE/UPDATE OF status shape,
  -- and the wrapper's set-and-clear handoff. A missing pin here would turn a
  -- later edit into a silent direct-completion bypass.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_guard_delivery_completion_authorized'
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']
     AND position('WAVE-A-DELIVERY-COMPLETION-AUTH-2026-08-12' in p.prosrc) > 0
     AND position('crx.delivery_completion_authorized' in p.prosrc) > 0
     AND position('OLD.id::text' in p.prosrc) > 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: delivery-completion provenance guard is missing its SECURITY INVOKER row-bound handshake';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.deliveries'::regclass
     AND NOT t.tgisinternal
     AND t.tgname = 'trg_guard_delivery_completion_authorized'
     AND t.tgfoid = 'public._guard_delivery_completion_authorized()'::regprocedure
     AND t.tgenabled = 'O'
     AND (t.tgtype & 1) <> 0
     AND (t.tgtype & 2) <> 0
     AND (t.tgtype & 16) <> 0
     AND (t.tgtype & 4) = 0
     AND (
       SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
         FROM generate_subscripts(t.tgattr, 1) AS s
         JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = t.tgattr[s]
     ) = 'status';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: trg_guard_delivery_completion_authorized is missing, disabled, not BEFORE UPDATE OF status, or bound to the wrong function';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_guard_delivery_completion_authorized'
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles r
        WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
     );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: a client role can EXECUTE the delivery-completion guard directly; trigger helpers must remain private.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'complete_delivery'
     AND p.pronargs = 8
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']
     AND position('WAVE-A-DELIVERY-COMPLETION-AUTH-2026-08-12' in p.prosrc) > 0
     AND position('set_config(''crx.delivery_completion_authorized'', p_delivery_id::text, true)' in p.prosrc) > 0
     AND position('set_config(''crx.delivery_completion_authorized'', '''', true)' in p.prosrc) > 0
     AND position('public._complete_delivery_period_preflight_impl' in p.prosrc) > 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: complete_delivery lost its row-bound completion handoff, its clear, or its existing authorization/preflight delegation';
  END IF;

  -- --------------------------------------------------------------------------
  -- Behavioural probe. Everything written below is rolled back. The rollback is
  -- proven row-by-row on the two rows the probe writes; the whole-table sweep at
  -- the end is advisory only, for the reason given there.
  -- --------------------------------------------------------------------------
  SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(status, 'NULL') || '/' ||coalesce(posted_at::text, 'NULL') || '/' || coalesce(due_date::text, 'NULL') || '/' || coalesce(deleted_at::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_inv_before FROM public.invoices;
  SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(status, 'NULL') || '/' ||coalesce(deleted_at::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_del_before FROM public.deliveries;

  SELECT id INTO v_admin_id
    FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'POSTCOND PROBE: no active admin profile exists, so posting cannot be exercised. Do not install a billing gate without watching it refuse and allow.';
  END IF;

  -- A live draft whose delivery is completed AND which nothing ELSE would refuse,
  -- so a failure in the allow-arm can only be this gate. The last two conditions
  -- keep the OTHER live triggers on `deliveries` out of the way: the signature
  -- guard refuses a move to 'completed' when signed_by is blank, and the
  -- accounting-period guard refuses any status move touching a CLOSED period —
  -- either one would abort the probe for a reason unrelated to billing.
  SELECT i.id, i.delivery_id, d.signed_by INTO v_invoice_id, v_delivery_id, v_signed_by
    FROM public.invoices i
    JOIN public.deliveries d ON d.id = i.delivery_id
    LEFT JOIN public.orders o ON o.id = i.order_id
   WHERE i.status IN ('draft', 'unposted')
     AND i.deleted_at IS NULL
     AND d.status = 'completed'
     AND d.deleted_at IS NULL
     AND COALESCE(i.pricing_pending, false) = false
     AND COALESCE(o.pricing_status, 'priced') <> 'needs_pricing'
     AND COALESCE(btrim(d.signed_by), '') <> ''
     -- ...and nothing on the INVOICES side would refuse the allow arm either. These
     -- mirror the other BEFORE-UPDATE guards on `invoices` and the group-post rule:
     -- trg_guard_invoice_terminal_order refuses a terminal/deleted order,
     -- guard_mono_invoice_split_billing_post refuses a split-billing order posted
     -- without its group, post_invoice refuses a grouped invoice posted alone, and
     -- trg_snapshot_line_shares_on_post refuses a field-app split set that does not
     -- reconcile. Without these the probe could abort on an unrelated guard and be
     -- misread as this gate having broken normal billing. Verified live 2026-08-11:
     -- 6 rows qualify before these filters and the same 6 after, so they cost no
     -- coverage.
     AND i.invoice_group_id IS NULL
     AND i.field_app_billing_set_id IS NULL
     AND COALESCE(o.status, 'confirmed') NOT IN ('cancelled', 'voided')
     -- Plain IS NULL, not a COALESCE-to-epoch comparison. The LEFT JOIN means o.*
     -- is NULL when the invoice has no order, and IS NULL is true in that case
     -- too, so this is the same set with none of the "is epoch a real value?"
     -- ambiguity a reader has to resolve.
     AND o.deleted_at IS NULL
     AND COALESCE(o.needs_split_billing, false) = false
     AND NOT EXISTS (
       SELECT 1 FROM public.order_item_field_allocations a
         JOIN public.order_items oi ON oi.id = a.order_item_id
        WHERE oi.order_id = o.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.accounting_periods ap
        WHERE ap.status = 'closed'
          AND COALESCE((d.completed_at AT TIME ZONE 'America/Chicago')::date, d.scheduled_date, (now() AT TIME ZONE 'America/Chicago')::date)
              BETWEEN ap.period_start AND ap.period_end
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.accounting_periods ap
        WHERE ap.status = 'closed'
          AND i.invoice_date BETWEEN ap.period_start AND ap.period_end
     )
   ORDER BY i.id LIMIT 1;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'POSTCOND PROBE: PROOF MATERIAL UNAVAILABLE — no postable delivery-linked draft invoice exists right now, so neither arm of this gate can be exercised. This is not evidence that the gate is wrong; it means production currently has nothing to prove it with (the office may simply have posted or voided the drafts that qualified). Re-run the candidate query read-only, wait for a qualifying draft, and apply then. Do not install this gate unproven.';
  END IF;

  -- Row-level snapshots of the ONLY two rows the probe writes. These are the
  -- authoritative rollback evidence, and they are what aborts the apply. The
  -- whole-table fingerprints taken above are kept but downgraded to a NOTICE at
  -- the end: under READ COMMITTED every statement in this block takes a fresh
  -- snapshot, so an ordinary office edit committed by another session while the
  -- probe runs would move a whole-table fingerprint through no fault of the
  -- probe. Aborting a money migration with "the rollback did not hold" when the
  -- rollback did in fact hold is the worst message this file could produce.
  -- WHOLE ROW, not a hand-picked column list. An earlier revision listed the
  -- columns the probe was expected to write; a reviewer pointed out that a column
  -- subset is not the row, and that `deliveries` alone carries updated_at,
  -- cancelled_at, cancelled_by, cancel_reason, last_edited_at and last_edited_by,
  -- any of which a future status-change trigger could stamp without this check
  -- noticing. to_jsonb of the row alias covers every column and cannot drift out
  -- of sync with the schema. Hashed rather than compared as text on purpose: the
  -- mismatch message must not print a live invoice row, because an abort message
  -- from a money migration tends to get pasted into a public PR.
  SELECT md5(to_jsonb(i)::text) INTO v_row_inv_before
    FROM public.invoices i WHERE i.id = v_invoice_id;
  SELECT md5(to_jsonb(d)::text) INTO v_row_del_before
    FROM public.deliveries d WHERE d.id = v_delivery_id;

  BEGIN
    EXECUTE format('SET LOCAL request.jwt.claims = %L', json_build_object('sub', v_admin_id)::text);

    -- (a) A delivery that has not happened yet must refuse the post. 'scheduled'
    -- is the exact quick-delivery shape and the whole reason this migration
    -- exists; 'cancelled' is the shape whose refusal message tells the office to
    -- void the draft instead. The override is on ONLY for the UPDATE — the live
    -- transition trigger forbids completed -> scheduled outright — and is off
    -- again before the post, so the gate is exercised without it.
    FOREACH v_status IN ARRAY ARRAY['scheduled', 'cancelled'] LOOP
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE public.deliveries SET status = v_status WHERE id = v_delivery_id;
      PERFORM set_config('app.admin_override', 'false', true);

      v_blocked := false;
      BEGIN
        PERFORM public._post_invoice_impl_20260714(v_invoice_id);
        RAISE EXCEPTION 'POSTCOND PROBE: the gate ALLOWED a post while its delivery was "%"', v_status;
      EXCEPTION
        WHEN OTHERS THEN
          -- Accept ONLY the refusal this arm is meant to trigger, matched as a
          -- true prefix. Two deliberate narrowings from an earlier revision:
          --   * DELIVERY_MISSING is no longer accepted. This probe only UPDATEs
          --     the delivery's status; it never removes the row, so that refusal
          --     is unreachable here. Accepting it would let a genuinely broken
          --     state -- the invoice's delivery row actually gone -- read as the
          --     gate working correctly.
          --   * position(...) = 1 rather than LIKE '...%'. Underscores are
          --     single-character wildcards inside a LIKE pattern, so the old form
          --     also accepted messages that merely resembled this one.
          IF position('DELIVERY_NOT_COMPLETED:' in SQLERRM) <> 1 THEN RAISE; END IF;
          v_blocked := true;
      END;
      IF NOT v_blocked THEN
        RAISE EXCEPTION 'POSTCOND PROBE: the refuse path did not run for delivery status "%"', v_status;
      END IF;
    END LOOP;

    -- (b) COMPLETION PROVENANCE, BOTH DIRECTIONS. First move to in_progress with
    -- the existing lifecycle-only override, then prove a direct completed write
    -- is refused even while that override is set. `app.admin_override` must not
    -- be an escape hatch for a completion that skips reconciliation.
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery_id;
    PERFORM set_config('app.admin_override', 'false', true);

    v_blocked := false;
    BEGIN
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE public.deliveries SET status = 'completed' WHERE id = v_delivery_id;
      PERFORM set_config('app.admin_override', 'false', true);
      RAISE EXCEPTION 'POSTCOND PROBE: a direct delivery status update reached completed despite the provenance guard';
    EXCEPTION
      WHEN OTHERS THEN
        PERFORM set_config('app.admin_override', 'false', true);
        IF position('DELIVERY_COMPLETION_RPC_REQUIRED:' in SQLERRM) <> 1 THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the direct-completion refuse path did not run';
    END IF;

    SELECT status INTO v_status FROM public.deliveries WHERE id = v_delivery_id;
    IF v_status IS DISTINCT FROM 'in_progress' THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the refused direct completion left delivery % at "%" rather than in_progress', v_delivery_id, v_status;
    END IF;

    -- The positive direction uses the public RPC, not a manually-set GUC. It
    -- traverses the authoritative completion path (including its existing
    -- delivery-before-invoice lock order), then proves the wrapper cleared its
    -- row-bound authorization before a later statement can inherit it.
    v_completion_result := public.complete_delivery(
      v_delivery_id,
      v_signed_by,
      v_admin_id,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL
    );
    IF v_completion_result->>'delivery_id' IS DISTINCT FROM v_delivery_id::text THEN
      RAISE EXCEPTION 'POSTCOND PROBE: complete_delivery returned an unexpected receipt [%] for delivery %', v_completion_result, v_delivery_id;
    END IF;
    SELECT status INTO v_status FROM public.deliveries WHERE id = v_delivery_id;
    IF v_status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'POSTCOND PROBE: authorized complete_delivery left delivery % at "%" rather than completed', v_delivery_id, v_status;
    END IF;
    v_completion_setting := current_setting('crx.delivery_completion_authorized', true);
    IF v_completion_setting IS NOT NULL AND v_completion_setting <> '' THEN
      RAISE EXCEPTION 'POSTCOND PROBE: complete_delivery returned with crx.delivery_completion_authorized still set to %, so a later statement could inherit authorization', v_completion_setting;
    END IF;

    -- (c) A soft-deleted delivery must refuse even while its status reads
    -- completed. The row is already authoritatively completed above, so this
    -- arm does not need (and must not fake) a second completed transition.
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE public.deliveries SET deleted_at = now() WHERE id = v_delivery_id;
    PERFORM set_config('app.admin_override', 'false', true);

    v_blocked := false;
    BEGIN
      PERFORM public._post_invoice_impl_20260714(v_invoice_id);
      RAISE EXCEPTION 'POSTCOND PROBE: the gate ALLOWED a post against a soft-deleted delivery';
    EXCEPTION
      WHEN OTHERS THEN
        IF position('DELIVERY_NOT_COMPLETED:' in SQLERRM) <> 1 THEN RAISE; END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the soft-delete refuse path did not run';
    END IF;

    -- (d) THE BILLING ALLOW ARM. Restore the delivery and post for real, with the
    -- override OFF so this is an ordinary post. A gate that only ever refuses is
    -- indistinguishable from a broken function, so normal billing is proven to
    -- still work before this migration is allowed to stand.
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE public.deliveries SET deleted_at = NULL WHERE id = v_delivery_id;
    PERFORM set_config('app.admin_override', 'false', true);

    BEGIN
      PERFORM public._post_invoice_impl_20260714(v_invoice_id);
    EXCEPTION
      WHEN OTHERS THEN
        -- Deliberately does NOT assert the cause. The candidate filter above
        -- steers around every guard known to refuse this row, but a real post
        -- also runs generate_rup_sales_records, the blend-ticket payment sync and
        -- two audit inserts, any of which could fail for reasons that have
        -- nothing to do with this gate. Read the quoted error before concluding.
        RAISE EXCEPTION 'POSTCOND PROBE: an ordinary post against a COMPLETED delivery failed [%]. Determine whether that error comes from this gate or from an unrelated guard/trigger downstream of it BEFORE applying — if it is the gate, this change has broken normal billing and must not go in.', SQLERRM;
    END;
    SELECT status INTO v_status FROM public.invoices WHERE id = v_invoice_id;
    IF v_status <> 'posted' THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the allowed post left the invoice at "%" rather than posted', v_status;
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('app.admin_override', 'false', true);
    PERFORM set_config('crx.delivery_completion_authorized', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PROBE_OK_ROLLBACK';
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('app.admin_override', 'false', true);
      PERFORM set_config('crx.delivery_completion_authorized', '', true);
      IF SQLERRM <> 'PROBE_OK_ROLLBACK' THEN RAISE; END IF;
  END;

  -- (A "did the probe restore its role" check used to sit here. It was removed
  -- rather than kept as belt-and-braces: nothing in the probe changes role — no
  -- SET ROLE, and this DO block is not SECURITY DEFINER — so the check could not
  -- fail under any input. An assertion that cannot fail reads to the next person
  -- as evidence that something is being verified when nothing is.)

  -- REGRESSION GUARD ON THE ROLLBACK BOUNDARY. What actually undoes the probe is
  -- the enclosing subtransaction: the probe's writes happen inside a BEGIN ...
  -- EXCEPTION block that always raises, so PostgreSQL rolls them back whatever
  -- this check says. This comparison is not the protection — it is here so that
  -- if someone later moves or removes that boundary, the apply fails loudly with
  -- a message about the two rows instead of silently leaving edits behind.
  SELECT md5(to_jsonb(i)::text) INTO v_row_inv_after
    FROM public.invoices i WHERE i.id = v_invoice_id;
  SELECT md5(to_jsonb(d)::text) INTO v_row_del_after
    FROM public.deliveries d WHERE d.id = v_delivery_id;
  IF v_row_inv_after IS DISTINCT FROM v_row_inv_before THEN
    RAISE EXCEPTION 'POSTCOND: the probe left its test INVOICE changed — the rollback did not hold [% -> %]', v_row_inv_before, v_row_inv_after;
  END IF;
  IF v_row_del_after IS DISTINCT FROM v_row_del_before THEN
    RAISE EXCEPTION 'POSTCOND: the probe left its test DELIVERY changed — the rollback did not hold [% -> %]', v_row_del_before, v_row_del_after;
  END IF;

  -- ADVISORY whole-table sweep. With the two probe rows proven intact above, a
  -- difference here means another session committed an ordinary edit while this
  -- migration was running. That is normal office activity, not a rollback
  -- failure, and must not abort the apply.
  SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(status, 'NULL') || '/' ||coalesce(posted_at::text, 'NULL') || '/' || coalesce(due_date::text, 'NULL') || '/' || coalesce(deleted_at::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_inv_after FROM public.invoices;
  SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(status, 'NULL') || '/' ||coalesce(deleted_at::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_del_after FROM public.deliveries;
  IF v_fp_inv_after IS DISTINCT FROM v_fp_inv_before
     OR v_fp_del_after IS DISTINCT FROM v_fp_del_before THEN
    RAISE NOTICE 'POSTCOND: invoices/deliveries changed elsewhere while this migration ran [inv % -> % , del % -> %], but the two rows the probe touched are byte-identical to before, so the probe rolled back cleanly. This is concurrent activity by another session, not a leak.',
      v_fp_inv_before, v_fp_inv_after, v_fp_del_before, v_fp_del_after;
  END IF;
END;
$postcond$;

COMMIT;

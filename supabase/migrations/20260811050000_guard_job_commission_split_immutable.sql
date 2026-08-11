-- 20260811050000_guard_job_commission_split_immutable.sql
-- STATUS: PARKED DRAFT - NOT APPLIED
--
-- Wave A fix #4 of the 2026-08-09 ordering-cycle review.
-- Finding: "[MED] jobs.commission_split is directly writable by any admin/sales_rep
-- with no validation, no audit, and no lock".
--
-- PLAIN ENGLISH
-- A job carries a "commission split" — the record of who gets paid what share of
-- that job's profit. The commission rows themselves are only created later, when
-- the job is invoiced, and they are minted from whatever this column says at that
-- moment.
--
-- Today the column is wide open. The row-level security policy on `jobs` lets ANY
-- active admin or sales rep UPDATE ANY job row, with no ownership check at all.
-- Nothing validates a change to the split, nothing records it, and there is no
-- button in the app that writes it — so the only way to change it is to bypass the
-- app and talk to the database directly. A rep who did that could point a
-- colleague's job at themselves, and when the job was invoiced the money would be
-- minted to the new name with no trace that it ever changed. The equivalent attack
-- is structurally impossible on the quote channel, because `quotes_update` IS
-- ownership-scoped for reps.
--
-- The window does not close at invoicing either: `enforce_billed_job_immutability`
-- compares an explicit list of named columns, and `commission_split` was added
-- after that list was written, so it is simply never compared. Voiding an invoice
-- returns the job to `completed` and re-invoicing re-mints from the column, so a
-- split rewritten on an invoiced job is not inert.
--
-- WHICH JOBS ACTUALLY CARRY A VALUE, because the rest of this file depends on it
-- and an earlier draft of this header got it wrong. A NULL split is NOT a rare
-- legacy leftover. `jobs_snapshot_commission_split` fills the column on INSERT only
-- when `quote_id IS NULL`, so every job created from a quote — the primary
-- scheduling path — is inserted with a NULL split and STAYS NULL until invoicing.
-- Two consequences, both stated plainly because they change what this guard buys:
--   * For quote-derived jobs the freeze does not bite until invoicing, and the
--     value it then freezes is read from the parent quote's split or the customer
--     default. The real control surface for those jobs is the ownership scoping on
--     `save_quote` / `save_customer`, not this trigger. This guard makes an upstream
--     mistake there permanent rather than preventing it.
--   * The NULL-fill allowance below is therefore on the live invoicing path for
--     most jobs, not a corner case — which is why its preconditions are asserted
--     against the catalog rather than trusted.
--
-- WHAT THIS CHANGES
-- After this migration a job's commission split is FROZEN once it has a value.
-- Three writes are still allowed:
--   1. the INSERT that first snapshots the split when the job is created
--      (unchanged — this trigger is UPDATE-only);
--   2. filling the column when it is still NULL, AND the write is arriving as the
--      owner of the `jobs` table rather than from a browser session — which is what
--      `transfer_job_to_invoice` and `_save_field_app_split_invoice_impl` do via
--      `COALESCE(commission_split, ...)` at invoicing time;
--   3. a rewrite that does not actually change the value.
-- Anything else is refused with JOB_COMMISSION_SPLIT_IMMUTABLE.
--
-- WHY (2) CARRIES A CALLER CHECK. An earlier draft allowed ANY caller to fill a
-- NULL split. That left the original attack wide open — and, given the paragraph
-- above, open on most jobs rather than a few legacy ones — and worse, this guard
-- would then FREEZE the forgery in place. The two legitimate writers are both
-- SECURITY DEFINER owned by the `jobs` table owner (`postgres`; verified live
-- 2026-08-11 and asserted in the precondition), so inside them `current_user` is
-- that owner, while a PostgREST row update runs as `anon`, `authenticated`, or
-- `service_role`. `current_user` is not client-settable — an `authenticated`
-- session cannot SET ROLE to the owner — so this is a caller identity check, not a
-- bypass flag.
--
-- THE CHECK IS AN ALLOWLIST, DELIBERATELY. Naming the three Supabase API roles and
-- refusing them would fail OPEN for any role nobody thought to list: a custom role
-- added for a later feature, a Studio SQL-editor session, `dashboard_user`. The
-- guard instead requires the caller to BE the table owner and refuses everything
-- else, so a role added in future is denied by default rather than admitted by
-- omission.
--
-- WHY (3) IS SAFE, since it delegates. An unchanged rewrite is waved through, and
-- `trg_stamp_commission_split_recipient_ids` then re-resolves each recipient with
-- name-beats-stored-id precedence. On its own that would let a legacy id-less split
-- be re-pointed by renaming a profile. What actually stops that is the separate
-- recipient-name-acquisition guard (`_guard_recipient_name_reuse` on `profiles`).
-- This guard's safety therefore depends on that one, so the precondition asserts it
-- is installed and enabled rather than assuming it.
--
-- DELIBERATELY NO ESCAPE HATCH. There is no "authorized" session setting that
-- turns this off. A settable bypass flag is a bypass, and nothing in the product
-- needs one today: `grep commission_split src/` shows the frontend only ever
-- writes `customers.default_commission_split` and quote splits, never
-- `jobs.commission_split`. If a genuine "change this job's split" feature is
-- wanted later it must arrive as its own RPC with its own validation and its own
-- `financial_audit_log` row — which is the point of freezing it now.
--
-- THE SANCTIONED REPAIR PATH, so nobody invents a GUC when the first backfill is
-- needed. A data repair — the shape of `20260722174029_commission_split_recipient_ids.sql`,
-- which rewrote every non-NULL split to enrich recipient ids, and which this guard
-- WOULD have refused — must be written as its own reviewed migration that wraps the
-- repair in:
--     ALTER TABLE public.jobs DISABLE TRIGGER trg_guard_job_commission_split_immutable;
--     ... the repair ...
--     ALTER TABLE public.jobs ENABLE  TRIGGER trg_guard_job_commission_split_immutable;
-- That is owner-only, unreachable from any Supabase API role, and visible in the
-- diff. It is the intended hatch precisely because it cannot be pulled at runtime.
--
-- OPERATIONAL TRADE-OFF FOR MASON. The sibling guard `_enforce_billed_job_immutability`
-- deliberately exempts admins so they can correct billed history. This one does not.
-- After it applies, a wrong commission split on a job cannot be corrected by anyone
-- through the app or the database console — only by the reviewed-migration path
-- above. That is the point (it forces an audited trail on a money field), but it is
-- a real capability removal and should be an explicit decision, not a side effect.
--
-- TRIGGER ORDER MATTERS. Postgres fires same-timing triggers in NAME order. The
-- existing `trg_stamp_commission_split_recipient_ids` rewrites NEW.commission_split
-- to enrich recipient names into user ids. This guard is named `trg_guard_...` so
-- it sorts BEFORE `trg_stamp_...` and therefore compares the CALLER'S OWN value
-- against the stored one. If it ran after the stamper, a job whose stored split
-- predates the stamper (and so carries no ids) would fail an honest no-op rewrite,
-- because the stamper would have enriched NEW but not OLD. The precondition proves
-- this ordering by reading the competing trigger set out of `pg_trigger`, not by
-- comparing two string constants — a literal-vs-literal test is a tautology, and
-- this ordering is the migration's central safety claim.
--
-- WHY REVOKING EXECUTE ON THE GUARD CANNOT BREAK ORDINARY SAVES. Postgres checks
-- EXECUTE on a trigger function at CREATE TRIGGER time, not each time the trigger
-- fires, so revoking it from the API roles does not affect any write they make.
-- Verified live 2026-08-11 as well as reasoned: 40 existing production triggers
-- already run with EXECUTE revoked from `authenticated` on tables the browser
-- writes daily. Independently, the trigger is scoped `UPDATE OF commission_split`
-- and `save_job` — the only job-save path the app uses — does not write that column
-- at all, so an ordinary save never reaches this guard. The precondition asserts
-- that too.
--
-- NO LIVE MONEY MOVES. This migration adds a function and a trigger. It writes no
-- business rows. The postcondition's behavioural probe runs inside a subtransaction
-- that is deliberately rolled back, and the rollback is then PROVEN rather than
-- assumed: every commission split on the table is hashed in id order before and
-- after the probe, and the two hashes must match.

SET statement_timeout = '60s';
SET lock_timeout = '10s';

DO $precond$
DECLARE
  v_count int;
  v_src text;
  v_owner text;
BEGIN
  -- This migration must be applied by the database owner, not by an API role.
  -- The postcondition probe fills a NULL split to prove the invoicing path still
  -- works, and the guard's caller check refuses that write from anyone who is not
  -- the table owner — so applying as another role would abort on a false alarm.
  SELECT r.rolname INTO v_owner
    FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
   WHERE c.oid = 'public.jobs'::regclass;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'PRECOND: could not determine the owner of public.jobs';
  END IF;
  IF current_user <> v_owner THEN
    RAISE EXCEPTION 'PRECOND: apply this migration as %, the owner of public.jobs, not as %', v_owner, current_user;
  END IF;

  -- The column this migration protects must exist and be jsonb.
  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'jobs'
     AND column_name = 'commission_split' AND data_type = 'jsonb';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: public.jobs.commission_split is not a single jsonb column [found %]', v_count;
  END IF;

  -- The stamper must still exist, because this guard's name was chosen to sort
  -- ahead of it. If it were renamed or dropped, re-derive the ordering argument
  -- in the header before applying.
  SELECT count(*) INTO v_count
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.jobs'::regclass
     AND NOT t.tgisinternal
     AND t.tgname = 'trg_stamp_commission_split_recipient_ids';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PRECOND: trg_stamp_commission_split_recipient_ids is missing from public.jobs. The trigger-order reasoning behind this guard depends on it — re-derive before applying.';
  END IF;

  -- THE ORDERING PROOF ITSELF, read from the catalog. Any BEFORE-ROW-UPDATE trigger
  -- on jobs whose function assigns NEW.commission_split must sort strictly AFTER
  -- this guard; one sorting before or between could overwrite the approved value
  -- after the check, which is a complete bypass with no error.
  -- tgname is type `name`, so the comparison below already uses the C collation
  -- that the executor orders by, not the database collation.
  -- Match both assignment forms: jobs_snapshot_commission_split uses BOTH
  -- `NEW.commission_split :=` and `... INTO NEW.commission_split`, which proves the
  -- SELECT..INTO form is in live use in this codebase and must not be missed.
  SELECT string_agg(t.tgname, ', ' ORDER BY t.tgname) INTO v_src
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.jobs'::regclass
     AND NOT t.tgisinternal
     AND (t.tgtype & 1) <> 0      -- FOR EACH ROW
     AND (t.tgtype & 2) <> 0      -- BEFORE
     AND (t.tgtype & 16) <> 0     -- ... ON UPDATE
     AND t.tgname <> 'trg_guard_job_commission_split_immutable'
     AND (p.prosrc ~* 'NEW\s*\.\s*commission_split\s*:='
       OR p.prosrc ~* 'into\s+NEW\s*\.\s*commission_split')
     AND NOT (t.tgname > 'trg_guard_job_commission_split_immutable'::name);
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION 'PRECOND: these BEFORE UPDATE trigger[s] on public.jobs assign NEW.commission_split and do NOT sort after the guard, so they could overwrite the approved value: %. Re-derive the trigger-order argument before applying.', v_src;
  END IF;

  -- The no-op-rewrite allowance delegates to the stamper, whose name-beats-id
  -- resolution is only safe because a separate guard forbids acquiring a profile
  -- name that a commission split already references. Assert that guard is live.
  SELECT count(*) INTO v_count
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal
     AND p.proname = '_guard_recipient_name_reuse'
     AND t.tgenabled <> 'D';
  IF v_count < 1 THEN
    RAISE EXCEPTION 'PRECOND: the recipient-name-acquisition guard _guard_recipient_name_reuse is not installed or is disabled. The unchanged-rewrite allowance depends on it — re-derive before applying.';
  END IF;

  -- The app's own job-save RPC must not write this column. If it ever did, every
  -- ordinary job save would start hitting this guard and be refused.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_job'
     AND p.prosrc ~* '\mcommission_split\s*=';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND: save_job now assigns commission_split. This guard would refuse ordinary job saves — review before applying.';
  END IF;

  -- New-style SQL-standard function bodies (BEGIN ATOMIC) are stored in
  -- pg_proc.prosqlbody, not prosrc, so every prosrc regex in this file is blind to
  -- them. Nothing in `public` uses that form today (verified live 2026-08-11);
  -- assert it, rather than let a future writer become invisible to these checks.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosqlbody IS NOT NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND: % function[s] in public use a SQL-standard body, which the writer detection below cannot read. Re-derive the writer list before applying.', v_count;
  END IF;

  -- THE LOAD-BEARING COMPATIBILITY CLAIM. The only two live functions that write
  -- jobs.commission_split on UPDATE must both do it through COALESCE, i.e. they
  -- only ever FILL a NULL. That is what makes the "OLD IS NULL" allowance below
  -- sufficient, and it is asserted rather than trusted.
  -- The pattern anchors on the SET clause, so a statement that merely READS the
  -- column in a WHERE clause is not miscounted as a writer. It also tolerates
  -- `UPDATE ONLY jobs` and the `%I`/`%s` of dynamic SQL. The remaining known blind
  -- spot is a `;` inside a string literal earlier in the SET list, which would
  -- truncate the `[^;]*` span; there is no such writer today.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~* 'UPDATE\s+(ONLY\s+)?[a-z_."%]*\mjobs\M[^;]*\mset\M[^;]*\mcommission_split\s*=';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'PRECOND: expected exactly 2 functions that write to the jobs.commission_split column, found %. A third writer would be refused by this guard — review it before applying.', v_count;
  END IF;

  FOR v_src IN
    SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~* 'UPDATE\s+(ONLY\s+)?[a-z_."%]*\mjobs\M[^;]*\mset\M[^;]*\mcommission_split\s*='
  LOOP
    IF v_src NOT IN ('transfer_job_to_invoice', '_save_field_app_split_invoice_impl') THEN
      RAISE EXCEPTION 'PRECOND: unexpected writer of jobs.commission_split: %', v_src;
    END IF;
  END LOOP;

  -- regexp_matches with no capture group returns the whole match as element 1.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL regexp_matches(p.prosrc, 'UPDATE\s+(ONLY\s+)?[a-z_."%]*\mjobs\M[^;]*\mset\M[^;]*\mcommission_split\s*=[^;]*;', 'gi') AS m
   WHERE n.nspname = 'public'
     AND p.proname IN ('transfer_job_to_invoice', '_save_field_app_split_invoice_impl')
     AND m[1] !~* 'commission_split\s*=\s*COALESCE\s*\(\s*commission_split';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'PRECOND: % statement[s] write jobs.commission_split WITHOUT the fill-only COALESCE pattern. This guard would break that path — review it before applying.', v_count;
  END IF;

  -- THE OTHER LOAD-BEARING CLAIM, previously asserted only in prose. The NULL-fill
  -- allowance works because inside those two writers `current_user` is the jobs
  -- table owner rather than an API role — which is true only while they are
  -- SECURITY DEFINER owned by that role. CREATE OR REPLACE silently resets a
  -- function to SECURITY INVOKER when the clause is omitted, and
  -- transfer_job_to_invoice has been re-emitted several times, so this is a live
  -- footgun: one careless re-emit and invoicing starts failing with an error that
  -- blames the browser session.
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname IN ('transfer_job_to_invoice', '_save_field_app_split_invoice_impl')
     AND p.prosecdef
     AND r.rolname = v_owner;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'PRECOND: expected both commission_split writers to be SECURITY DEFINER owned by %, found % that are. Applying anyway would break invoicing.', v_owner, v_count;
  END IF;

  -- Idempotent re-run.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_guard_job_commission_split_immutable'
     AND position('WAVE-A-JOBSPLIT-FREEZE-2026-08-09' in p.prosrc) > 0;
  IF v_count > 0 THEN
    RAISE NOTICE 'PRECOND: the job commission-split freeze is already installed — re-applying is a no-op';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public._guard_job_commission_split_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner text;
BEGIN
  -- WAVE-A-JOBSPLIT-FREEZE-2026-08-09 (this token is asserted by the migration's
  -- pre/postconditions — do not rename it without updating them).
  --
  -- Attached BEFORE UPDATE OF commission_split, so it does not run on INSERT and
  -- does not run on updates that leave the column out of the SET list.
  --
  -- Named to sort ahead of trg_stamp_commission_split_recipient_ids, so NEW here
  -- is the caller's own value, not the stamper's enriched rewrite.

  -- A rewrite that changes nothing is not a change. The stamper runs after this
  -- and re-resolves recipients; that is safe because _guard_recipient_name_reuse
  -- forbids acquiring a referenced name (asserted in the migration precondition).
  IF NEW.commission_split IS NOT DISTINCT FROM OLD.commission_split THEN
    RETURN NEW;
  END IF;

  -- Filling a NULL is the invoicing snapshot: transfer_job_to_invoice and
  -- _save_field_app_split_invoice_impl both write
  -- COALESCE(commission_split, <resolved>, '{"splits":[]}'), which only ever
  -- lands when the column is still NULL. Asserted in the precondition.
  --
  -- The caller check is what stops this branch from being the original hole. It is
  -- an ALLOWLIST: both writers are SECURITY DEFINER owned by the jobs table owner,
  -- so inside them current_user IS that owner. Everything else — the three Supabase
  -- API roles today, and any role added later that nobody thought to enumerate — is
  -- refused by default. Without this, a rep could fill a NULL split with their own
  -- name and this guard would then freeze that forgery permanently.
  IF OLD.commission_split IS NULL THEN
    SELECT r.rolname INTO v_owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
     WHERE c.oid = 'public.jobs'::regclass;
    IF current_user IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'JOB_COMMISSION_SPLIT_IMMUTABLE: job %''s commission split may only be filled by the invoicing path, not by a direct row update [caller role %, required %].', OLD.id, current_user, v_owner
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'JOB_COMMISSION_SPLIT_IMMUTABLE: job %''s commission split is locked once set. It decides who gets paid, no application path writes it after scheduling, and a direct change leaves no audit trail. Change it through a purpose-built RPC with validation and a financial_audit_log entry, not a raw row update.', OLD.id
    USING ERRCODE = 'P0001';
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_job_commission_split_immutable() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_job_commission_split_immutable ON public.jobs;
CREATE TRIGGER trg_guard_job_commission_split_immutable
  BEFORE UPDATE OF commission_split ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public._guard_job_commission_split_immutable();

DO $postcond$
DECLARE
  v_count int;
  v_src text;
  v_config text[];
  v_secdef boolean;
  v_unexpected text;
  v_enabled "char";
  v_cols text;
  v_timing text;
  v_job_id uuid;
  v_null_job_id uuid;
  v_blocked boolean := false;
  v_fp_before text;
  v_fp_after text;
  v_applier text;
BEGIN
  -- --------------------------------------------------------------------------
  -- Structural proofs.
  --
  -- Honest framing: most of the checks in this section re-read from the catalog
  -- what the DDL above wrote as literals a few lines earlier, so they pass whether
  -- or not the guard BEHAVES correctly. They are cheap tripwires against a botched
  -- edit, not behavioural proof. The two that can genuinely fail on a correct-
  -- looking file are the EXECUTE-privilege check and, further down, the residue
  -- fingerprint. The behavioural proof is the probe section.
  -- --------------------------------------------------------------------------
  SELECT p.prosrc, p.proconfig, p.prosecdef INTO v_src, v_config, v_secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_guard_job_commission_split_immutable';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POSTCOND: public._guard_job_commission_split_immutable was not created';
  END IF;
  IF position('WAVE-A-JOBSPLIT-FREEZE-2026-08-09' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCOND: the guard function does not carry its marker';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'POSTCOND: the guard function has no pinned search_path [got %]', v_config;
  END IF;
  IF v_secdef THEN
    RAISE EXCEPTION 'POSTCOND: the guard function must be SECURITY INVOKER — a SECURITY DEFINER trigger would evaluate under the owner rather than the caller, which would defeat the caller check entirely';
  END IF;

  -- Tripwire only: a zero-argument signature cannot be overloaded, so under the
  -- CREATE OR REPLACE above this count can only be 1. It exists to catch a future
  -- edit that gives the function a parameter and accidentally leaves both versions.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_guard_job_commission_split_immutable';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: expected exactly 1 _guard_job_commission_split_immutable, found % — an overload was created instead of a replacement', v_count;
  END IF;

  SELECT string_agg(g, ', ') INTO v_unexpected
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         unnest(ARRAY['anon', 'authenticated', 'public', 'service_role']) AS g
   WHERE n.nspname = 'public'
     AND p.proname = '_guard_job_commission_split_immutable'
     AND has_function_privilege(g, p.oid, 'EXECUTE');
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCOND: EXECUTE on the guard function is still held by: %', v_unexpected;
  END IF;

  -- The trigger must be BEFORE UPDATE, enabled, and scoped to exactly the one
  -- column. A missing column list would fire it on every job update; a wrong
  -- timing would let the write land before the check.
  SELECT CASE WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END,
         t.tgenabled,
         (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
            FROM generate_subscripts(t.tgattr, 1) AS s
            JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = t.tgattr[s])
    INTO v_timing, v_enabled, v_cols
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.jobs'::regclass
     AND NOT t.tgisinternal
     AND t.tgname = 'trg_guard_job_commission_split_immutable';
  IF v_timing IS NULL THEN
    RAISE EXCEPTION 'POSTCOND: trg_guard_job_commission_split_immutable was not created on public.jobs';
  END IF;
  IF v_timing <> 'BEFORE' THEN
    RAISE EXCEPTION 'POSTCOND: the guard trigger is % rather than BEFORE', v_timing;
  END IF;
  IF v_enabled <> 'O' THEN
    RAISE EXCEPTION 'POSTCOND: the guard trigger is not enabled [tgenabled=%]', v_enabled;
  END IF;
  IF v_cols IS DISTINCT FROM 'commission_split' THEN
    RAISE EXCEPTION 'POSTCOND: the guard trigger fires on columns [%] rather than commission_split alone', v_cols;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.jobs'::regclass
     AND NOT t.tgisinternal
     AND (t.tgtype & 4) <> 0
     AND t.tgname = 'trg_guard_job_commission_split_immutable';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'POSTCOND: the guard trigger also fires on INSERT — the first snapshot must stay allowed';
  END IF;

  -- Re-prove the ordering claim now that the guard trigger actually exists, so the
  -- proof covers the trigger that was created rather than a name in a literal.
  SELECT string_agg(t.tgname, ', ' ORDER BY t.tgname) INTO v_src
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.jobs'::regclass
     AND NOT t.tgisinternal
     AND (t.tgtype & 1) <> 0
     AND (t.tgtype & 2) <> 0
     AND (t.tgtype & 16) <> 0
     AND t.tgname <> 'trg_guard_job_commission_split_immutable'
     AND (p.prosrc ~* 'NEW\s*\.\s*commission_split\s*:='
       OR p.prosrc ~* 'into\s+NEW\s*\.\s*commission_split')
     AND NOT (t.tgname > 'trg_guard_job_commission_split_immutable'::name);
  IF v_src IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCOND: these BEFORE UPDATE trigger[s] assign NEW.commission_split and do not sort after the guard: %', v_src;
  END IF;

  -- --------------------------------------------------------------------------
  -- Behavioural probe. Everything written below is rolled back, and the rollback
  -- is proven by the fingerprint comparison at the end.
  -- --------------------------------------------------------------------------
  -- Capture the role actually in effect, so the probe restores THAT rather than
  -- using RESET ROLE — which drops to the session login role and would run the
  -- owner-fill probe under the wrong identity if the applier had already SET ROLE.
  v_applier := current_user;

  -- Fingerprint every commission split on the table before touching anything, so
  -- the residue check below proves the whole column is byte-for-byte unchanged.
  -- Searching for a sentinel string would be vacuous: the sentinel only appears
  -- in writes the guard is expected to REFUSE, so its absence proves nothing.
  SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(commission_split::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_before
    FROM public.jobs;

  SELECT id INTO v_job_id FROM public.jobs WHERE commission_split IS NOT NULL ORDER BY id LIMIT 1;
  SELECT id INTO v_null_job_id FROM public.jobs WHERE commission_split IS NULL ORDER BY id LIMIT 1;

  -- Both row shapes must exist or the proof is incomplete. A money guard does not
  -- get installed on the strength of a skipped test, so this is a hard failure
  -- rather than a notice.
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'POSTCOND PROBE: no job row carries a commission split, so the refuse path cannot be exercised here. Do not install this guard without watching it refuse a write.';
  END IF;
  IF v_null_job_id IS NULL THEN
    RAISE EXCEPTION 'POSTCOND PROBE: every job row already carries a commission split, so the invoicing fill path cannot be exercised here. Do not install this guard without watching the invoicing path still succeed.';
  END IF;

  BEGIN
    -- (a) a rewrite of an already-set split must be refused, even for the owner
    BEGIN
      UPDATE public.jobs
         SET commission_split = '{"splits":[{"recipient":"__PROBE_DO_NOT_KEEP__","percentage":100}]}'::jsonb
       WHERE id = v_job_id;
      RAISE EXCEPTION 'POSTCOND PROBE: the guard did NOT refuse a direct commission-split rewrite';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'JOB_COMMISSION_SPLIT_IMMUTABLE%' THEN
          RAISE;
        END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the refuse path did not run';
    END IF;

    -- (b) a no-op rewrite must still be allowed. This one re-fires the stamper,
    -- which fails closed if a stored recipient name no longer resolves to a
    -- profile — so translate that into a message that names the real cause rather
    -- than letting it surface as an unexplained guard failure.
    BEGIN
      UPDATE public.jobs SET commission_split = commission_split WHERE id = v_job_id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'POSTCOND PROBE: a no-op rewrite of job % failed [%]. If this is a recipient-resolution error it is the stamper failing closed on stale data in that row, not this guard — fix the row, then re-apply.', v_job_id, SQLERRM;
    END;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'POSTCOND PROBE: a no-op commission-split rewrite touched % rows rather than 1', v_count;
    END IF;

    -- (c) a non-owner filling a NULL split must be refused. This is the caller
    -- check, and it is the difference between this guard closing the hole and
    -- merely narrowing it to rows that have not been invoiced yet. service_role is
    -- used because it is a real Supabase API role that reaches the table without
    -- needing JWT claims; the guard refuses it before RLS is even relevant.
    v_blocked := false;
    BEGIN
      SET LOCAL ROLE service_role;
      UPDATE public.jobs
         SET commission_split = '{"splits":[{"recipient":"__PROBE_DO_NOT_KEEP__","percentage":100}]}'::jsonb
       WHERE id = v_null_job_id;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      EXECUTE format('SET LOCAL ROLE %I', v_applier);
      RAISE EXCEPTION 'POSTCOND PROBE: the guard did NOT refuse an API-role fill of a NULL commission split [% row[s] written]', v_count;
    EXCEPTION
      WHEN OTHERS THEN
        EXECUTE format('SET LOCAL ROLE %I', v_applier);
        IF SQLERRM NOT LIKE 'JOB_COMMISSION_SPLIT_IMMUTABLE%' THEN
          RAISE;
        END IF;
        v_blocked := true;
    END;
    IF NOT v_blocked THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the API-role refuse path did not run';
    END IF;

    -- Belt and braces: prove the role really was restored before the owner-only
    -- probe below runs, so a silent SET LOCAL failure cannot turn (d) into a false
    -- alarm about the invoicing path.
    IF current_user <> v_applier THEN
      RAISE EXCEPTION 'POSTCOND PROBE: the probe failed to restore role % [now %]', v_applier, current_user;
    END IF;

    -- (d) the invoicing path — an owner-level fill of a NULL — must still be allowed
    UPDATE public.jobs SET commission_split = '{"splits":[]}'::jsonb WHERE id = v_null_job_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'POSTCOND PROBE: filling a NULL commission split touched % rows rather than 1', v_count;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'PROBE_OK_ROLLBACK';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_OK_ROLLBACK' THEN
        RAISE;
      END IF;
  END;

  -- Prove the probe left nothing behind: every split on the table, in id order,
  -- must hash to exactly what it hashed to before the probe ran.
  SELECT md5(coalesce(string_agg(id::text || '=' || coalesce(commission_split::text, 'NULL'), '|' ORDER BY id), 'EMPTY'))
    INTO v_fp_after
    FROM public.jobs;
  IF v_fp_after IS DISTINCT FROM v_fp_before THEN
    RAISE EXCEPTION 'POSTCOND: the probe changed live commission splits — the rollback did not hold [% -> %]', v_fp_before, v_fp_after;
  END IF;
END;
$postcond$;

RESET statement_timeout;
RESET lock_timeout;

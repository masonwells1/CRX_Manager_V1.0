-- PARKED-005 — codex-driven-bug-hunt cycle 3, finding #3 (MED, design completion).
-- dedupeKey: job-billing-bridge:billed_job_immutability:child_tables_uncovered
--
-- CONTEXT
-- Migration 20260625190000 added _enforce_billed_job_immutability() and wired it to
-- the jobs table BEFORE UPDATE — for a non-admin without the override hatch, an
-- 'invoiced' or 'cancelled' job's billed-relevant columns cannot be rewritten and
-- a soft-delete (deleted_at NULL→non-NULL) is blocked. That migration's header
-- explicitly EXEMPTS jobs.applied_acres from the lock because "as-applied legal
-- detail can legitimately be RECORDED after a job is invoiced".
--
-- WHAT THE EXEMPTION DOES AND DOESN'T ALLOW
-- The exemption authorizes RECORDING new applied detail post-billing (recompute
-- trigger writes jobs.applied_acres after a new job_applied_record arrives). It
-- does NOT explicitly authorize REWRITING or DELETING existing applied-record
-- rows on a billed job — but the current schema allows exactly that:
--   * job_applied_records UPDATE / DELETE for billed jobs is unguarded
--   * job_applied_record_fields UPDATE / DELETE is unguarded
--   * job_applied_record_crew  UPDATE / DELETE is unguarded
-- A non-admin sales_rep/applicator can therefore mutate or delete the legal
-- as-applied record of a BILLED job via raw REST/psql or via the existing
-- save_job_applied_record RPC (SECURITY INVOKER, edit-path WHERE id=... succeeds
-- because RLS doesn't check job billing status). The save_job_applied_record path
-- always does DELETE+INSERT on child tables, so editing one record's field set
-- silently rewrites compliance-record history without tripping any guard.
--
-- WHY MED, NOT HIGH
-- Practical impact today is zero (0 job_applied_records live as of 2026-06-30).
-- HIGH parallels exist (PARKED-001, PARKED-003) but they touched the financial
-- ledger directly; this guard misses compliance/audit data, not money. Upgrade
-- to HIGH the moment field-app applied records go live.
--
-- THE FIX (minimal, design-respecting)
-- Add a BEFORE UPDATE OR DELETE trigger function _enforce_billed_job_applied_record_immutability()
-- that for a non-admin without the override hatch raises if the PARENT job's
-- status is 'invoiced' or 'cancelled'. Wire it to all three child tables.
-- INSERT is intentionally NOT covered — the original migration's exempt clause
-- authorizes RECORDING after billing, and the parent table's existing RLS WITH
-- CHECK already gates which rows can be inserted (admin/sales/own-applicator).
-- Same shape and ergonomics as the sibling _enforce_billed_job_immutability:
-- not SECURITY DEFINER (constraint-style trigger; sees the caller's is_admin()
-- / _is_admin_override() under their own auth context), search_path pinned.
--
-- ROLLED-BACK VALIDATION
-- Create the function + triggers in a transaction; verify (a) the function exists
-- with the expected gate text; (b) each trigger is attached BEFORE UPDATE OR DELETE
-- on each of the three child tables. ROLLBACK.
--
-- PARKED: do NOT apply without Mason's explicit OK.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._enforce_billed_job_applied_record_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent_record_id uuid;
  v_job_status text;
  v_job_number text;
  v_parent_xmin xid;
BEGIN
  -- Resolve the parent job's status + (for child tables) parent record's xmin.
  -- For the parent table (job_applied_records), OLD.job_id (UPDATE/DELETE) or
  -- NEW.job_id (INSERT — not gated here) points to the job. For child tables
  -- (_fields, _crew), walk via application_record_id → job_applied_records → jobs.
  IF TG_TABLE_NAME = 'job_applied_records' THEN
    SELECT status, job_number INTO v_job_status, v_job_number
      FROM public.jobs WHERE id = OLD.job_id;
  ELSE
    -- For child tables we also need the parent's xmin (PARKED-005 r3) so the
    -- INSERT path can distinguish "child of a record being created in this
    -- transaction" from "child added to old billed history".
    v_parent_record_id := COALESCE(
      CASE TG_OP WHEN 'DELETE' THEN OLD.application_record_id
                 ELSE NEW.application_record_id END,
      OLD.application_record_id
    );
    SELECT j.status, j.job_number, r.xmin INTO v_job_status, v_job_number, v_parent_xmin
      FROM public.job_applied_records r
      JOIN public.jobs j ON j.id = r.job_id
      WHERE r.id = v_parent_record_id;
  END IF;

  -- Parent missing (cascade race) — let the row through; the underlying FK / RLS will
  -- settle it. We're only the billed-status guard.
  IF v_job_status IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Only billed/terminal jobs are immutable.
  IF v_job_status NOT IN ('invoiced', 'cancelled') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- PARKED-005 r3: child INSERT is allowed IFF the parent applied_record was
  -- created in THIS transaction (age(xmin)=0 — same Postgres xid). Distinguishes
  -- "the standard save_job_applied_record NEW-record path" (parent + children
  -- INSERTed in one txn, parent xmin matches current) from "raw-REST tampering
  -- adding fields to old billed history" (parent xmin is an older txn).
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN ('job_applied_record_fields', 'job_applied_record_crew') THEN
    IF age(v_parent_xmin) = 0 THEN
      RETURN NEW;  -- parent created in this txn — legitimate post-billing record
    END IF;
    -- fall through to admin / override check, then REJECT below
  END IF;

  -- Admins may correct billed history; the SECURITY DEFINER override hatch is honored
  -- so sanctioned server-side flows (e.g. a future transfer_invoice_to_job reversal
  -- that needs to clean up applied detail) still work.
  IF is_admin() OR _is_admin_override() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- PARKED-005 (Codex r1): EXEMPT the recompute-only UPDATE on job_applied_records.
  -- settle_applied_record_acres (AFTER INSERT trg_jarf_recompute) UPDATEs only
  -- applied_acres on this table to SUM(child.applied_acres); that path is the
  -- "record after billing" intent. To exempt the recompute WITHOUT opening a
  -- tampering window:
  --   (a) NEW.applied_acres must equal the current child-sum exactly (so a user
  --       arbitrary value like 9999 is still rejected — only the recompute's
  --       computed sum slips through), AND
  --   (b) every OTHER non-generated column is unchanged (mirrors the jobs
  --       immutability exempt list pattern: created_at/id/created_by frozen,
  --       updated_at handled by the set_updated_at BEFORE trigger which fires
  --       AFTER ours, so OLD.updated_at = NEW.updated_at at this point).
  -- Children (_fields, _crew) have no analogous rollup → this exempt is parent-only.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'job_applied_records' THEN
    DECLARE v_child_sum numeric;
    BEGIN
      SELECT COALESCE(SUM(applied_acres), 0) INTO v_child_sum
        FROM public.job_applied_record_fields
        WHERE application_record_id = NEW.id;

      IF NEW.applied_acres IS DISTINCT FROM OLD.applied_acres
         AND NEW.applied_acres IS NOT DISTINCT FROM v_child_sum
         AND NEW.job_id              IS NOT DISTINCT FROM OLD.job_id
         AND NEW.applicator_id       IS NOT DISTINCT FROM OLD.applicator_id
         AND NEW.vehicle_id          IS NOT DISTINCT FROM OLD.vehicle_id
         AND NEW.application_date    IS NOT DISTINCT FROM OLD.application_date
         AND NEW.notes               IS NOT DISTINCT FROM OLD.notes
         AND NEW.start_weather_time  IS NOT DISTINCT FROM OLD.start_weather_time
         AND NEW.start_temp_f        IS NOT DISTINCT FROM OLD.start_temp_f
         AND NEW.start_wind_direction IS NOT DISTINCT FROM OLD.start_wind_direction
         AND NEW.start_wind_mph      IS NOT DISTINCT FROM OLD.start_wind_mph
         AND NEW.start_humidity_pct  IS NOT DISTINCT FROM OLD.start_humidity_pct
         AND NEW.start_weather_source IS NOT DISTINCT FROM OLD.start_weather_source
         AND NEW.end_weather_time    IS NOT DISTINCT FROM OLD.end_weather_time
         AND NEW.end_temp_f          IS NOT DISTINCT FROM OLD.end_temp_f
         AND NEW.end_wind_direction  IS NOT DISTINCT FROM OLD.end_wind_direction
         AND NEW.end_wind_mph        IS NOT DISTINCT FROM OLD.end_wind_mph
         AND NEW.end_humidity_pct    IS NOT DISTINCT FROM OLD.end_humidity_pct
         AND NEW.end_weather_source  IS NOT DISTINCT FROM OLD.end_weather_source
         AND NEW.beginning_tach      IS NOT DISTINCT FROM OLD.beginning_tach
         AND NEW.end_tach            IS NOT DISTINCT FROM OLD.end_tach
         AND NEW.created_by          IS NOT DISTINCT FROM OLD.created_by
         AND NEW.id                  IS NOT DISTINCT FROM OLD.id
         AND NEW.created_at          IS NOT DISTINCT FROM OLD.created_at
      THEN
        RETURN NEW;  -- recompute-only update matching child-sum — preserve "record after billing"
      END IF;
    END;
  END IF;

  -- Non-admin, billed job, no override → REJECT.
  RAISE EXCEPTION
    'A % job''s applied-record (or its child rows) is billed history and cannot be % by a non-admin (job %).',
    v_job_status, lower(TG_OP), v_job_number
    USING ERRCODE = 'check_violation';
END;
$function$;

-- Parent: job_applied_records — UPDATE and DELETE only (INSERT preserves the
-- "record after billing" intent from migration 20260625190000).
DROP TRIGGER IF EXISTS enforce_billed_job_applied_record_immutability ON public.job_applied_records;
CREATE TRIGGER enforce_billed_job_applied_record_immutability
  BEFORE UPDATE OR DELETE ON public.job_applied_records
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_billed_job_applied_record_immutability();

-- Child: job_applied_record_fields — INSERT is also gated (PARKED-005 r3); the
-- xmin-based exempt in the function allows the legitimate "child of a brand-new
-- parent in this same transaction" path while rejecting "add fields to old billed
-- history" through raw REST.
DROP TRIGGER IF EXISTS enforce_billed_jarf_immutability ON public.job_applied_record_fields;
CREATE TRIGGER enforce_billed_jarf_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON public.job_applied_record_fields
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_billed_job_applied_record_immutability();

-- Child: job_applied_record_crew — same INSERT gating as _fields
DROP TRIGGER IF EXISTS enforce_billed_jarc_immutability ON public.job_applied_record_crew;
CREATE TRIGGER enforce_billed_jarc_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON public.job_applied_record_crew
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_billed_job_applied_record_immutability();

COMMENT ON FUNCTION public._enforce_billed_job_applied_record_immutability() IS
  'PARKED-005 (codex-driven cycle 3 #3): extends billed-job immutability to '
  'job_applied_records + its child tables (_fields, _crew). For a non-admin '
  'without the app.admin_override hatch, UPDATE or DELETE on an applied-record '
  'belonging to an invoiced/cancelled job RAISES. INSERT is allowed (preserves '
  'the "record after billing" intent of migration 20260625190000). Sibling of '
  '_enforce_billed_job_immutability.';

-- SELF-VERIFICATION — PARKED-005 r4 (Codex tightening): assert FUNCTION BODY
-- has every guard (billed-status, admin/override, child-INSERT xmin exempt,
-- parent-UPDATE child-sum exempt) AND each trigger's EVENT bits are exactly
-- the intended set (parent UPDATE/DELETE only — INSERT must remain ungated to
-- preserve "record after billing"; child INSERT/UPDATE/DELETE all three).
DO $$
DECLARE
  v_src text;
  v_parent_def text;
  v_jarf_def text;
  v_jarc_def text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
    WHERE proname='_enforce_billed_job_applied_record_immutability'
      AND pronamespace='public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'PARKED-005: function _enforce_billed_job_applied_record_immutability is missing';
  END IF;

  -- Guard #1: billed-status check
  IF position('invoiced' in v_src) = 0 OR position('cancelled' in v_src) = 0 THEN
    RAISE EXCEPTION 'PARKED-005: billed-status check missing from trigger function';
  END IF;
  -- Guard #2: admin / override hatch
  IF position('is_admin()' in v_src) = 0 OR position('_is_admin_override()' in v_src) = 0 THEN
    RAISE EXCEPTION 'PARKED-005: admin / override hatch missing';
  END IF;
  -- Guard #3: child-INSERT xmin exempt (the r3 fix that closes the "add fields to
  -- old billed history" loophole)
  IF position('age(v_parent_xmin) = 0' in v_src) = 0 THEN
    RAISE EXCEPTION 'PARKED-005: xmin same-txn child-INSERT exempt missing';
  END IF;
  -- Guard #4: parent-UPDATE child-sum exempt (legitimate recompute path)
  IF position('NEW.applied_acres IS NOT DISTINCT FROM v_child_sum' in v_src) = 0 THEN
    RAISE EXCEPTION 'PARKED-005: child-sum recompute exempt missing';
  END IF;

  -- Trigger DDL bits — extract pg_get_triggerdef and assert each event list.
  SELECT pg_get_triggerdef(t.oid) INTO v_parent_def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname='job_applied_records' AND t.tgname='enforce_billed_job_applied_record_immutability';
  SELECT pg_get_triggerdef(t.oid) INTO v_jarf_def   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname='job_applied_record_fields' AND t.tgname='enforce_billed_jarf_immutability';
  SELECT pg_get_triggerdef(t.oid) INTO v_jarc_def   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname='job_applied_record_crew'   AND t.tgname='enforce_billed_jarc_immutability';

  IF v_parent_def IS NULL THEN RAISE EXCEPTION 'PARKED-005: parent trigger missing'; END IF;
  IF v_jarf_def   IS NULL THEN RAISE EXCEPTION 'PARKED-005: jarf trigger missing';   END IF;
  IF v_jarc_def   IS NULL THEN RAISE EXCEPTION 'PARKED-005: jarc trigger missing';   END IF;

  -- Parent: UPDATE + DELETE; must NOT include INSERT (preserves "record after billing")
  IF v_parent_def NOT LIKE '%UPDATE%' OR v_parent_def NOT LIKE '%DELETE%' THEN
    RAISE EXCEPTION 'PARKED-005: parent trigger must include UPDATE OR DELETE — def: %', v_parent_def;
  END IF;
  IF v_parent_def LIKE '%INSERT%' THEN
    RAISE EXCEPTION 'PARKED-005: parent trigger must NOT include INSERT — def: %', v_parent_def;
  END IF;
  -- Children: must include ALL three (INSERT + UPDATE + DELETE)
  IF v_jarf_def NOT LIKE '%INSERT%' OR v_jarf_def NOT LIKE '%UPDATE%' OR v_jarf_def NOT LIKE '%DELETE%' THEN
    RAISE EXCEPTION 'PARKED-005: jarf trigger must include INSERT OR UPDATE OR DELETE — def: %', v_jarf_def;
  END IF;
  IF v_jarc_def NOT LIKE '%INSERT%' OR v_jarc_def NOT LIKE '%UPDATE%' OR v_jarc_def NOT LIKE '%DELETE%' THEN
    RAISE EXCEPTION 'PARKED-005: jarc trigger must include INSERT OR UPDATE OR DELETE — def: %', v_jarc_def;
  END IF;
END $$;

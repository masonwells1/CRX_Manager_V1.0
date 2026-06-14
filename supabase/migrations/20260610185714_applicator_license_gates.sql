-- B5 (2026-06-10 deep-dive H1): applicator license-expiry gates
-- idempotency-body-check: exempt  (assign_job_applicator uses the canonical
-- check_idempotency/save_idempotency helpers)
--
-- 1) applicator_licenses gains staff-held licenses: customer_id becomes optional,
--    new profile_id links a license to an internal profile (applicator/driver/etc).
--    Existing rows are all customer-held and unaffected (CHECK requires one holder).
-- 2) BEFORE trigger on jobs blocks assigning an applicator whose linked, active
--    licenses are ALL expired. No license on file = allowed (gate only applies once
--    licenses are tracked for that person; UI warns). Honors the canonical
--    app.admin_override hatch via _is_admin_override().
-- 3) assign_job_applicator RPC: single assignment path (DispatchBoard switches to it)
--    and the admin-only license-override hatch. Strict-actor + admin/sales_rep gate
--    (mirrors the live jobs_update RLS policy).

-- ── 1) Schema: staff-held licenses ────────────────────────────────────────────
ALTER TABLE applicator_licenses ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE applicator_licenses ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES profiles(id);
ALTER TABLE applicator_licenses
  ADD CONSTRAINT applicator_licenses_holder_check
  CHECK (customer_id IS NOT NULL OR profile_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_applicator_licenses_profile ON applicator_licenses(profile_id);

-- ── 2) Trigger: license gate on applicator assignment ────────────────────────
CREATE OR REPLACE FUNCTION _enforce_applicator_license()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_licenses boolean;
  v_latest_expiry date;
BEGIN
  IF NEW.applicator_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.applicator_id IS NOT DISTINCT FROM OLD.applicator_id THEN
    RETURN NEW;
  END IF;
  IF _is_admin_override() THEN
    RETURN NEW;
  END IF;

  SELECT count(*) > 0, max(expiry_date)
    INTO v_has_licenses, v_latest_expiry
    FROM applicator_licenses
   WHERE profile_id = NEW.applicator_id
     AND is_active = true;

  IF NOT v_has_licenses THEN
    RETURN NEW;
  END IF;

  IF v_latest_expiry < CURRENT_DATE THEN
    RAISE EXCEPTION 'LICENSE_EXPIRED: applicator license expired %', v_latest_expiry;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_applicator_license ON jobs;
CREATE TRIGGER enforce_applicator_license
  BEFORE INSERT OR UPDATE OF applicator_id ON jobs
  FOR EACH ROW EXECUTE FUNCTION _enforce_applicator_license();

-- ── 3) RPC: assign_job_applicator ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION assign_job_applicator(
  p_job_id uuid,
  p_applicator_id uuid DEFAULT NULL,
  p_license_override boolean DEFAULT false,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_existing jsonb;
  v_job jobs%ROWTYPE;
  v_applicator_name text;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;
  IF p_license_override AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'OVERRIDE_REQUIRES_ADMIN';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'assign_job_applicator');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOB_NOT_FOUND'; END IF;

  IF p_license_override THEN
    PERFORM set_config('app.admin_override', 'true', true);
  END IF;

  UPDATE jobs SET applicator_id = p_applicator_id WHERE id = p_job_id;

  IF p_license_override THEN
    PERFORM set_config('app.admin_override', 'false', true);
  END IF;

  IF p_applicator_id IS NOT NULL THEN
    SELECT full_name INTO v_applicator_name FROM profiles WHERE id = p_applicator_id;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES (
    'job_assigned',
    CASE WHEN p_applicator_id IS NULL THEN 'Job unassigned'
         ELSE 'Job assigned to ' || coalesce(v_applicator_name, 'unknown')
              || CASE WHEN p_license_override THEN ' (license override by admin)' ELSE '' END
    END,
    v_actor,
    'job',
    p_job_id,
    v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'applicator_id', p_applicator_id,
    'license_override', p_license_override
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'assign_job_applicator', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION assign_job_applicator(uuid, uuid, boolean, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION assign_job_applicator(uuid, uuid, boolean, uuid, text) TO authenticated, service_role;

-- ── Verification ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'assign_job_applicator';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'assign_job_applicator overload count is % (expected 1)', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgrelid = 'jobs'::regclass AND tgname = 'enforce_applicator_license' AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'enforce_applicator_license trigger missing on jobs';
  END IF;

  SELECT count(*) INTO v_count FROM pg_constraint
   WHERE conrelid = 'applicator_licenses'::regclass AND conname = 'applicator_licenses_holder_check';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'applicator_licenses_holder_check constraint missing';
  END IF;
END $$;

-- Field-app parity #38 — phone/mobile applicator field view.
--
-- LOAD-BEARING GAP CLOSED HERE.
-- The read-only field-view card shows five fields for a dispatched applicator:
-- Customers, Locations, Chemicals/Charges, Crops, Scheduled Date. Section #36 added
-- additive `*_location_dispatchee` SELECT policies to `jobs`, `job_fields`, and
-- `customers` so a LOCATION-ONLY dispatched applicator (someone who is NOT the
-- whole-job `jobs.applicator_id`, but who has a current per-location dispatch to a
-- field on the job) can read the job header, its locations (incl. `job_fields.crop`),
-- the customer, and the scheduled date (`jobs.job_date`).
--
-- BUT #36 did NOT extend `job_chemicals`. Its only SELECT policy
-- (`job_chemicals_select`) allows admin / sales_rep / the whole-job applicator. So a
-- location-only dispatched applicator currently CANNOT read `job_chemicals` — the
-- card's "Chemicals / Charges" section (chemicals + the per-product charges derived
-- from `price_per_unit_cents`) would silently render EMPTY for exactly the person the
-- field view is built for. (There is no separate job-charges table — charges are
-- derived from `job_chemicals` price columns, so this one policy unblocks both.)
--
-- FIX: add a SECOND, ADDITIVE permissive SELECT policy that mirrors the #36 pattern
-- exactly — allow read when `public._is_dispatched_to_me(job_chemicals.job_id)` is
-- true. Permissive SELECT policies are OR'd, so this only WIDENS read access; the
-- existing `job_chemicals_select` is left untouched, and the INSERT/UPDATE/DELETE
-- policies are not touched at all (writes stay admin/sales/whole-job-applicator only).
--
-- The helper `public._is_dispatched_to_me(uuid)` (created in
-- 20260626120000_job_location_dispatches.sql) is SECURITY DEFINER + STABLE with
-- `SET search_path`, re-checks `profiles.is_active`, and only returns true for a
-- CURRENT (`dispatch_status='dispatched'`) per-location dispatch to the caller
-- (directly, or via an active membership in an active dispatched crew). Its
-- job_location_dispatches read bypasses RLS, so there is no recursion with the
-- job_chemicals / jobs policies.

DROP POLICY IF EXISTS "job_chemicals_select_location_dispatchee" ON public.job_chemicals;
CREATE POLICY "job_chemicals_select_location_dispatchee" ON public.job_chemicals
  FOR SELECT TO authenticated
  USING ( public._is_dispatched_to_me(job_chemicals.job_id) );

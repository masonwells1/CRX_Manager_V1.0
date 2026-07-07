-- U3 OPTIONAL follow-up (task #3): per-customer default application service.
--
-- This is a SEPARATE, deferrable migration. The primary deliverable (making the
-- per-acre fee billable) is complete with migration 20260706020000 + the JobDetail
-- picker alone. This one only adds a convenience default so a new job for a customer
-- who always gets the same machine service prefills the picker.
--
-- Purely additive: one nullable FK column. No data backfill. No RLS change (customers
-- already has RLS; a new nullable column inherits the existing table policies). No
-- function re-emit.
--
-- Frontend wiring (apply ONLY if you take this migration):
--   * Add `default_application_service_id?: string | null` to the Customer type
--     (see types.patch.md).
--   * Surface an ApplicationServicePicker on the customer edit form (a natural spot:
--     alongside the existing default_commission_split field). save_customer would
--     need to persist it — CHECK save_customer's signature first (it may take a
--     payload jsonb like save_job, in which case add the key; otherwise it needs a
--     new param, which is a bigger change — evaluate before committing).
--   * In JobDetail, when creating a NEW job (isNew) and a customer is selected, if
--     applicationServiceId is still null, prefill it from the customer's
--     default_application_service_id. Only prefill for new jobs; never override a
--     user's explicit choice or an existing job's saved value.
--
-- Because the save_customer wiring is non-trivial, the recommendation is to SHIP the
-- picker-only primary deliverable first and treat this column as a later opt-in.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS default_application_service_id uuid
    REFERENCES public.application_services(id);

COMMENT ON COLUMN public.customers.default_application_service_id IS
  'Optional default application service prefilled into new jobs for this customer (U3, finding #52 follow-up).';

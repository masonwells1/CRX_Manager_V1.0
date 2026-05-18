-- Restore profile_public_view that was dropped in 20260511120000.
--
-- Context: at the time 20260511120000 was authored, grep across this branch
-- (claude/app-review-audit-yseuL) and pg_proc.prosrc returned zero callsites
-- for the view, so it was dropped to clear the `security_definer_view` ERROR
-- advisor. However, in parallel, the branch `fix/audit-2026-05-09` was
-- migrating 30+ callsites TO the view (PR-07 follow-up) so non-admin callers
-- could fan out admin notifications and populate name dropdowns under the
-- admin-or-self profiles RLS. See:
--   - src/lib/activityLogger.ts:78-86
--   - src/components/deliveries/QuickDeliveryModal.tsx:80-84
--   - src/components/team/ActivityFeed.tsx, CommentsSection.tsx (+ ~26 more)
--
-- The view is restored with the same shape and owner-defined semantics
-- (security_invoker = false, the Postgres default) as the original. The
-- `security_definer_view` advisor warning will reappear; this is accepted
-- by design because the view is the documented mechanism for exposing the
-- minimal profile subset (id, full_name, role, is_active) to non-admin
-- callers without loosening the underlying profiles RLS.
--
-- Already applied to prod 2026-05-16 via apply_migration MCP under the name
-- `restore_profile_public_view` immediately after the conflict was reported
-- on PR #60. This file documents that state in the repo so fresh DB replays
-- end up with the view in place.

CREATE OR REPLACE VIEW public.profile_public_view AS
SELECT id, full_name, role, is_active
  FROM public.profiles;

COMMENT ON VIEW public.profile_public_view IS
  'Public-readable subset of profiles (id, full_name, role, is_active). Uses owner-defined semantics intentionally so non-admin callers (notification fan-out, name dropdowns) can still read other users under the admin-or-self profiles RLS. See activityLogger.ts:78-86, QuickDeliveryModal.tsx:80-84. The security_definer_view advisor warning on this view is accepted by design — do not drop without first migrating all callsites.';

-- 20260624030000_revoke_anon_preview_field_app_split.sql
-- Post-apply correction to 20260624020000. That migration DROP+CREATEd
-- preview_field_app_invoice_split (a SECURITY DEFINER, read-only function that returns
-- customer/pricing preview data). Supabase's ALTER DEFAULT PRIVILEGES auto-grants EXECUTE
-- to anon on every newly-CREATEd function, and `REVOKE ALL ... FROM PUBLIC` does NOT remove
-- that explicit anon grant — so the new 4-arg function briefly became anon-executable, which
-- the live 3-arg function never was (its posture was authenticated + service_role ONLY).
-- This REVOKEs anon to restore the exact intended posture. It was also executed against live
-- out-of-band the instant the post-apply grant check caught it; this migration records it and
-- makes a cold re-apply land in the correct final state. REVOKE is idempotent (no-op on live).
--
-- caller-analysis: preview_field_app_invoice_split :: the only live caller
--   (FieldApplicationInvoice.tsx handlePreview) runs as an AUTHENTICATED user; authenticated +
--   service_role keep EXECUTE. Revoking anon affects no real caller — it only closes the
--   unintended unauthenticated read of customer/pricing preview data.

REVOKE EXECUTE ON FUNCTION public.preview_field_app_invoice_split(jsonb, jsonb, uuid, uuid) FROM anon;

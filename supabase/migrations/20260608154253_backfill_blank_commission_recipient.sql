-- Fix (LOW, 2026-06-08 workflow review): one legacy commissions row carries an empty-string
-- recipient display name (predates the _insert_commissions_for_order filter that now blocks
-- blank recipients). It still has a valid recipient_user_id, so it is technically payable,
-- but a blank name can make it invisible in a name-grouped payout UI.
--
-- Backfill the display name from the linked profile for any non-cancelled commission whose
-- recipient is blank but recipient_user_id resolves to a profile. Cancelled / unlinked rows
-- (e.g. the legacy $0 cancelled row with a NULL recipient_user_id) are intentionally left
-- untouched. Idempotent and environment-safe: a no-op anywhere no such row exists.

UPDATE public.commissions c
SET recipient = p.full_name
FROM public.profiles p
WHERE p.id = c.recipient_user_id
  AND NULLIF(btrim(c.recipient), '') IS NULL
  AND NULLIF(btrim(p.full_name), '') IS NOT NULL
  AND c.status <> 'cancelled';

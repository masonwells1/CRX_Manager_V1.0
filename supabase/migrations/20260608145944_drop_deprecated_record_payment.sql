-- Migration: drop deprecated record_payment  (architecture-weakness audit AW-3)
--
-- record_payment is a deprecated, unreachable SECURITY DEFINER money RPC. It
-- declared p_idempotency_key but ignored it, and NOTHING calls it (all verified
-- live 2026-06-08):
--   * no frontend `.rpc('record_payment')` (only record_invoice_payment / record_vendor_payment)
--   * no other public function body references it (pg_proc scan, incl. triggers)
--   * no Edge Function references it (supabase/functions grep)
--   * no cron.job references it
-- src/lib/rpcContracts.test.ts:307 records it as "deprecated. Use allocate_payment
-- instead." A dead SECURITY DEFINER money-mutator with no idempotency is latent
-- risk if ever re-wired, so it is removed. Single overload (verified).
-- Fully recoverable from git history if ever needed.

DROP FUNCTION IF EXISTS public.record_payment(uuid, numeric, text, text, text, uuid, text);

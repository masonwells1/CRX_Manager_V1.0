-- ============================================================================
-- Migration: Fix search_path on 4 trigger functions flagged by Supabase linter
-- ============================================================================
-- The Supabase security linter (function_search_path_mutable) flagged these 4
-- functions as having a mutable search_path. Two (_enforce_quote/return_status)
-- had search_path = 'public' from migration 20260319000000 but were missing
-- pg_temp. Two (guard_audit_log_immutable, _fill_audit_actor) never had
-- search_path set at all.
--
-- Fix: ALTER FUNCTION to set search_path = 'public', 'pg_temp' on all four.
-- ============================================================================

-- Functions that never had search_path set
ALTER FUNCTION public.guard_audit_log_immutable() SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public._fill_audit_actor()        SET search_path TO 'public', 'pg_temp';

-- Functions that had search_path = 'public' but were missing pg_temp
ALTER FUNCTION public._enforce_quote_status_transition()  SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public._enforce_return_status_transition() SET search_path TO 'public', 'pg_temp';

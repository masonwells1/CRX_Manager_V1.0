-- Source: gauntlet section 5 refresh 2026-07-22; Supabase advisor WARN function_search_path_mutable.
-- ALTER preserves the current function bodies while hardening their mutable search_path.

ALTER FUNCTION public.guard_customer_document_update() SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.guard_customer_fact_provenance() SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.guard_interaction_attribution() SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.normalize_phone_e164(text, text) SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.parse_payment_terms_days(text) SET search_path TO 'public', 'pg_temp';

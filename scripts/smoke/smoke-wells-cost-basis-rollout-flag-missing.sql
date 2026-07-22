\set ON_ERROR_STOP on

BEGIN;
DELETE FROM public.app_settings
WHERE setting_key = 'supplier_cost_basis_enabled';
\i /tmp/wells-rollout.sql

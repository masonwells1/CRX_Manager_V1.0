\set ON_ERROR_STOP on

BEGIN;
UPDATE public.app_settings
SET setting_value = 'true'
WHERE setting_key = 'supplier_cost_basis_enabled';
\i /tmp/wells-rollout.sql

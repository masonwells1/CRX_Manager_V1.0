\set ON_ERROR_STOP on

-- Fail-first proof against the exact migration bytes. All ten Wells links stay
-- fully eligible, but one observation is rebound to another Product's link.
-- The migration must reject that stale provenance and this failed transaction
-- restores the fixture before the clean migration run.
BEGIN;

UPDATE public.supplier_price_observations
SET product_supplier_link_id = '10000000-0000-4000-8000-000000000010'
WHERE id = '30000000-0000-4000-8000-000000000009';

\i /tmp/wells-rollout.sql

\set ON_ERROR_STOP on

-- Fail-first proof against the exact migration bytes. This transaction makes
-- one otherwise valid Wells link non-reusable; the migration must reject the
-- drift before creating its rollout table. The expected error aborts and rolls
-- back this transaction, restoring the fixture for the clean migration run.
BEGIN;

UPDATE public.product_supplier_links
SET supplier_sku = NULL
WHERE product_id = 'd1961efe-6133-4ab4-bf84-ac7bf7da903a';

\i /tmp/wells-rollout.sql

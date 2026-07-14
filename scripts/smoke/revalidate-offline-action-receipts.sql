-- Disposable-clone revalidation harness for the queued offline receipt migration.
--
-- Run only against a disposable local database where an earlier draft of the
-- queued migration may already exist. The smoke's terminal
-- SMOKE_PASS_ROLLBACK exception aborts this outer transaction, restoring the
-- clone to its original state. Never run this harness against production.

\set ON_ERROR_STOP on

BEGIN;

DROP FUNCTION IF EXISTS public.get_offline_action_status(uuid);
DROP FUNCTION IF EXISTS public.process_offline_action(uuid, text);
DROP FUNCTION IF EXISTS public.stage_offline_action(
  uuid, text, uuid, integer, timestamptz, jsonb, text
);
DROP TABLE IF EXISTS public.offline_action_receipts;

\ir ../../supabase/migrations/20260714024811_offline_action_receipts.sql
\ir smoke-offline-action-receipts.sql

-- Unreachable by design: the smoke must terminate with SMOKE_PASS_ROLLBACK.
ROLLBACK;

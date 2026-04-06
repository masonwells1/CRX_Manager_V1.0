-- Code review hardening (2026-04-06)
-- 1. create_job_from_quote_section: add quote status validation + duplicate job guard
-- 2. create_invoice_from_blend_ticket: explicit ::bigint casts on pricing
-- These fixes were applied to production via Supabase MCP apply_migration.
-- This file keeps the local migration history in sync.

-- See production-applied migration: code_review_rpc_hardening
-- Changes are already live. This file documents what was changed.
SELECT 1; -- no-op: changes applied directly to production

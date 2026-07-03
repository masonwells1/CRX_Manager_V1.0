-- ============================================================================
-- P2-2 — Retire dead objects (TIER A: the clean, zero-fallout subset only)
-- Structure Wave-2 · PARKED — NOT APPLIED. Mason applies with per-migration OK.
-- ============================================================================
-- WHAT THIS DROPS (2 objects — each verified 0-rows + 0-live-readers/writers +
--   NO frontend/type fallout):
--   1. FUNCTION public.create_prepay_credit(uuid,bigint,text,text,text)
--        - 1 live overload; ZERO callers (frontend uses allocate_payment /
--          edit_prepay_credit / delete_prepay_credit / batch_apply_*; no other
--          DB function calls it; caller-graph = "zero callers found anywhere").
--        - Not referenced by any test fixture array; only in the checked-in
--          pg_proc snapshot (updated in this branch) + the auto-gen supabase.ts.
--   2. TABLE public.document_processing_log
--        - 0 rows; no incoming FK; no fn/trigger/view reads or writes it
--          (process-document + process-blend-ticket edge fns reference it 0×);
--          no hand-written src/types/index.ts interface exists for it.
--
-- SMOKE (rolled-back live, 2026-07-03): a DO block ran both drops against live
--   then RAISE'd to roll back — SMOKE_RESULT| cpc_gone=t doclog_table_gone=t
--   (verified nothing persisted). plpgsql-safe: DROP ... IF EXISTS (RESTRICT).
--
-- COUPLING EDITS (already made on this branch; build+test stay green either
--   merge order — none are runtime-breaking):
--   * src/lib/rpcFixtureLiveDiff.test.ts — removed `create_prepay_credit,` from
--       LIVE_PG_PROC_NAMES_CSV snapshot + LIVE_PG_PROC_COUNT 267 -> 266 (the test
--       reads the snapshot, not live; self-consistent → 7/7 pass).
--   * scripts/backup-via-rest.py — removed "document_processing_log" from TABLES
--       (a dropped table would 404 the REST backup run).
--   * AT APPLY TIME (owner session): re-run generate_typescript_types (regens
--       src/types/supabase.ts) + /regen-schema-registry (PreToolUse hooks read
--       .claude/schema-registry.json).
--
-- ── DELIBERATELY NOT IN THIS MIGRATION (verified NOT clean — do not fold in) ──
--   * deliveries.receipt_pdf_url (column) — genuinely dead in the DB (0/102, no
--       reader), BUT removing its src/types/index.ts Delivery field destabilizes
--       fragile `as Array<Delivery & {...}>` casts in src/pages/Deliveries.tsx
--       (:294,:436) → a `customer`-mismatch typecheck error. Retiring it needs a
--       small cast-cleanup first; not a schema-drop ride-along. DEFERRED.
--   * jobs.tags + jobs.batch_id (columns) — BOTH written by save_job (INSERT +
--       UPDATE) and guarded by _enforce_billed_job_immutability
--       ("NEW.tags IS NOT DISTINCT FROM OLD.tags", same for batch_id). Dropping
--       either crashes save_job + the trigger at runtime. batch_id is ALSO a live
--       editable "Batch ID" field on JobDetail. Needs a save_job + trigger
--       re-emit (+ batch_id a frontend removal = product decision). OWNER-GATED.
--   * payments (table) + record_invoice_payment (RPC) — 0 rows, but 3 LIVE money
--       reports SELECT public.payments (close_accounting_period,
--       get_monthly_summary, get_customer_statement) + live E2E specs call
--       record_invoice_payment. Dropping = a money-behavior change. OWNER-GATED.
--   * order_line_allocations (table) — 0 rows, but live DELETE references remain
--       in production RPCs (update_order_items + 2 more) + a smoke script. NOT dead.
--
-- CODEX (2026-07-03, review --uncommitted): CLEAN — "No actionable correctness
--   issues were found in the modified backup table list, RPC fixture snapshot, or
--   parked dead-object retirement SQL."
-- ============================================================================

BEGIN;

-- 1. Unused prepay RPC (zero callers). GRANT drops automatically with the fn.
DROP FUNCTION IF EXISTS public.create_prepay_credit(uuid, bigint, text, text, text);

-- 2. Unused log table (0 rows, no dependents). Policies/grants drop with it.
DROP TABLE IF EXISTS public.document_processing_log;

COMMIT;

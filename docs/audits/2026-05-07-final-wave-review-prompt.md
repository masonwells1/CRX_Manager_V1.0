# Final 4-Wave Code Review — Master Prompt

**Date:** 2026-05-07
**Scope:** 16 commits on `main` since `origin/main` (waves 1–4 of the Phase 4 closure run).
**Goal:** find every bug, footgun, drift, RLS gap, idempotency gap, and migration-safety issue introduced by these waves before they ship to production. **Be ruthless.** The implementer was acting alone with autonomy and self-graded their own work. We need an adversarial review.

---

## Read these first to ground your review

1. `SESSION_FINAL_WAVE_1.md` — Wave 1 (4 audit Q-items)
2. `SESSION_FINAL_WAVE_2.md` — Wave 2 (4 Phase 4 frontend items)
3. `SESSION_FINAL_WAVE_3.md` — Wave 3 (1 migration + 1 E2E spec) ← contains a flagged anomaly about holds restoration
4. `SESSION_FINAL_WAVE_4.md` — Wave 4 (2 migrations + 1 corrective migration + self-review fixes)
5. `docs/audits/2026-05-07-phase-4-closure-plan-review.md` — pre-execution review of the plan

## Files in scope

**5 new/changed migrations to scrutinize line-by-line:**
- `supabase/migrations/20260507160000_warn_backdated_delivery_completion.sql` (Wave 3)
- `supabase/migrations/20260507170000_create_inventory_hold_rpc.sql` (Wave 4)
- `supabase/migrations/20260507180000_manufactured_at_delivery_flag.sql` (Wave 4)
- `supabase/migrations/20260507190000_fix_complete_delivery_wave3_regression.sql` (Wave 4)

**Frontend files touched across waves:**
- `src/pages/InventoryPage.tsx` (P4-3 force-retry, P4-8 zero-cross preview)
- `src/components/inventory/BatchAdjustModal.tsx` (P4-8)
- `src/pages/PurchaseOrderDetail.tsx` (P4-13)
- `src/pages/QuickReceive.tsx` (P4-14)
- `src/pages/CycleCounts.tsx` (P4-12)
- `src/pages/IntegrityCleanup.tsx` (P4-7 manufactured-at-delivery)
- `src/pages/SettingsPage.tsx` (Q8 OCR threshold removal)
- `src/hooks/useOCRThresholds.ts` (Q8)
- `src/components/settings/OCRThresholdSettings.tsx` (deleted)
- `src/pages/FieldDetail.tsx` (deleted)

**New test:**
- `tests/e2e/holds-cleanup-paths.spec.ts`

---

## Critical checks (in priority order)

### 1. Migration safety (HARD RED LINES)
- Every `SECURITY DEFINER` function MUST have `SET search_path = public, pg_temp`. Verify each new function.
- Every RPC that mutates data MUST accept `p_idempotency_key text DEFAULT NULL` AND actually read/write `idempotency_keys` (not just declare it).
- `idempotency_keys` columns MUST be `idempotency_key`, `operation`, `result` — NEVER `key`, `entity_type`, `entity_id`, or `result_id`.
- No `pg_get_functiondef()` + regex tricks. No `DROP FUNCTION` without verifying replacement exists.
- No GENERATED-ALWAYS column in the SET-clause of any UPDATE (e.g. `invoices.balance_cents`).
- No `updated_at` UPDATE on tables that lack the column. Verify against the per-table list in `CLAUDE.md` Schema Gotchas.
- Status enum values written by SQL or TS must exist in the table's CHECK constraint.
- Function overloads: each new function name MUST resolve to exactly one signature. Check the trailing `DO $$ ... pg_proc count = 1 ... $$` block exists and is correct.

### 2. RLS coverage
- Any new table or column-level surface must be covered by RLS. `inventory.manufactured_at_delivery` is a column add — verify the existing `inventory` policies still apply correctly to the new column (they should, but confirm).
- Verify `mark_inventory_row_verified` is callable by the right roles (admin only, per its body). Spot-check the GRANT statement and the role check inside the function.

### 3. Idempotency wiring (end-to-end)
- For each new RPC: does the function check `idempotency_keys` BEFORE mutation, save AFTER mutation, and use `ON CONFLICT (idempotency_key) DO NOTHING`?
- For each TS caller: does it use `useIdempotencyKey(operation, profile.id)` AND thread `getKey()` into the RPC call AND `resetKey()` after success?
- The Wave 2 fix wired `cancel_cycle_count`. Spot-check that complete/reverse/cancel all use distinct operation names and don't collide.

### 4. Documented unfixed bugs (verify they still exist or are now fixed)

**Bug A — NULL concat in `create_inventory_hold`** (Wave 4 finding #3, "documented, not fixed"):
```sql
-- 20260507170000_create_inventory_hold_rpc.sql line ~144
'WARNING: Hold created with admin override (' || p_force_reason || ')'
```
Reachable when `p_force=true` AND `p_force_reason=NULL` AND today's free ≥ requested qty (so the validation in the IF block is skipped). PostgreSQL concat with NULL = NULL, then INSERT into activity_feed with description=NULL. Verify whether activity_feed.description has NOT NULL — if so, this raises. Decide: fix via corrective migration, or punt.

**Bug B — wrong idempotency_keys columns** in `supabase/migrations/20260304200000_quick_receive.sql:306-308` (flagged in Wave 2 anomalies):
```sql
INSERT INTO idempotency_keys (key, operation, result) ...   -- CLAUDE.md says column is idempotency_key NOT key
```
Verify: is this March migration's `receive_po_items` function still the live version, or has a later migration replaced it? If still live, it's a bug — calls with `p_idempotency_key` will crash on second invocation. Search later migrations for `receive_po_items` re-definitions.

**Bug C — holds restoration over-accounting** (flagged in Wave 3 anomalies):
- `create_planned_holds` (and the new `create_inventory_hold`) do NOT decrement `inventory.quantity_available` on creation.
- `release_holds_on_quote_status_change` trigger DOES `quantity_available + v_hold.quantity` on decline/expire.
- If true asymmetric, declining a quote ADDS phantom inventory.
- Read the trigger body in `supabase/migrations/20260316100001_inventory_hold_restoration.sql:51-66` (or the latest definitive version) and confirm.

**Bug D — IntegrityCleanup `Promise.all` fragility** (flagged in Wave 4 anomalies):
- `IntegrityCleanup.tsx` `fetchAll` uses `Promise.all` of 4 queries; one filters by `manufactured_at_delivery = true`.
- If the migration `20260507180000` is NOT applied but the front-end IS deployed, that query rejects, dragging the other 3 down with it via `Promise.all`.
- Verify whether deploy-order actually protects against this in practice. If not, recommend `Promise.allSettled`.

### 5. The Wave 3 → Wave 4 regression-then-fix dance
- Migration `20260507160000` (Wave 3) replaces `complete_delivery` with the March-19 body — missing 6 features (precheck, in_progress guard, driver auth, auto-invoice, strict actor, phantom-row branch).
- Migration `20260507190000` (Wave 4) replaces it AGAIN with the Phase 15 body + P4-10 warn block.
- **Verify:** apply order is enforced by timestamp. Final state has the warn block AND all 6 Phase 15 features. Are any features still missing in `20260507190000`? Cross-reference against `20260501100000_field_app_workflow_phase15.sql` to confirm verbatim copy.
- **Edge:** if `20260507160000` fails to apply but `20260507190000` succeeds, does `20260507190000` produce a complete and correct function on its own? It should — it's `CREATE OR REPLACE`. Confirm.

### 6. Frontend ⇄ backend signature alignment
- `complete_delivery` Phase 15 body requires `auth.uid() IS NOT NULL` (raises 'Not authenticated'). The existing TS callers in `DeliveryDetail.tsx` and the e2e test must be authenticated. Spot-check.
- `create_inventory_hold` raises `AUTH_REQUIRED`, `ACTOR_MISMATCH`, `INSUFFICIENT_ROLE`, `INVALID_HOLD_TYPE`, `INVALID_QUANTITY`, `FORCE_REQUIRES_ADMIN`, `FORCE_REQUIRES_REASON`, `INSUFFICIENT_HOLD_INVENTORY`. Verify TS error handler in `InventoryPage.tsx` parses each correctly OR has a sensible default.
- `mark_inventory_row_verified` raises `AUTH_REQUIRED`, `ACTOR_MISMATCH`, `INSUFFICIENT_ROLE`, `INVENTORY_NOT_FOUND`. Verify TS error handler in `IntegrityCleanup.tsx`.
- `cancel_cycle_count` idempotency: verify the TS call site now passes `p_idempotency_key` and that the same key isn't reused across complete/reverse/cancel by accident.

### 7. Money & math safety
- Any `parseFloat` on `*_cents` variables? (Pre-commit hook flags this; check whether it slipped through.)
- Any new `.toFixed(2)` on a money variable that's used for math (not display)?
- Any new code that does math on money in cents but stores result in a non-bigint column?

### 8. Confirmation/dialog discipline
- Any new `confirm()`, `window.confirm()`, `alert()`, `window.alert()` in the touched frontend files? Pre-commit hook should catch — verify it didn't get bypassed.
- New destructive actions must use `ConfirmModal`. The IntegrityCleanup "Mark Verified" and InventoryPage "Force-create hold" both involve admin overrides — verify they prompt properly.

### 9. Activity logging signature
- All `logActivity` calls in touched frontend files must use the typed-object form: `{ event, description, performedBy, entityType, entityId }` — never positional.
- Spot-check 3 random sites in this wave's commits.

### 10. checkMutationResult / assertRpcResult coverage
- Any bare `.update()` or `.delete()` in touched files without `checkMutationResult()`?
- Any `.rpc()` whose data is used downstream without `assertRpcResult()`?

### 11. Documentation drift
- `CLAUDE.md` claims 65 pages, 92 tables, ~175 RPCs, 282 migrations, 1872 unit tests / 130 files, 94 E2E specs.
- Verify each count against the codebase. Run:
  - `grep -c "lazy(" src/App.tsx` → 65
  - `ls supabase/migrations/*.sql | wc -l` → 282
  - `find tests -name "*.spec.ts" | wc -l` → 94
  - `find src tests -name "*.test.ts*" | wc -l` for unit count
- `docs/reference/migration-history.md` should have rows for #279, #280, #281, #282 (the 4 new migrations).
- `docs/reference/rpc-functions.md` should mention `create_inventory_hold`, `mark_inventory_row_verified`, plus the P4-10 update note on `complete_delivery` + `void_delivery`.
- `docs/reference/database-schema.md` should mention `inventory.manufactured_at_delivery`.

### 12. Test coverage for new behaviors
- The new e2e spec `holds-cleanup-paths.spec.ts` is documented as "not actually run against live yet". The implementer flagged a concern that Path B may fail because of the `quantity_available` asymmetry (Bug C above). What does the spec assert, and would it pass given current code?
- Are there unit tests for the new RPCs' error paths? (`AUTH_REQUIRED`, `FORCE_REQUIRES_REASON`, `INVENTORY_NOT_FOUND`, etc.) Probably not — flag as a gap if so.

### 13. Cross-wave consistency drift
- The pre-execution review flagged that `create_inventory_hold` uses raw-SQL idempotency while other RPCs use `check_idempotency()` / `save_idempotency()` helpers. Verify both patterns exist in the codebase and decide if it's actionable.
- Plan said `notify_admins(...)` helper exists; implementer used inline `FOR ... LOOP INSERT INTO notifications`. Verify no new helper got added.

---

## Output format (be specific and actionable)

For each finding return:
1. **ID** (sequential)
2. **Severity** — 🟥 BLOCKER / 🟧 HIGH / 🟨 MEDIUM / 🟦 LOW / ℹ️ INFO
3. **File** + **line range**
4. **One-line summary**
5. **Why it's a bug** (3-5 sentences)
6. **Proposed fix** (concrete code or migration text)
7. **Confidence** (high/medium/low)

If you find no bugs in a section, say so explicitly — silence is not the same as "verified clean."

End with a final verdict:
- "Ship as-is" — only if every finding is INFO or LOW.
- "Ship after fixing N findings" — list the exact ID set.
- "Hold — investigate before deciding" — specify what's blocking judgment.

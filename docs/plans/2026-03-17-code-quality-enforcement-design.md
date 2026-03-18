# Code Quality Enforcement & Final Cleanup — Design

**Date:** 2026-03-17
**Status:** Approved
**Goal:** Eliminate all remaining code quality violations AND add automated enforcement so they can never return.

---

## Problem Statement

Over the past 2 weeks, ~56 pages and ~144 RPCs were built at high speed. Code quality rules (assertRpcResult, Sentry imports, logActivity signature, idempotency keys) were added to CLAUDE.md retroactively — after most code was already written. This created a cycle:

1. Write features fast
2. Audit later, find 20-50 violations of rules that didn't exist when the code was written
3. Fix them manually
4. Write more features that reintroduce the same violations
5. Audit again...

The fix is two-fold: (A) fix all remaining violations, and (B) add machine-enforced rules that block violations at commit time.

---

## Current State (audited 2026-03-17)

| Bug Class | Remaining | Already Fixed | Enforcement |
|-----------|-----------|--------------|-------------|
| Missing `assertRpcResult` on RPC data | **28** in 18 files | ~50 fixed | None |
| Missing `.select()` on mutations | **0** | 52 fixed | None |
| `logActivity` parameter shift | **0** (57 calls correct) | 2 fixed | None (fragile positional API) |
| `console.warn` instead of Sentry | **0** | ~30 fixed | Partial (`no-console` allows warn) |
| Wrong Sentry import path | **0** | ~12 fixed | None |
| Missing idempotency keys | **5** in 3 files | ~15 wired | None |

---

## Solution — 4 Phases

### Phase 1: Fix All 28 `assertRpcResult` Violations + 5 Idempotency Gaps

**What:** Mechanical fixes — add `assertRpcResult` import and wrap data casts in 18 files. Add `p_idempotency_key` to 5 RPC calls in 3 files.

**Files (assertRpcResult — 28 violations):**

1. `src/components/blendtickets/ManualTicketCreate.tsx` — `generate_ticket_number`
2. `src/pages/ARaging.tsx` — `get_customer_statement`, `get_detailed_statement_data` (×2), `get_ar_reminder_candidates`
3. `src/pages/Compliance.tsx` — `get_rup_sales_register`
4. `src/pages/CustomerDetail.tsx` — `get_fields_with_geojson`, `get_ar_aging`/`get_customer_statement`, `get_customer_year_end_summary`
5. `src/pages/FieldDetail.tsx` — `get_field_geojson`
6. `src/pages/Fields.tsx` — `get_fields_with_geojson`
7. `src/pages/InventoryPage.tsx` — `get_inventory_forecast`
8. `src/pages/NewOrder.tsx` — `check_customer_credit_limit`
9. `src/pages/QuoteBuilder.tsx` — `generate_quote_number`, `check_customer_credit_limit`
10. `src/pages/ReceivingLog.tsx` — `get_receiving_summary`, `get_receiving_log`
11. `src/pages/SalesReports.tsx` — `get_customer_farm_group`, `get_sales_detail_report`, `get_sales_summary_report`
12. `src/components/invoices/FinanceChargePreviewModal.tsx` — `preview_finance_charges`
13. `src/components/reports/LogbookReport.tsx` — dynamic RPC, `get_logbook_faa`
14. `src/components/team/TodaysDeliveries.tsx` — `get_team_board_deliveries`
15. `src/components/team/YesterdayRecap.tsx` — `get_yesterday_delivery_recap`
16. `src/components/team/WorkloadView.tsx` — `get_team_workload`
17. `src/components/team/RelatedNotes.tsx` — `get_notes_for_entity`
18. `src/components/team/CustomerContextCard.tsx` — `get_ar_aging`

**Files (idempotency — 5 violations):**

1. `src/components/fields/BulkFieldImport.tsx:346` — `save_field`
2. `src/components/fields/BulkFieldImport.tsx:358` — `save_field_geometry`
3. `src/pages/ReceivingLog.tsx:183` — `reverse_receiving_record`
4. `src/lib/notificationTriggers.ts:37` — `log_failed_notification`
5. `src/lib/notificationTriggers.ts:271` — `notify_damaged_receiving`

**Pattern for each fix:**

```typescript
// BEFORE:
const { data, error } = await supabase.rpc('some_rpc', { ... });
if (error) throw error;
setSomeState(data as SomeType[]);

// AFTER:
const { data, error } = await supabase.rpc('some_rpc', { ... });
if (error) throw error;
setSomeState(assertRpcResult<SomeType[]>(data, 'some_rpc'));
```

**Verification:** `npm run build && npm run test` — all 1,629 tests must pass.

---

### Phase 2: Local ESLint Plugin with 3 Custom Rules

**What:** Create `eslint-local-rules/` directory with custom rules. One npm dependency: `eslint-plugin-local-rules`.

**Directory structure:**
```
eslint-local-rules/
  index.js                        # Plugin entry point, exports all rules
  rules/
    require-assert-rpc-result.js  # Rule 1
    no-direct-sentry-import.js    # Rule 2
    no-console-warn.js            # Rule 3
```

**Rule 1: `local-rules/require-assert-rpc-result`** (error)
- Detects: `supabase.rpc(` calls where `data` is destructured and used (cast, set to state, accessed) without `assertRpcResult` in the same function scope
- Ignores: calls that only destructure `{ error }` (no data usage)
- Ignores: calls where data is checked with explicit null guard (`if (!data)`, `if (data === null)`)

**Rule 2: `local-rules/no-direct-sentry-import`** (error)
- Detects: `import * as Sentry from '@sentry/react'`
- Allows: files matching `sentry.ts`, `AuthContext.tsx`, `useOCRProcessor.ts`

**Rule 3: Tighten `no-console`** (no new rule needed)
- Change existing rule from `['warn', { allow: ['warn'] }]` to `['warn', { allow: [] }]`
- This blocks `console.warn` which is the last allowed console method

**Wiring into eslint.config.js:**
```javascript
import localRules from 'eslint-plugin-local-rules';

// Add to plugins:
'local-rules': localRules,

// Add to rules:
'local-rules/require-assert-rpc-result': 'error',
'local-rules/no-direct-sentry-import': 'error',
```

**Why this works everywhere:** The `eslint-local-rules/` folder is committed to git. After `git pull && npm install` on any machine, the rules are active. No per-machine config needed.

**Verification:** Run `npm run lint` — should report 0 errors (after Phase 1 fixes all violations). Then intentionally introduce a violation and verify the rule catches it.

---

### Phase 3: Make `logActivity` Type-Safe

**What:** Refactor `logActivity` from 6 positional string params to a single typed object.

**Before (fragile — easy to shift params):**
```typescript
export async function logActivity(
  eventType: string,
  description: string,
  performedBy: string,
  relatedEntityType?: string,
  relatedEntityId?: string,
  customerId?: string
)
```

**After (type-safe — impossible to shift):**
```typescript
interface LogActivityParams {
  event: string;
  description: string;
  performedBy: string;
  entityType?: string;
  entityId?: string;
  customerId?: string;
}

export async function logActivity(params: LogActivityParams)
```

**Migration pattern for all 57 call sites:**
```typescript
// BEFORE:
await logActivity('quote_saved', `Quote ${num} saved`, profile.id, 'quote', quoteId, customerId);

// AFTER:
await logActivity({ event: 'quote_saved', description: `Quote ${num} saved`, performedBy: profile.id, entityType: 'quote', entityId: quoteId, customerId });
```

**Implementation approach:**
1. Update the function signature in `activityLogger.ts`
2. Update all 57 call sites (mechanical — each is a single-line change)
3. TypeScript compiler will catch any mistakes (missing required `performedBy` = compile error)
4. Run build + tests

**Verification:** `npm run build` catches any call sites that weren't updated (TypeScript error). `npm run test` verifies behavior.

---

### Phase 4: Safety-Net Unit Tests

**What:** Add AST-scan tests that verify codebase patterns at test-time. These are a second enforcement layer — even if someone disables ESLint, the tests catch violations.

**Test 1: `tests/unit/lint-assert-rpc-result.test.ts`**
- Scans all `.tsx`/`.ts` files in `src/`
- Finds every `supabase.rpc(` call where data is used
- Verifies `assertRpcResult` appears in the same function
- Fails with a clear message listing violating files/lines

**Test 2: `tests/unit/lint-sentry-imports.test.ts`**
- Scans all `.tsx`/`.ts` files in `src/`
- Verifies no `import * as Sentry from '@sentry/react'` outside the 3 allowed files
- Fails with file paths if violated

**Test 3: `tests/unit/lint-logactivity-signature.test.ts`**
- Verifies `logActivity` in `activityLogger.ts` accepts a single object parameter (not positional strings)
- Prevents accidental revert to the old fragile signature

**These complement the existing safety-net tests:**
- `function-overload-detection.test.ts` (42 functions)
- `mutating-rpc-idempotency.test.ts` (28 RPCs)
- `security-definer-search-path.test.ts` (38 functions)

**Verification:** `npm run test` — all new tests pass alongside existing 1,629 tests.

---

## Phase Dependencies & Parallelism

```
Phase 1 (fix violations)     ─┐
Phase 2 (ESLint rules)       ─┼─ All 3 can run in PARALLEL
Phase 3 (logActivity refactor)─┘
                               │
                               ▼
Phase 4 (safety-net tests)    ── Must run AFTER 1-3 (tests verify clean state)
```

**Recommended execution:** Launch 3 agents in parallel for Phases 1-3, then one agent for Phase 4 after all complete.

---

## Multi-Machine / Claude Code Online Compatibility

Everything is committed code — no per-machine setup:

| Component | Location | How it syncs |
|-----------|----------|-------------|
| ESLint local rules | `eslint-local-rules/` in repo | `git pull` |
| eslint-plugin-local-rules | `package.json` devDependency | `npm install` |
| logActivity new signature | `src/lib/activityLogger.ts` | `git pull` |
| Safety-net tests | `tests/unit/lint-*.test.ts` | `git pull` |
| ESLint config changes | `eslint.config.js` | `git pull` |

**Setup on a new machine:** `git pull && npm install` — done. All enforcement is active.

---

## Success Criteria

After all 4 phases:
- [ ] 0 missing `assertRpcResult` calls (28 → 0)
- [ ] 0 missing idempotency keys (5 → 0)
- [ ] 3 custom ESLint rules blocking regressions at commit time
- [ ] `logActivity` uses typed object params (impossible to shift)
- [ ] `console.warn` blocked by lint (no-console tightened)
- [ ] 3 new safety-net unit tests passing
- [ ] `npm run build` clean, `npm run test` all pass, `npm run lint` 0 errors
- [ ] All docs updated (CHANGELOG.md, CLAUDE.md)

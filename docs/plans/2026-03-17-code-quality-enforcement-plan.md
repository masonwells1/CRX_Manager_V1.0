# Code Quality Enforcement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 28 remaining `assertRpcResult` violations + 5 idempotency gaps, add 3 ESLint rules to prevent regressions, make `logActivity` type-safe, and add safety-net unit tests.

**Architecture:** Local ESLint plugin (`eslint-local-rules/`) with 3 custom rules committed to the repo. `logActivity` refactored from 6 positional params to 1 typed object. Safety-net unit tests as a second enforcement layer.

**Tech Stack:** ESLint flat config, eslint-plugin-local-rules, TypeScript, Vitest

**Design doc:** `docs/plans/2026-03-17-code-quality-enforcement-design.md`

---

## Execution Strategy

Phases 1-3 are **fully independent** and can be run as **parallel agents**. Phase 4 depends on all three completing first.

```
Agent A: Phase 1 (fix violations)      ─┐
Agent B: Phase 2 (ESLint rules)        ─┼─ Run in PARALLEL
Agent C: Phase 3 (logActivity refactor)─┘
                                         │
                                         ▼
Agent D: Phase 4 (safety-net tests)     ── Run AFTER A+B+C complete
```

After Phase 4, a final agent does the commit + docs update.

---

## Phase 1: Fix All 28 `assertRpcResult` Violations + 5 Idempotency Gaps

### Task 1.1: Add `assertRpcResult` to page files (18 violations in src/pages/)

**Files to modify (each needs `assertRpcResult` added to its `import { supabase } from '../lib/db'` line AND wrapping data casts):**

**Reference — the pattern for each fix:**
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

**Step 1:** Fix `src/pages/ARaging.tsx` — 4 violations:
- Line ~356: `get_customer_statement` — `data as CustomerStatementRow[]` → wrap with assertRpcResult
- Line ~384: `get_detailed_statement_data` — `data as DetailedStatementData` → wrap
- Line ~430: `get_detailed_statement_data` (2nd call) — same pattern
- Line ~465: `get_ar_reminder_candidates` — data cast as array → wrap
- Add `assertRpcResult` to the import from `'../lib/db'`

**Step 2:** Fix `src/pages/CustomerDetail.tsx` — 3 violations:
- Line ~174: `get_fields_with_geojson` — `data as FieldGeoRow[]` → wrap
- Line ~259: `get_ar_aging` and `get_customer_statement` in Promise.all — wrap both results
- Line ~450: `get_customer_year_end_summary` — `data as unknown as YearEndSummaryData` → wrap
- Add `assertRpcResult` to the import from `'../lib/db'`

**Step 3:** Fix `src/pages/Compliance.tsx` — 1 violation:
- Line ~140: `get_rup_sales_register` — `data as RUPSalesRecord[]` → wrap
- Add `assertRpcResult` to import

**Step 4:** Fix `src/pages/FieldDetail.tsx` — 1 violation:
- Line ~121: `get_field_geojson` — data accessed without guard → wrap
- Add `assertRpcResult` to import

**Step 5:** Fix `src/pages/Fields.tsx` — 1 violation:
- Line ~57: `get_fields_with_geojson` — `data as unknown as FieldWithCustomer[]` → wrap
- Add `assertRpcResult` to import

**Step 6:** Fix `src/pages/InventoryPage.tsx` — 1 violation:
- Line ~366: `get_inventory_forecast` — `data as typeof forecastData` → wrap
- Add `assertRpcResult` to import (may already have it — check first)

**Step 7:** Fix `src/pages/NewOrder.tsx` — 1 violation:
- Line ~351: `check_customer_credit_limit` — data cast → wrap
- Add `assertRpcResult` to import (may already have it — check first)

**Step 8:** Fix `src/pages/QuoteBuilder.tsx` — 2 violations:
- Line ~285: `generate_quote_number` — `data as string` → wrap
- Line ~1338: `check_customer_credit_limit` — data cast → wrap
- `assertRpcResult` already imported — just add the wraps

**Step 9:** Fix `src/pages/ReceivingLog.tsx` — 2 violations:
- Line ~78: `get_receiving_summary` — `data as ReceivingSummary` → wrap
- Line ~105: `get_receiving_log` — `data as ReceivingRecord[]` → wrap
- Add `assertRpcResult` to import

**Step 10:** Fix `src/pages/SalesReports.tsx` — 3 violations:
- Line ~137: `get_customer_farm_group` — `data as FarmGroupMember[]` → wrap
- Line ~158: `get_sales_detail_report` — `data as SalesDetailRow[]` → wrap
- Line ~168: `get_sales_summary_report` — `data as SalesSummaryRow[]` → wrap
- Add `assertRpcResult` to import

### Task 1.2: Add `assertRpcResult` to component files (10 violations)

**Step 1:** Fix `src/components/blendtickets/ManualTicketCreate.tsx` — 1 violation:
- Line ~155: `generate_ticket_number` — `data as string` → wrap
- Add `assertRpcResult` to import from `'../../lib/db'`

**Step 2:** Fix `src/components/invoices/FinanceChargePreviewModal.tsx` — 1 violation:
- Line ~53: `preview_finance_charges` — `data as FinanceChargePreview[]` → wrap
- Add `assertRpcResult` to import (check if already present from prior session)

**Step 3:** Fix `src/components/reports/LogbookReport.tsx` — 2 violations:
- Line ~98: dynamic RPC — `data as LogbookRow[]` → wrap
- Line ~112: `get_logbook_faa` — `data as FAALogbookRow[]` → wrap
- Add `assertRpcResult` to import

**Step 4:** Fix `src/components/team/TodaysDeliveries.tsx` — 1 violation:
- Line ~105: `get_team_board_deliveries` — `data as unknown as TeamBoardDeliveryData` → wrap
- Add `assertRpcResult` to import

**Step 5:** Fix `src/components/team/YesterdayRecap.tsx` — 1 violation:
- Line ~23: `get_yesterday_delivery_recap` — `data as unknown as YesterdayRecapData` → wrap
- Add `assertRpcResult` to import

**Step 6:** Fix `src/components/team/WorkloadView.tsx` — 1 violation:
- Line ~44: `get_team_workload` — `data as TeamMemberWorkload[]` → wrap
- Add `assertRpcResult` to import

**Step 7:** Fix `src/components/team/RelatedNotes.tsx` — 1 violation:
- Line ~43: `get_notes_for_entity` — `data as TeamNote[] | null` → wrap (assertRpcResult handles the null)
- Add `assertRpcResult` to import

**Step 8:** Fix `src/components/team/CustomerContextCard.tsx` — 1 violation:
- Line ~47: `get_ar_aging` — data accessed without guard → wrap
- Add `assertRpcResult` to import

### Task 1.3: Add idempotency keys to 5 mutation RPC calls

**Step 1:** Fix `src/components/fields/BulkFieldImport.tsx`:
- Line ~346: `save_field` — add `p_idempotency_key: crypto.randomUUID()`
- Line ~358: `save_field_geometry` — add `p_idempotency_key: crypto.randomUUID()`
- NOTE: BulkFieldImport processes items in a loop, so generate keys per iteration

**Step 2:** Fix `src/pages/ReceivingLog.tsx`:
- Line ~183: `reverse_receiving_record` — add `useIdempotencyKey` hook + wire `p_idempotency_key`
- Import `useIdempotencyKey` from `'../hooks/useIdempotencyKey'`

**Step 3:** Fix `src/lib/notificationTriggers.ts`:
- Line ~37: `log_failed_notification` — add `p_idempotency_key: crypto.randomUUID()`
- Line ~271: `notify_damaged_receiving` — add `p_idempotency_key: crypto.randomUUID()`
- NOTE: These are fire-and-forget notification helpers, so inline UUID is appropriate (no retry)

### Task 1.4: Build + test to verify Phase 1

**Step 1:** Run TypeScript typecheck:
```bash
npm run typecheck
```
Expected: 0 errors

**Step 2:** Run build:
```bash
npm run build
```
Expected: clean build

**Step 3:** Run tests:
```bash
npm run test
```
Expected: all 1,629+ tests pass

**Step 4:** Commit:
```bash
git add -A
git commit -m "fix: add assertRpcResult to 28 RPC calls + 5 idempotency keys

Wraps all remaining RPC data casts with assertRpcResult() to catch
silent RLS denial. Adds p_idempotency_key to 5 mutation RPC calls.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 2: Local ESLint Plugin with Custom Rules

### Task 2.1: Install eslint-plugin-local-rules

**Step 1:** Install the package:
```bash
npm install --save-dev eslint-plugin-local-rules
```

**Step 2:** Verify it was added to package.json devDependencies.

### Task 2.2: Create the local rules directory and plugin entry

**Step 1:** Create `eslint-local-rules/index.js`:

```javascript
// eslint-local-rules/index.js
// Local ESLint rules for CRX Manager — committed to repo, works everywhere.
import requireAssertRpcResult from './rules/require-assert-rpc-result.js';
import noDirectSentryImport from './rules/no-direct-sentry-import.js';

export default {
  rules: {
    'require-assert-rpc-result': requireAssertRpcResult,
    'no-direct-sentry-import': noDirectSentryImport,
  },
};
```

### Task 2.3: Write Rule 1 — `require-assert-rpc-result`

**Create file:** `eslint-local-rules/rules/require-assert-rpc-result.js`

This rule detects `.rpc(` calls where `data` is destructured and used without `assertRpcResult` in the same scope.

```javascript
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require assertRpcResult() when using data from supabase.rpc() calls',
    },
    messages: {
      missingAssert:
        'RPC "{{ rpcName }}" data is used without assertRpcResult(). ' +
        'Supabase returns null (not an error) when RLS denies an RPC call. ' +
        'Wrap with: assertRpcResult<Type>(data, \'{{ rpcName }}\')',
    },
    schema: [],
  },
  create(context) {
    const scopeStack = [];

    function currentScope() {
      return scopeStack[scopeStack.length - 1];
    }

    function pushScope() {
      scopeStack.push({ rpcDataVars: new Map(), hasAssertCall: new Set() });
    }

    function popScope() {
      const scope = scopeStack.pop();
      if (!scope) return;
      for (const [varName, { node, rpcName }] of scope.rpcDataVars) {
        if (!scope.hasAssertCall.has(varName)) {
          context.report({ node, messageId: 'missingAssert', data: { rpcName } });
        }
      }
    }

    return {
      FunctionDeclaration() { pushScope(); },
      'FunctionDeclaration:exit'() { popScope(); },
      FunctionExpression() { pushScope(); },
      'FunctionExpression:exit'() { popScope(); },
      ArrowFunctionExpression() { pushScope(); },
      'ArrowFunctionExpression:exit'() { popScope(); },

      VariableDeclarator(node) {
        const scope = currentScope();
        if (!scope) return;

        const init = node.init;
        if (!init) return;

        const callExpr = init.type === 'AwaitExpression' ? init.argument : init;
        if (!callExpr || callExpr.type !== 'CallExpression') return;

        const callee = callExpr.callee;
        if (
          !callee ||
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'rpc'
        ) return;

        const rpcNameArg = callExpr.arguments[0];
        const rpcName =
          rpcNameArg && rpcNameArg.type === 'Literal'
            ? String(rpcNameArg.value)
            : '<dynamic>';

        if (node.id.type !== 'ObjectPattern') return;

        for (const prop of node.id.properties) {
          if (prop.type !== 'Property') continue;
          const key = prop.key;
          if (key.type === 'Identifier' && key.name === 'data') {
            const localName =
              prop.value.type === 'Identifier' ? prop.value.name : 'data';
            scope.rpcDataVars.set(localName, { node: prop, rpcName });
          }
        }
      },

      CallExpression(node) {
        const scope = currentScope();
        if (!scope) return;

        const callee = node.callee;
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'assertRpcResult') return;

        const firstArg = node.arguments[0];
        if (firstArg && firstArg.type === 'Identifier') {
          scope.hasAssertCall.add(firstArg.name);
        }
      },
    };
  },
};
```

### Task 2.4: Write Rule 2 — `no-direct-sentry-import`

**Create file:** `eslint-local-rules/rules/no-direct-sentry-import.js`

```javascript
const ALLOWED_FILES = ['sentry.ts', 'AuthContext.tsx', 'useOCRProcessor.ts'];

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct import from @sentry/react — use lib/sentry wrapper instead',
    },
    messages: {
      noDirectImport:
        "Import Sentry from '../lib/sentry' (or appropriate relative path) instead of " +
        "'@sentry/react'. The wrapper ensures consistent initialization and re-export.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== '@sentry/react') return;

        const filename = context.getFilename();
        const isAllowed = ALLOWED_FILES.some((f) => filename.endsWith(f));
        if (isAllowed) return;

        context.report({ node, messageId: 'noDirectImport' });
      },
    };
  },
};
```

### Task 2.5: Wire rules into eslint.config.js

**Modify:** `eslint.config.js`

Add import at top:
```javascript
import localRules from 'eslint-plugin-local-rules';
```

Add to plugins object:
```javascript
'local-rules': localRules,
```

Add to rules object:
```javascript
'local-rules/require-assert-rpc-result': 'error',
'local-rules/no-direct-sentry-import': 'error',
```

Also tighten the existing `no-console` rule:
```javascript
// BEFORE:
'no-console': ['warn', { allow: ['warn'] }],

// AFTER:
'no-console': ['warn', { allow: [] }],
```

### Task 2.6: Verify ESLint rules work

**Step 1:** Run lint — should pass (Phase 1 already fixed all violations):
```bash
npm run lint
```
Expected: 0 errors from local-rules (existing warnings from autoFocus are fine)

**Step 2:** Create a temporary test file to verify rules catch violations:
- Create a temp file with `import * as Sentry from '@sentry/react'` — verify `no-direct-sentry-import` fires
- Create a temp file with `.rpc('test')` data cast without assertRpcResult — verify `require-assert-rpc-result` fires
- Delete the temp file after verification

**Step 3:** Commit:
```bash
git add eslint-local-rules/ eslint.config.js package.json package-lock.json
git commit -m "feat: add local ESLint rules to enforce code quality patterns

Three rules:
- require-assert-rpc-result: blocks .rpc() data usage without assertRpcResult()
- no-direct-sentry-import: blocks direct @sentry/react imports
- no-console tightened: console.warn no longer allowed

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 3: Make `logActivity` Type-Safe

### Task 3.1: Refactor the function signature

**Modify:** `src/lib/activityLogger.ts`

Replace the old positional signature with a typed object:

```typescript
// NEW interface (add above the function):
export interface LogActivityParams {
  event: string;
  description: string;
  performedBy: string;
  entityType?: string;
  entityId?: string;
  customerId?: string;
}

// NEW function signature:
export async function logActivity(params: LogActivityParams) {
  try {
    const { error: logErr } = await supabase.from('activity_feed').insert({
      event_type: params.event,
      description: params.description,
      performed_by: params.performedBy,
      related_entity_type: params.entityType || null,
      related_entity_id: params.entityId || null,
      customer_id: params.customerId || null,
    });
    if (logErr) Sentry.captureException(logErr, { tags: { source: 'activity_logger', action: 'log_activity' } });
  } catch (err) {
    Sentry.captureException(err, { tags: { source: 'activity_logger', action: 'log_activity' } });
  }
}
```

### Task 3.2: Update all 57 call sites

**The transformation for every call is mechanical:**

```typescript
// BEFORE (6 positional args):
await logActivity('quote_saved', `Quote ${num} saved`, profile.id, 'quote', quoteId, customerId);

// AFTER (single object):
await logActivity({ event: 'quote_saved', description: `Quote ${num} saved`, performedBy: profile.id, entityType: 'quote', entityId: quoteId, customerId });
```

**For calls with only 3 args (no optional params):**
```typescript
// BEFORE:
await logActivity('settings_updated', 'Updated user profile', profile.id);

// AFTER:
await logActivity({ event: 'settings_updated', description: 'Updated user profile', performedBy: profile.id });
```

**Files with logActivity calls (57 total across 23 files):**

| File | Calls |
|------|-------|
| `src/pages/QuoteBuilder.tsx` | 4 |
| `src/pages/Reports.tsx` | 1 |
| `src/pages/InventoryPage.tsx` | 1 |
| `src/pages/Rebates.tsx` | 5 |
| `src/pages/CycleCounts.tsx` | 3 |
| `src/pages/OrderDetail.tsx` | 2 |
| `src/pages/DeliveryDetail.tsx` | 2 |
| `src/pages/InvoiceDetail.tsx` | 2 |
| `src/pages/NewDelivery.tsx` | 2 |
| `src/pages/SettingsPage.tsx` | 4 |
| `src/pages/BlendTicketDetail.tsx` | 3 |
| `src/pages/JobDetail.tsx` | 4 |
| `src/pages/PurchaseOrderDetail.tsx` | 2 |
| `src/pages/Returns.tsx` | 6 |
| `src/pages/ARaging.tsx` | 2 |
| `src/pages/CropPrograms.tsx` | 2 |
| `src/pages/Products.tsx` | 1 |
| `src/pages/ProductDetail.tsx` | 3 |
| `src/pages/Compliance.tsx` | 1 |
| `src/pages/VehicleDetail.tsx` | 2 |
| `src/components/purchase-orders/BulkPOImport.tsx` | 1 |
| `src/components/inventory/BatchAdjustModal.tsx` | 1 |
| `src/components/blendtickets/ManualTicketCreate.tsx` | 1 |

**Strategy:** Read each file, find all `logActivity(` calls, transform each from positional to object syntax. TypeScript compiler will catch any you miss — required `performedBy` field causes compile error if missing.

### Task 3.3: Update test mocks

Search for any test files that mock `logActivity`:
```
grep -r "logActivity" src/ --include="*.test.*"
```
Update any mock implementations to match the new single-param signature.

### Task 3.4: Build + test to verify Phase 3

**Step 1:** Run TypeScript typecheck (catches any missed call sites — "Expected 1 arguments, but got 3-6"):
```bash
npm run typecheck
```
Expected: 0 errors

**Step 2:** Run build:
```bash
npm run build
```
Expected: clean build

**Step 3:** Run tests:
```bash
npm run test
```
Expected: all tests pass

**Step 4:** Commit:
```bash
git add src/lib/activityLogger.ts src/pages/ src/components/
git commit -m "refactor: logActivity now takes typed object param

Changes from 6 positional string params to single LogActivityParams
object. Makes parameter-shift bugs structurally impossible — TypeScript
catches missing required fields at compile time.

Updated all 57 call sites across 23 files.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 4: Safety-Net Unit Tests (run AFTER Phases 1-3)

### Task 4.1: Write test — assert-rpc-result coverage

**Create file:** `src/lib/assertRpcCoverage.test.ts`

This test scans all source files for `.rpc(` calls where data is used without `assertRpcResult`. Same pattern as existing `schemaIntegrity.test.ts`.

```typescript
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !entry.includes('node_modules') && !entry.includes('.test')) {
      results.push(...findSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('assertRpcResult coverage', () => {
  it('every supabase.rpc() call that uses data must call assertRpcResult', () => {
    const srcDir = join(__dirname, '..');
    const files = findSourceFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const rpcPattern = /\{\s*data[^}]*\}\s*=\s*await\s+supabase\.rpc\(\s*['"]([^'"]+)['"]/g;
      let match;

      while ((match = rpcPattern.exec(content)) !== null) {
        const rpcName = match[1];
        if (!content.includes('assertRpcResult')) {
          const lineNum = content.substring(0, match.index).split('\n').length;
          const relPath = file.replace(srcDir, 'src');
          violations.push(
            `${relPath}:${lineNum} — ${rpcName} data used without assertRpcResult`
          );
        }
      }
    }

    expect(
      violations,
      `Found ${violations.length} RPC calls without assertRpcResult:\n${violations.join('\n')}`
    ).toHaveLength(0);
  });
});
```

### Task 4.2: Write test — Sentry import enforcement

**Create file:** `src/lib/sentryImportEnforcement.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ALLOWED_FILES = ['sentry.ts', 'AuthContext.tsx', 'useOCRProcessor.ts'];

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !entry.includes('node_modules')) {
      results.push(...findSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Sentry import enforcement', () => {
  it('no files import directly from @sentry/react except allowed exceptions', () => {
    const srcDir = join(__dirname, '..');
    const files = findSourceFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const isAllowed = ALLOWED_FILES.some((f) => file.endsWith(f));
      if (isAllowed) continue;

      const content = readFileSync(file, 'utf-8');
      if (
        content.includes("from '@sentry/react'") ||
        content.includes('from "@sentry/react"')
      ) {
        const relPath = file.replace(srcDir, 'src');
        violations.push(relPath);
      }
    }

    expect(
      violations,
      `Found ${violations.length} files importing directly from @sentry/react:\n` +
        violations.join('\n')
    ).toHaveLength(0);
  });
});
```

### Task 4.3: Write test — logActivity signature verification

**Create file:** `src/lib/logActivitySignature.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('logActivity signature safety', () => {
  it('logActivity accepts a single object param, not positional strings', () => {
    const filePath = join(__dirname, 'activityLogger.ts');
    const content = readFileSync(filePath, 'utf-8');

    expect(content).toContain('interface LogActivityParams');
    expect(content).toContain('params: LogActivityParams');

    // Verify old positional signature is gone
    expect(content).not.toMatch(/logActivity\(\s*eventType:\s*string/);
    expect(content).not.toMatch(/logActivity\(\s*\n\s*eventType:\s*string/);
  });

  it('LogActivityParams has required performedBy field', () => {
    const filePath = join(__dirname, 'activityLogger.ts');
    const content = readFileSync(filePath, 'utf-8');

    // performedBy must be required (no ? mark)
    expect(content).toMatch(/performedBy:\s*string\s*[;,]/);
    expect(content).not.toMatch(/performedBy\?:\s*string/);
  });
});
```

### Task 4.4: Run all tests to verify safety-net tests pass

**Step 1:** Run full test suite:
```bash
npm run test
```
Expected: all tests pass including the 3 new safety-net tests

**Step 2:** Commit:
```bash
git add src/lib/assertRpcCoverage.test.ts src/lib/sentryImportEnforcement.test.ts src/lib/logActivitySignature.test.ts
git commit -m "test: add safety-net tests for code quality enforcement

3 new tests that scan the codebase at test-time:
- assertRpcCoverage: every .rpc() data usage has assertRpcResult
- sentryImportEnforcement: no direct @sentry/react imports
- logActivitySignature: logActivity uses typed object params

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Phase 5: Final Integration + Docs

### Task 5.1: Run full build + lint + test pipeline

```bash
npm run lint && npm run build && npm run test
```
Expected: all green — 0 lint errors, clean build, all tests pass

### Task 5.2: Update documentation

**Modify `docs/CHANGELOG.md`** — add entry at top:

```markdown
## 2026-03-17 — Code Quality Enforcement (Phase 1-4)

### assertRpcResult Final Sweep (28 violations → 0)
- Added assertRpcResult() to all remaining RPC data casts across 18 files
- Files: ARaging, CustomerDetail, Compliance, FieldDetail, Fields, InventoryPage,
  NewOrder, QuoteBuilder, ReceivingLog, SalesReports, ManualTicketCreate,
  FinanceChargePreviewModal, LogbookReport, TodaysDeliveries, YesterdayRecap,
  WorkloadView, RelatedNotes, CustomerContextCard

### Idempotency Key Gaps (5 → 0)
- Added p_idempotency_key to: BulkFieldImport (save_field, save_field_geometry),
  ReceivingLog (reverse_receiving_record), notificationTriggers
  (log_failed_notification, notify_damaged_receiving)

### Local ESLint Plugin (3 rules)
- `require-assert-rpc-result`: blocks .rpc() data usage without assertRpcResult()
- `no-direct-sentry-import`: blocks direct @sentry/react imports
- `no-console` tightened: console.warn no longer allowed
- Lives in `eslint-local-rules/` — works on all machines via git pull

### logActivity Type Safety
- Refactored from 6 positional string params to single typed object (LogActivityParams)
- Updated all 57 call sites across 23 files
- TypeScript compiler now catches parameter-shift bugs

### Safety-Net Unit Tests (+3 tests)
- assertRpcCoverage.test.ts — scans for .rpc() calls without assertRpcResult
- sentryImportEnforcement.test.ts — scans for direct @sentry/react imports
- logActivitySignature.test.ts — verifies logActivity uses typed object params
```

**Modify `CLAUDE.md`** — update Current State section:
- Update test count (1,629 → 1,632+)
- Add note about ESLint local rules under Architecture Rules
- Update "All mutation RPCs use assertRpcResult()" to reflect 100% coverage

### Task 5.3: Push to remote

```bash
git push
```

---

## Summary of All Deliverables

| Deliverable | Files | Type |
|-------------|-------|------|
| 28 assertRpcResult fixes | 18 files in src/ | Bug fix |
| 5 idempotency key fixes | 3 files | Bug fix |
| ESLint local plugin | `eslint-local-rules/` (4 files) | Prevention |
| ESLint config update | `eslint.config.js` | Prevention |
| logActivity refactor | `activityLogger.ts` + 23 consumer files | Prevention |
| Safety-net tests | 3 new test files | Prevention |
| Documentation | CHANGELOG.md, CLAUDE.md | Docs |

**Total estimated files changed:** ~50
**New files created:** ~7

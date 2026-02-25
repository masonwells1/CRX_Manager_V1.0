# Test Coverage Expansion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all HIGH and MEDIUM priority test coverage gaps identified in gap analysis — adding ~200-300 new tests across 13 new test files.

**Architecture:** Unit tests use jsPDF mock pattern from `statementPdf.test.ts`. E2E tests use two patterns: serial lifecycle (shared state + `test.describe.serial`) for workflow tests, and independent tests with `login()` in `beforeEach` for CRUD page tests.

**Tech Stack:** Vitest + jsPDF mocks (unit), Playwright (E2E), Supabase production data

---

## Unit Tests (3 files)

### Task 1: `src/lib/invoicePdf.test.ts`
Tests for 3 layout modes, shares, finance charges, batch generation, edge cases.
Pattern: Same mockDoc as `statementPdf.test.ts`. Factory: `makeInvoiceData(overrides)`.

### Task 2: `src/lib/receivingPdf.test.ts`
Tests for condition colors, batch multi-page, edge cases.
Pattern: Same mockDoc. Factory: `makeReceivingData(overrides)`.

### Task 3: `src/lib/reportHelpers.test.ts`
Tests for `getPresetDates()` season boundaries and date range logic.

## E2E Tests (10 files)

### Task 4: `tests/e2e/workflow-job-lifecycle.spec.ts` (SERIAL)
Create job → assign applicator/vehicle/chemicals → complete with applied info → transfer to invoice.

### Task 5: `tests/e2e/workflow-rebate-lifecycle.spec.ts` (SERIAL)
Create program → create claim → advance: pending → submitted → approved → paid.

### Task 6: `tests/e2e/workflow-recipe-to-job.spec.ts` (SERIAL)
Create recipe with items → load into job → verify chemicals populated.

### Task 7: `tests/e2e/workflow-write-off.spec.ts` (SERIAL)
Post invoice → apply write-off → verify balance update.

### Task 8: `tests/e2e/compliance-crud.spec.ts` (INDEPENDENT)
License CRUD, expiry filtering, RUP products tab.

### Task 9: `tests/e2e/customer-transactions.spec.ts` (INDEPENDENT)
Select customer, verify data loads, date range, export.

### Task 10: `tests/e2e/reports-functional.spec.ts` (INDEPENDENT)
Tab navigation, date presets, data loading, CSV export per category.

### Task 11: `tests/e2e/blend-recipes-crud.spec.ts` (INDEPENDENT)
Recipe CRUD, duplicate, filter by type/crop.

### Task 12: `tests/e2e/vehicles-crud.spec.ts` (INDEPENDENT)
Vehicle create, edit, detail page, delete.

### Task 13: `tests/e2e/month-end-close.spec.ts` (INDEPENDENT)
Checklist display, statement generation, period status.

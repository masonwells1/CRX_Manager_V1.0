# Real UI Interaction E2E Tests — Design Doc

**Date:** 2026-02-25
**Scope:** 10 Playwright E2E test files (~95 tests) covering untested real UI interactions
**Goal:** Exercise actual button clicks, form fills, modal opens, and state changes on pages that have only been "page loads" tested

## Problem

Existing E2E tests fall into two categories:
1. **Workflow tests** — prove end-to-end business flows work (quote→order→delivery→invoice)
2. **Page load tests** — verify pages render without errors

Neither category tests **real UI interactions** on individual pages: opening modals, filling forms, toggling edit modes, clicking action buttons, verifying state transitions. These are where production bugs hide — broken selectors, missing modals, form validation that doesn't fire, buttons that don't appear for certain roles.

## Design

### Deep Coverage (3 files, ~38 tests)

#### `quote-builder-interactions.spec.ts` — 14 tests
Tests the 52KB QuoteBuilder component: customer selection, section management, product search modal, item editing (qty/price/totals), commission splits, notes, save/reload, PDF download, unsaved changes warning.

#### `delivery-detail-interactions.spec.ts` — 13 tests
Tests the 1,350-line DeliveryDetail: edit mode (driver/date/priority/notes), cancel modal with reason, confirm delivery flow (StartDeliveryModal), photo upload, issue reporting dropdown, complete delivery button, PDF download, order context columns.

#### `invoice-detail-interactions.spec.ts` — 11 tests
Tests InvoiceDetail lifecycle: add product, edit items, save, post/unpost toggle, void with reason, write-off modal, print dialog layout options, record payment, header/footer notes.

### Standard Coverage (7 files, ~57 tests)

#### `customer-detail-interactions.spec.ts` — 9 tests
Edit profile, credit limit, commission splits, purchase history, Year-End PDF, tier badge, navigation.

#### `product-detail-interactions.spec.ts` — 9 tests
Edit fields, tier pricing, update cost modal, cost history, RUP/signal word, product form, create new product.

#### `order-detail-interactions.spec.ts` — 8 tests
Edit mode, line item editing, save, status change modal, schedule delivery button, KPI grid.

#### `settings-interactions.spec.ts` — 8 tests
Company info edit, user management table, edit user role, page access permissions, default settings, Add User modal.

#### `notifications-interactions.spec.ts` — 6 tests
Notification cards, unread indicators, Mark All Read, click-to-navigate, empty state.

#### `team-board-interactions.spec.ts` — 10 tests
Create note/todo/announcement, detail modal, comments, mark complete, search filter, My Tasks tab, Activity tab.

#### `inline-editing-interactions.spec.ts` — 7 tests
Edit mode toggle, cell editing, dirty row highlight, save with count, cancel discard, column sort, search in edit mode.

## Test Patterns

- `login(page)` via shared auth helper in `beforeEach`
- `page.on('dialog', d => d.accept())` for window.confirm() dialogs
- `test.skip(!state.xxx, 'dependency')` for serial chains
- `.catch(() => false)` for optional element visibility checks
- Generous timeouts (5000-15000ms) for async loads
- UnsavedChangesModal handler (try/catch "Leave" button click)
- `page.getByLabel()`, `page.getByRole()`, `page.locator('button:has-text()')` selectors

## Success Criteria

- All ~95 tests pass against live Supabase
- Zero regressions in existing 506 E2E tests
- No new test creates or mutates production data unsafely (use unique RUN_ID identifiers)

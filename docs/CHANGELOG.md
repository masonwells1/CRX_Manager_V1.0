# CRX Manager V1.0 — Development Changelog

All significant development milestones, in reverse chronological order.

---

## 2026-02-27 — Business Logic Audit Fixes
- SQL migration `20260312200000`: inventory hold auto-release trigger (declined/expired/accepted), `post_invoice()` period enforcement, `save_customer()` commission split validation, `create_quick_delivery()` inventory pre-check with FOR UPDATE locks, `convert_quote_to_order()` explicit hold release
- Added `checkMutationResult()` silent RLS failure detection on 13 pages
- Offline sync conflict detection via `snapshotAt` / `entityTable` / `entityId` fields
- Realtime subscription `disabled` prop — prevents null-filter subscriptions
- InventoryPage `freeQty` formula fix (subtracts prebooked from available)
- Updated 3 test files (offlineSync, useRealtimeSubscription, businessLogicEnhancements) — 1,121 tests all passing
- Commits: `f1278ab`

## 2026-02-25 — Test Suite Audit & Coverage Expansion
- Audited all 67 unit test files — zero stale imports, zero dead tests
- Removed duplicate `pdfGeneration.test.ts` (894 lines, duplicated by 3 individual PDF test files)
- Added 11 new unit test files: SignatureCanvas, ActivityFeed, CommentsSection, 8 bulk import components
- Net result: 80 test files, 1,121 unit tests (all passing)
- 60 math & business logic verification E2E tests
- 95 real UI interaction E2E tests across 10 pages
- 14 new test files closing coverage gaps (47 unit + 68 E2E tests)
- Fixed 41 of 42 pre-existing E2E test failures
- Commits: `fdaa08c`, `5bc6213`, `447576f`, `7527206`

## 2026-02-24 — Test Coverage Gap Closure (8 sprints)
- Sprint 1: reportPdf.test.ts + deliveryPdf.test.ts (35 tests)
- Sprint 2: offlineQueue.test.ts (30 tests, fake-indexeddb)
- Sprint 3: useUnsavedChanges, useRealtimeSubscription, useOCRProcessor hooks (40 tests)
- Sprint 4: AuthContext.test.tsx (30 tests)
- Sprint 5-6: 9 modal test files (90 tests)
- Sprint 7: imageCompression + sentry (25 tests)
- Sprint 8: bulk-operations.spec.ts E2E (31 tests)
- Fixed login() helper in tests/e2e/utils/auth.ts for session persistence
- Commit: `6fe06a0`

## 2026-02-24 — useRowSelection Bug Fix
- Fixed infinite re-render loop — useEffect compared data by reference (always new)
- Removed broken useEffect, derived selectedCount from selectedRows.length
- Commit: `12ec850`

## 2026-02-24 — Bulk Select/Delete/CSV/PDF Export
- Session 1 (6 pages): Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets
- Session 2 (9 pages): Orders, Vehicles, Fields, Returns, ReceivingLog, InventoryPage, Invoices, Deliveries, Payments
- Pattern: useRowSelection → createCheckboxColumn → BulkActionBar → BulkDeleteConfirmModal
- Soft delete for Returns/Invoices, hard delete for others
- 12 files changed, 824 insertions, 111 deletions
- Commits: `d52d910`, `f571196`

## 2026-02-23 — TypeScript Strict Type Cleanup
- Fixed all 148 TypeScript strict type errors → 0 remaining
- Key fixes: Supabase join casts, jsPDF types, React Router v7 Blocker, DataTable generics
- Removed `continue-on-error: true` from CI — typecheck now enforced
- Commit: `6a98a92`

## 2026-02-23 — CI Pipeline Fix
- Fixed 47 ESLint errors blocking CI
- Updated ESLint config: `varsIgnorePattern: '^_'`
- Fixed Vitest CI crash with Supabase env var fallbacks
- Added `npm run lint` to pre-commit hook
- CI now GREEN — all 4 steps pass
- Commits: `73d779e`, `a97882d`, `af90ebf`

## 2026-02-23 — Documentation Cleanup
- Removed 17 stale .md files from repo
- Rewrote README.md with accurate stats
- Added Feature Inventory table to CLAUDE.md
- Fixed stale references across CLAUDE.md, TESTING.md, DEPLOYMENT.md

## 2026-02-23 — Lint Cleanup
- Eliminated all 507 ESLint errors → 0 remaining
- 95 files changed: catch(err: any) → catch(err: unknown), typed all `any`, removed unused imports
- Commit: `22f9c86`

## 2026-02-23 — Codebase Audit & Hardening
- Sprint A: 4 new test files + 17 convertToGlLb tests
- Sprint B: Defensive null guards in quoteCalc, deliveryPdf, invoicePdf, etc.
- Sprint C: 7 uncaught promise chains fixed, AuthContext session hardening
- Sprint D: Security hardening in pagePermissions, notificationTriggers, realtime, queries
- Sprint E: Lint/formatting cleanup
- 24 files changed, 1,267 lines added/changed
- Commit: `9b3d70b`

## 2026-03-04 — Quick Receive Feature
- 3-step wizard: vendor+products → auto-match to oldest open POs → confirm
- `match_quick_receive_items()` RPC

## 2026-02-28 to 2026-03-03 — Safety Audit & Business Logic Hardening
- Page permissions, notification triggers, E2E gate tests

## 2026-02-27 — Sprint 20: Delivery Integrity & Quick Delivery
- Two-step confirm→complete flow, items locked to order, quick delivery modal
- `create_quick_delivery()` atomic RPC

## 2026-02-26 — Sprint 19: Receiving System Enhancement
- Per-item receiving (condition/lot/notes), receiving dashboard, receiving PDF

## 2026-02-25 — Sprint 18: Delivery System Enhancement
- Edit/cancel/reassign, driver issue reporting, photos (10 max), delivery remainders, batch cancel

## 2026-02-24 — Sprint 17: Year-End Customer Summary
- PDF: financials, products, acreage, YoY comparison

## 2026-02-23 — Sprint 16: Unified Payment Allocation
- New PaymentAllocation page, auto-allocate, prepay application

## 2026-02-22 — Sprint 15: Batch Operations
- Batch void, batch print, batch statements, auto-apply prepayments

## 2026-02-21 — Sprint 14: Grower Share Transparency
- Per-grower $/acre pricing in quote builder

## 2026-02-20 — Sprint 13: Finance Charge Intelligence
- Preview, grace periods, opt-out per customer

## 2026-02-19 — Sprint 12: Invoice & Statement PDF Redesign
- 3 invoice layouts, dual-mode statements, matching Chem-Man format

## 2026-02-17 — T3-002: Comprehensive Test Coverage
- 766 unit tests (45 files) + 31 E2E spec files

## 2026-02-17 — OCR Parser Overhaul & Edge Function v4
- Multi-line field support, look-behind value matching

## 2026-02-16 — Bulk Field Import
- Shapefile/KML/GeoJSON wizard with proj4 reprojection

## 2026-02-14 to 2026-02-18 — Sprints 7-11: CheMan Gap Closure
- Vehicles, Jobs, Application Records, Reports (14 total), Month-End Close, Commission Payments, Financial Workflows

## 2026-02-13 — Phase 4B: Mapbox Maps
- Satellite imagery, field polygon drawing, acreage auto-calc

## 2026-02-11 — 109-Defect Forensic Audit Fix (Sprints 0-6)
- Fixed all 109 defects from Claude forensic audit

## Earlier — Foundation
- Tier 1-3 hardening complete
- ChatGPT audit (18 issues) complete
- Initial build by Bolt, then claimed by user

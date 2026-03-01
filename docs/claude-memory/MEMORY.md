# CRX Manager V1.0 — Agent Memory

> **Last updated:** 2026-03-01 | **Commit:** `88b6086` (E2E coverage sprint — 23 new spec files)

## Project

- **Repo:** `C:\Users\mason\CRX_Manager_V1.0` | GitHub: `masonwells1/CRX_Manager_V1.0`
- **Production:** https://croprxsolutions.app (Vercel: `mason-wells-projects` / `crx-manager-v1-0`)
- **Supabase:** `rhyzpcqhnizqbxphqdkr`
- **Owner:** Mason Wells (`masonwells1`) — beginner, explain simply
- **Git identity:** `Mason Wells` / `253580866+masonwells1@users.noreply.github.com`

## Environment (this machine)

- Windows 11, Git Bash shell
- Node `v24.13.0`, npm `11.6.2`, Git `v2.53.0`
- `tail` NOT available — don't pipe to tail
- PATH each session: `export PATH="$PATH:/c/Program Files/GitHub CLI:/c/Program Files/nodejs"`

## .env (not in Git)

```
VITE_SUPABASE_URL=https://rhyzpcqhnizqbxphqdkr.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoeXpwY3Fobml6cWJ4cGhxZGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTM2NDAsImV4cCI6MjA4NTk2OTY0MH0.WR0vAi_KeGF0OoJ8_dFH7uW6ael9M5xnm6OUo2IZy7U
VITE_MAPBOX_TOKEN=pk.eyJ1IjoibWFzb253ZWxscyIsImEiOiJjbWxsZGE4dTgwNXoyM2VxODR0dHF3ZXYxIn0.JubjJcu7eYRERoywCEXVLQ
VITE_SENTRY_DSN=https://56f8c13aa4e79e8d2849aba1dcfffb13@o4510932832616448.ingest.us.sentry.io/4510932858175488
E2E_TEST_EMAIL=mason@croprxsolutions.com
E2E_TEST_PASSWORD=Mwells0413
```

## Current State

- **Branch:** `main` (all feature branches merged; E2E sprint on `claude/add-playwright-tests-DjMo6`)
- **Commit:** `88b6086` — E2E coverage sprint: 23 new spec files (165 tests)
- **Pages:** 50 | **Migrations:** 92 local SQL files | **Edge Functions:** 5
- **Unit tests:** 1,380 passing (88 files) | **E2E specs:** 84 files (589 tests, all passing)
- **Build:** clean | **CI:** green | **Pre-commit:** lint + build + vitest
- **Husky hooks:** pre-commit (lint+build+test) + pre-push
- **Dependabot:** configured for npm + GitHub Actions

## Recent Changes (since Feb 25)

### E2E Coverage Sprint (branch `claude/add-playwright-tests-DjMo6`, 3 commits)
- 23 new Playwright E2E spec files with 165 test cases, all passing
- Part 1 — 5 new feature specs (43 tests): prepayment-manager-crud, prepay-workspace, tote-tracking, rup-compliance-warnings, finance-charge-fix
- Part 2 — 18 uncovered page specs (122 tests): ar-aging, application-records, commission-payments-crud, crop-programs, cycle-counts, delivery-remainders, quick-receive, returns-crud, rebates-page, new-delivery-page, new-order-page, new-purchase-order, purchase-order-detail, invoice-list-page, field-detail, job-detail, vehicle-detail, inventory-page
- Total E2E: 84 spec files, 589 tests

### Audit Remediation (branch `feature/audit-remediation`, 10 commits, merged to main)
- **Phase 0:** Finance charge compounding fix (exclude prior charges), billing split `FOR UPDATE` locks
- **Phase 1:** Tote tracking — `tote_number` + `is_non_returnable` on delivery_items, threaded through RPCs, UI on NewDelivery/DeliveryDetail/PDF
- **Phase 2:** RUP compliance — `rupCompliance.ts` (6 tests), warning banners on 4 pages, audit logging, Compliance filter chips with count badges
- **Phase 3:** Prepay buckets — `bucket_label` column, `apply_prepay_to_invoice()` + `batch_apply_prepayments()` RPCs, PrepayWorkspace page, Split Check modal
- **New page:** `/prepay-workspace` (PrepayWorkspace) — split-panel allocator with two-phase commit
- **New lib:** `src/lib/rupCompliance.ts` — RUP compliance checker
- **5 new migrations:** 20260301000000 through 20260301200001

### Go-Live Hardening (branch `feature/go-live-hardening`, 13 commits, merged)
- Idempotency keys, server-authoritative quote math, notification failure tracking
- Delivery signature privacy, RLS contract tests, schema integrity tests
- `runCriticalAction()` shared helper, ESLint exhaustive-deps fixes, E2E CI
- Operational metrics (Sentry), cross-entity reconciliation checks

### Earlier (Feb 25-27)
- `Payments.tsx` DELETED — `PaymentAllocation` is sole payment page at `/payments`
- AR derived from invoices only (orders.total_paid/balance_due deprecated)
- `checkMutationResult()` on 13 pages, offline sync conflict detection
- Dependabot + Husky + `.nvmrc` + `.claude/settings.json` added

## Where to Find Things

All architecture, patterns, red lines, and business logic are in **CLAUDE.md** (loaded automatically).
Detailed reference docs are in the repo — read on demand:

| Need | Read |
|------|------|
| Database tables & RLS | `docs/reference/database-schema.md` |
| RPC signatures | `docs/reference/rpc-functions.md` |
| Migration list | `docs/reference/migration-history.md` |
| Page routes | `docs/reference/pages-routes.md` |
| Code patterns | `docs/reference/code-patterns.md` |
| QA/testing | `docs/reference/qa-testing.md` |
| Sprint history | `docs/CHANGELOG.md` |
| Workflow guides | `docs/workflows/SAFE_DEVELOPMENT_RULES.md` (read every session) |

## Archive (historical decision records)

These files in this memory directory record WHY certain decisions were made:
- `audit-findings-2026-02-18.md` — 18 findings from production readiness audit
- `migration-history.md` — Narrative of all 92 migrations and their purpose
- `sprint-audit-details.md` — S18-S20 features + safety audit technical details

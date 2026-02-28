# CRX Manager V1.0 — Agent Memory

> **Last updated:** 2026-02-28 | **Commit:** `91314c4` (Go-live hardening complete — 5 sprints)

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

- **Branch:** `feature/go-live-hardening` (ready for merge to main)
- **Commit:** `91314c4` — Sprint 5b: Cross-entity reconciliation checks
- **Pages:** 48 | **Migrations:** 83 local SQL files | **Edge Functions:** 5
- **Unit tests:** 1,374 passing (87 files) | **E2E specs:** 61 files
- **Build:** clean | **CI:** green | **Pre-commit:** lint + build + vitest
- **Husky hooks:** pre-commit (lint+build+test) + pre-push
- **Dependabot:** configured for npm + GitHub Actions

## Recent Changes (since Feb 25)

### Go-Live Hardening (branch `feature/go-live-hardening`, 13 commits)
- **Sprint 1a:** `crypto.randomUUID` for idempotency keys, retry-safe `useIdempotentAction` hook, `db.ts` multi-tab session recovery
- **Sprint 1b:** Server-authoritative quote math via `calculate_quote_totals()` RPC using `NUMERIC(15,4)` precision
- **Sprint 2:** Notification failure tracking (`failed_at`, `retry_count`), read-path error handling with silent fallback
- **Sprint 3a:** Delivery signature privacy — signed URLs via `create_signed_url()` RPC, no more public bucket access
- **Sprint 3b:** RLS integration contract tests — per-role verification for orders/invoices/deliveries/commissions
- **Sprint 3c:** Schema integrity live DB tests — FK constraints, enum values, generated columns, RLS enabled
- **Sprint 4a:** Shared `runCriticalAction()` helper — replaces scattered try/catch with consistent error handling + toast
- **Sprint 4b:** Fixed all `react-hooks/exhaustive-deps` ESLint warnings across codebase
- **Sprint 4c:** E2E smoke tests in CI workflow, fixed TDZ declaration ordering issues
- **Sprint 5a:** Operational metrics via `src/lib/metrics.ts` — Sentry user context, navigation tracking, business event tracking
- **Sprint 5b:** Cross-entity reconciliation checks via `src/lib/reconciliation.ts` — 5 pure check functions + DB wrapper

### Earlier (Feb 25-27)
- `Payments.tsx` DELETED — `PaymentAllocation` is sole payment page at `/payments`
- AR derived from invoices only (orders.total_paid/balance_due deprecated)
- Migration `20260312200000_business_logic_audit_fixes.sql` — hold release trigger, period enforcement, commission validation, inventory pre-check
- `checkMutationResult()` added to 13 pages for silent RLS failure detection
- Offline sync conflict detection via `snapshotAt` / `entityTable` / `entityId`
- Realtime `disabled` prop prevents null-filter subscriptions
- Dependabot + Husky + `.nvmrc` + `.claude/settings.json` added
- New docs structure: `docs/reference/`, `docs/workflows/`, `docs/claude-memory/`

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
- `migration-history.md` — Narrative of all 80+ migrations and their purpose
- `sprint-audit-details.md` — S18-S20 features + safety audit technical details

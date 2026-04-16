# CRX Manager V1.0 — Agent Memory

> **Last updated:** 2026-04-09

## Project

- **Repo:** `C:\CRX_Manager_V1.0` | GitHub: `masonwells1/CRX_Manager_V1.0`
- **Production:** https://croprxsolutions.app (Vercel)
- **Supabase:** `rhyzpcqhnizqbxphqdkr`
- **Owner:** Mason Wells (`masonwells1`) — beginner, explain simply

## Environment (this machine)

- Windows 11, Git Bash shell
- Node `v24.13.0`, npm `11.6.2`, Git `v2.53.0`
- `tail` NOT available — don't pipe to tail
- PATH each session: `export PATH="$PATH:/c/Program Files/GitHub CLI:/c/Program Files/nodejs"`

## .env (not in Git)

See `.env.example` in repo root for required variable names. Never commit actual values.

## Current State (as of 2026-04-09)

- **Branch:** `main`
- **Pages:** 63 | **Migrations:** 245 | **Edge Functions:** 7
- **Unit tests:** 1,772 passing (119 files) | **E2E specs:** 92 spec files
- **Build:** clean | **CI:** green | **Pre-commit:** lint + build + vitest
- **Season:** October 1 to September 30

## Recent Major Features (2026-03-17 → 2026-04-09)

- **CommandPalette** — Cmd+K global search/navigation
- **ActionQueue** — Dashboard action items via `get_dashboard_action_items` RPC
- **Field Management V3** — FieldDashboard, FieldSetup with Mapbox polygon drawing
- **Application Services** — ApplicationServices + ApplicationServiceDetail pages
- **FieldApplicationInvoice** — Invoice generation from field applications
- **ProgramTracker** — Seasonal crop program completion tracking
- **DispatchBoard** — Driver/delivery dispatch management
- **GettingStarted** — Onboarding checklist page for new users
- **Password Reset** — ForgotPasswordPage + ResetPasswordPage + `reset-user-password` Edge Function
- **Field App Workflow V2** — FieldAppChemicalEntry, SelectLocationsModal, CustomerSharesTable
- **GuardrailBanner + useGuardrails** — Business rule enforcement UI layer
- **TransactionThread** — Unified transaction history component
- **HelpTip** — Contextual help tooltips
- **OCRThresholdSettings** — Tunable OCR confidence settings
- **Custom ESLint rules** — `require-assert-rpc-result`, `no-direct-sentry-import`
- **Workflow gaps remediation** — Quote→Job, smart pricing, field billing splits, dispatch columns
- **Mega audit phase 1** — 40+ RPC fixes (search_path, idempotency, status enums)

## Where to Find Things

All architecture, patterns, red lines, and business logic are in **CLAUDE.md** (loaded automatically).

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
| Plans & designs | `docs/plans/` |
| Gotchas & lessons | `docs/claude-memory/lessons.md` |
| Full project details | `docs/claude-memory/project-details.md` |

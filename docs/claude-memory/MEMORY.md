# Memory

## User
- **GitHub:** masonwells1
- **Experience:** Beginner (0 code experience) — explain things simply
- **Works from multiple computers** — repo is single source of truth

## Project: CRX_Manager_V1.0
- **What:** Agricultural product distribution management for Crop RX Solutions
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase project:** rhyzpcqhnizqbxphqdkr
- **Admin user:** mason@croprxsolutions.com (UUID: 22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f)

## Current Stats (2026-02-27)
- 48 pages, 83 migrations, 5 Edge Functions
- 1,121 unit tests (80 files) + 61 E2E spec files
- CI green, 0 lint/TS errors, Husky pre-commit + pre-push hooks
- Dependabot configured for npm + GitHub Actions

## Recent Key Changes
- `Payments.tsx` deleted — `PaymentAllocation` is sole payment page at `/payments`
- AR derived from invoices only (orders.total_paid/balance_due deprecated)
- Migration `20260311200000_invoice_ar_single_source.sql` rewrites 9 RPCs
- Migration `20260315200000_emergency_rpc_fixes.sql` — fixes 9 RPCs crashing on wrong column refs
- Migration `20260315200001_accounting_and_integrity_fixes.sql` — period enforcement in 10 RPCs, FOR UPDATE locks, audit log expansion, cycle count guards, return dedup

## Critical Reminders
- **gh CLI bash path:** `"/c/Program Files/GitHub CLI/gh.exe"`
- **Season:** October 1 to September 30
- **Money:** all bigint cents (display / 100, store * 100)
- **`tail` not available** — don't pipe to tail on Windows

## Topic Files (read when relevant)
| File | Contents |
|------|----------|
| `project-details.md` | Features, pages, scripts, env vars |
| `setup-guide.md` | New computer setup + environment versions |
| `lessons.md` | Gotchas and key lessons learned |
| `doc-rules.md` | Pre-commit doc review checklist + update rules |

## Repo Docs
- `CLAUDE.md` — Architecture rules, red lines, business logic, common patterns
- `docs/reference/` — database-schema, rpc-functions, migration-history, pages-routes, code-patterns, qa-testing
- `docs/workflows/` — SAFE_DEVELOPMENT_RULES, DATABASE_CHANGE_CHECKLIST, INVENTORY_RULES, QUOTE_TO_DELIVERY, RLS_SECURITY_GUIDE, UI_PATTERNS
- `docs/CHANGELOG.md` — Sprint history

# CRX Manager V1.0 — Agent Memory

> **Last updated:** 2026-03-02

## Project

- **Repo:** `C:\Users\pc\CRX_Manager_V1.0` | GitHub: `masonwells1/CRX_Manager_V1.0`
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

## Current State

- **Branch:** `main`
- **Pages:** 50 | **Migrations:** 107 | **Edge Functions:** 5
- **Unit tests:** 1,433 passing (92 files) | **E2E specs:** 98 files (589 tests, all passing)
- **Build:** clean | **CI:** green | **Pre-commit:** lint + build + vitest
- **Season:** October 1 to September 30

## What's Next

1. User acceptance testing with real data
2. Verify Edge Function secrets in production
3. Review Top 10 UX improvements roadmap (deferred)

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
| Future plans | `docs/plans/` (price list versioning, top 10 UX improvements) |

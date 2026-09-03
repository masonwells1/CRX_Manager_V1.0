## 2026-09-03 - Apply ledger-backed commission history

- Applied `20260903150100_ledger_backed_commission_history` to production as live ledger version `20260903202611` after clean Claude Opus, exact-SHA, RLS, migration-drift, and PostgreSQL 17 proof gates.
- Established the immutable cutover at `2026-09-03T20:26:11.402245Z`; exact historical reporting begins September 4, 2026 in Chicago time.
- Verified 35 opening earned-state events (33 baseline and 2 legacy excluded), zero settlement events, all reviewed function hashes, admin-only RLS, zero non-owner ledger grants, and all 10 required history triggers.
- Refreshed the generated Supabase types and live-introspection schema registry. No live `[E2E]` fixture rows were created.

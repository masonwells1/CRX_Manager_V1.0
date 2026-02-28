# Season Calendar Change: July→October

**Date:** 2026-02-28
**Status:** Approved

## Summary

Change the season calendar from **July 1–June 30** to **October 1–September 30**.
Season naming uses end-year convention: Season 2026 = Oct 1, 2025 – Sept 30, 2026.

## Approach: Centralized Helper Functions

Instead of updating 38 inline season calculations, create centralized SQL and TypeScript
functions. All existing code calls the helper. Future season changes require editing 2 files.

## New Rules

| Item | Old | New |
|------|-----|-----|
| Season start | July 1 | October 1 |
| Season end | June 30 | September 30 |
| SQL boundary | `extract(month) >= 7` | `extract(month) >= 10` |
| JS boundary | `getMonth() >= 6` | `getMonth() >= 9` |
| Season start date | `make_date(season-1, 7, 1)` | `make_date(season-1, 10, 1)` |
| Season end date | `make_date(season, 6, 30)` | `make_date(season, 9, 30)` |

## SQL Migration

### A. Helper functions

```sql
CREATE FUNCTION compute_season(p_date date) RETURNS integer
CREATE FUNCTION season_start_date(p_season integer) RETURNS date
CREATE FUNCTION season_end_date(p_season integer) RETURNS date
```

### B. Data migration (13 tables)

Recalculate season column for: allocation_sets, application_records, blend_tickets,
commission_payments, commissions, deliveries, invoices, jobs, orders, payments,
prepay_credits, quotes, rebate_programs.

### C. RPC rewrites

All functions that compute season inline get refactored to call `compute_season()`.

## TypeScript Changes

### A. New shared utility: `src/utils/season.ts`

```typescript
export function computeSeason(date?: Date): number
export function seasonStartDate(season: number): string
export function seasonEndDate(season: number): string
export function getSeasonDates(date?: Date): { start: string; end: string }
```

### B. Update 10 React/TS files to use shared utility

ReportShell, ApplicationRecords, ARaging, CropPrograms, InventoryPage,
Jobs, Reports, YearEndSummaryDialog + their tests.

## Documentation Updates

- CLAUDE.md — season rule
- docs/workflows/INVENTORY_RULES.md — season references
- docs/claude-memory/MEMORY.md — season rule
- Test files — expected dates

## Risk Mitigation

- All existing season data gets recalculated from actual dates (deterministic)
- No financial amounts are changed — only the season integer column
- Centralized functions are IMMUTABLE for query optimizer efficiency
- All tests updated to verify new boundaries

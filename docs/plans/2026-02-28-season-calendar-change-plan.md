# Season Calendar Change Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change the season calendar from July 1–June 30 to October 1–September 30 with centralized helper functions.

**Architecture:** Create SQL helper functions (`compute_season`, `season_start_date`, `season_end_date`) and a TypeScript utility (`src/utils/season.ts`). Migrate all 13 tables' season data, rewrite 7 RPCs, and refactor 10 React files to use the shared utilities.

**Tech Stack:** PostgreSQL (Supabase), React 18, TypeScript, Vitest

---

### Task 1: Create TypeScript Season Utility + Tests

**Files:**
- Create: `src/utils/season.ts`
- Create: `src/utils/season.test.ts`

**Step 1: Write the failing tests**

Create `src/utils/season.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from './season';

describe('computeSeason', () => {
  it('returns next year for Oct-Dec (season = end-year)', () => {
    expect(computeSeason(new Date(2025, 9, 1))).toBe(2026);   // Oct 1, 2025
    expect(computeSeason(new Date(2025, 10, 15))).toBe(2026);  // Nov 15, 2025
    expect(computeSeason(new Date(2025, 11, 31))).toBe(2026);  // Dec 31, 2025
  });

  it('returns same year for Jan-Sep', () => {
    expect(computeSeason(new Date(2026, 0, 1))).toBe(2026);   // Jan 1, 2026
    expect(computeSeason(new Date(2026, 5, 15))).toBe(2026);  // Jun 15, 2026
    expect(computeSeason(new Date(2026, 8, 30))).toBe(2026);  // Sep 30, 2026
  });

  it('boundary: Sep 30 is last day of season', () => {
    expect(computeSeason(new Date(2026, 8, 30))).toBe(2026);
  });

  it('boundary: Oct 1 is first day of NEW season', () => {
    expect(computeSeason(new Date(2026, 9, 1))).toBe(2027);
  });

  it('defaults to current date when no arg', () => {
    const result = computeSeason();
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(2020);
  });
});

describe('seasonStartDate', () => {
  it('returns Oct 1 of previous year', () => {
    expect(seasonStartDate(2026)).toBe('2025-10-01');
    expect(seasonStartDate(2027)).toBe('2026-10-01');
  });
});

describe('seasonEndDate', () => {
  it('returns Sep 30 of season year', () => {
    expect(seasonEndDate(2026)).toBe('2026-09-30');
    expect(seasonEndDate(2027)).toBe('2027-09-30');
  });
});

describe('getSeasonDates', () => {
  it('returns start and end for date in Oct-Dec', () => {
    const result = getSeasonDates(new Date(2025, 10, 15)); // Nov 2025
    expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
  });

  it('returns start and end for date in Jan-Sep', () => {
    const result = getSeasonDates(new Date(2026, 1, 15)); // Feb 2026
    expect(result).toEqual({ start: '2025-10-01', end: '2026-09-30' });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/season.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/utils/season.ts`:

```typescript
/**
 * Season calendar utilities.
 * Season runs October 1 to September 30, named by end-year.
 * Season 2026 = Oct 1, 2025 – Sep 30, 2026.
 *
 * To change the season boundary in the future, update SEASON_START_MONTH
 * here and the matching compute_season() SQL function.
 */

/** October (0-indexed) — first month of a new season */
const SEASON_START_MONTH = 9;

/** Compute the season number for a given date (defaults to now). */
export function computeSeason(date: Date = new Date()): number {
  return date.getMonth() >= SEASON_START_MONTH
    ? date.getFullYear() + 1
    : date.getFullYear();
}

/** First day of a season: Oct 1 of (season - 1). */
export function seasonStartDate(season: number): string {
  return `${season - 1}-10-01`;
}

/** Last day of a season: Sep 30 of season year. */
export function seasonEndDate(season: number): string {
  return `${season}-09-30`;
}

/** Get the start and end dates for the season containing the given date. */
export function getSeasonDates(date: Date = new Date()): { start: string; end: string } {
  const season = computeSeason(date);
  return { start: seasonStartDate(season), end: seasonEndDate(season) };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/utils/season.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/utils/season.ts src/utils/season.test.ts
git commit -m "feat: add centralized season utility (Oct 1 – Sep 30)"
```

---

### Task 2: Refactor ReportShell to Use Season Utility

**Files:**
- Modify: `src/components/reports/ReportShell.tsx`
- Modify: `src/components/reports/ReportShell.test.ts`
- Modify: `src/components/reports/ReportShell.test.tsx`

**Step 1: Update ReportShell.tsx**

Replace the inline `getPresetDates` season logic with imports from `src/utils/season.ts`.

Key changes:
- Import `{ computeSeason, seasonStartDate, seasonEndDate }` from `../../utils/season`
- Replace `month >= 6` with calls to the utility
- Replace hardcoded `07-01` / `06-30` with `10-01` / `09-30`
- Update comment from "July 1 to June 30" to "October 1 to September 30"

The `getPresetDates` cases become:
```typescript
case 'this_season': {
  const s = computeSeason(now);
  return { start: seasonStartDate(s), end: seasonEndDate(s) };
}
case 'last_season': {
  const s = computeSeason(now) - 1;
  return { start: seasonStartDate(s), end: seasonEndDate(s) };
}
case 'ytd': {
  const s = computeSeason(now);
  return { start: seasonStartDate(s), end: `${year}-${pad(month + 1)}-${pad(day)}` };
}
```

**Step 2: Update ReportShell.test.ts**

Update all expected dates from `07-01`/`06-30` to `10-01`/`09-30`.
Update boundary logic from `month >= 6` to `month >= 9`.
Update test descriptions and assertions.

**Step 3: Update ReportShell.test.tsx**

Update the YTD assertions from `/^\d{4}-07-01$/` to `/^\d{4}-10-01$/` and `06-30` to `09-30`.
Update the seasonStart calculation from `month >= 6` to `month >= 9`.

**Step 4: Run tests**

Run: `npx vitest run src/components/reports/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/components/reports/ReportShell.tsx src/components/reports/ReportShell.test.ts src/components/reports/ReportShell.test.tsx
git commit -m "refactor: ReportShell uses centralized season utility"
```

---

### Task 3: Refactor Remaining React Pages

**Files to modify (each uses inline season logic):**
- `src/pages/ApplicationRecords.tsx` — `getPresetDates` with `month >= 6`, `07-01`/`06-30`
- `src/pages/ARaging.tsx` — `currentMonth >= 6`, season dropdown
- `src/pages/CropPrograms.tsx` — `getMonth() >= 6`, season choices
- `src/pages/InventoryPage.tsx` — `getMonth() >= 6`, `new Date(year, 6, 1)`
- `src/pages/Jobs.tsx` — `getPresetDates` with `month >= 6`, `07-01`/`06-30`
- `src/pages/Reports.tsx` — `getPresetDates` with `month >= 6`, `07-01`/`06-30`
- `src/components/reports/YearEndSummaryDialog.tsx` — `getMonth() >= 6`, `Jul/Jun` labels

**For each file:**
1. Add import: `import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from '../utils/season'`
2. Replace inline season logic with utility calls
3. Update UI labels from "Jul–Jun" to "Oct–Sep" where applicable

**Key changes per file:**

**ApplicationRecords.tsx:**
```typescript
case 'this_season': return getSeasonDates(now);
case 'last_season': {
  const s = computeSeason(now) - 1;
  return { start: seasonStartDate(s), end: seasonEndDate(s) };
}
```

**ARaging.tsx:**
```typescript
const currentSeason = computeSeason();
```

**CropPrograms.tsx:**
```typescript
const base = computeSeason();
return [String(base - 1), String(base), String(base + 1)];
```

**InventoryPage.tsx:**
```typescript
const season = computeSeason(now);
const seasonStart = new Date(season - 1, 9, 1); // Oct 1
```

**Jobs.tsx:**
```typescript
case 'this_season': return getSeasonDates(now);
```

**Reports.tsx:**
```typescript
case 'this_season': return getSeasonDates(now);
case 'last_season': { const s = computeSeason(now) - 1; ... }
```

**YearEndSummaryDialog.tsx:**
```typescript
function getCurrentSeason() { return computeSeason(); }
// Label: {s} (Oct {s - 1} – Sep {s})
```

**Step: Run full test suite**

Run: `npx vitest run`
Expected: ALL 1,121+ tests PASS

**Step: Commit**

```bash
git add src/pages/ApplicationRecords.tsx src/pages/ARaging.tsx src/pages/CropPrograms.tsx src/pages/InventoryPage.tsx src/pages/Jobs.tsx src/pages/Reports.tsx src/components/reports/YearEndSummaryDialog.tsx
git commit -m "refactor: all React pages use centralized season utility"
```

---

### Task 4: Write SQL Migration — Helper Functions + Data Migration

**Files:**
- Create: `supabase/migrations/20260228200000_season_calendar_oct_sep.sql`

**Step 1: Write the migration file**

The migration has 3 sections:

**Section A — Helper functions:**
```sql
-- Centralized season computation: Oct 1 – Sep 30, end-year naming
CREATE OR REPLACE FUNCTION compute_season(p_date date)
RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT CASE WHEN extract(month FROM p_date) >= 10
  THEN extract(year FROM p_date)::integer + 1
  ELSE extract(year FROM p_date)::integer END; $$;

CREATE OR REPLACE FUNCTION season_start_date(p_season integer)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT make_date(p_season - 1, 10, 1); $$;

CREATE OR REPLACE FUNCTION season_end_date(p_season integer)
RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT make_date(p_season, 9, 30); $$;
```

**Section B — Data migration (13 tables):**
```sql
UPDATE allocation_sets SET season = compute_season(COALESCE(payment_date, created_at::date));
UPDATE application_records SET season = compute_season(COALESCE(application_date, created_at::date));
UPDATE blend_tickets SET season = compute_season(COALESCE(ticket_date, created_at::date));
UPDATE commission_payments SET season = compute_season(COALESCE(payment_date, created_at::date));
UPDATE commissions SET season = compute_season(COALESCE(order_date, created_at::date));
UPDATE deliveries SET season = compute_season(COALESCE(scheduled_date, created_at::date));
UPDATE invoices SET season = compute_season(COALESCE(invoice_date, created_at::date));
UPDATE jobs SET season = compute_season(COALESCE(job_date, created_at::date));
UPDATE orders SET season = compute_season(COALESCE(order_date, created_at::date));
UPDATE payments SET season = compute_season(COALESCE(payment_date, created_at::date));
UPDATE prepay_credits SET season = compute_season(created_at::date);
UPDATE quotes SET season = compute_season(created_at::date);
UPDATE rebate_programs SET season = compute_season(COALESCE(start_date, created_at::date));
```

**Section C — Rewrite 7 RPCs to use compute_season():**

For each function, replace inline `CASE WHEN extract(month ...) >= 7 ...` with `compute_season(date)`, and replace `make_date(season-1, 7, 1)` / `make_date(season, 6, 30)` with `season_start_date(season)` / `season_end_date(season)`.

Functions to rewrite:
1. `allocate_payment` — change `v_current_season` calc to `compute_season(CURRENT_DATE)`
2. `create_commission_payment` (both overloads) — change season calc to `compute_season(v_payment_dt)`
3. `generate_finance_charges` — change inline season in INSERT to `compute_season(p_as_of_date)`
4. `get_receiving_summary` — change `v_year_start` to `season_start_date(compute_season(current_date))`
5. `transfer_job_to_invoice` — change inline season in INSERT to `compute_season(CURRENT_DATE)`
6. `get_customer_year_end_summary` — change `make_date` calls to `season_start_date`/`season_end_date`
7. `get_season_comparison` — change `make_date` calls to `season_start_date`/`season_end_date`

**Step 2: Commit migration locally**

```bash
git add supabase/migrations/20260228200000_season_calendar_oct_sep.sql
git commit -m "feat: season calendar Oct 1 – Sep 30 migration + centralized SQL helpers"
```

---

### Task 5: Update Documentation

**Files:**
- Modify: `CLAUDE.md` — change "July 1 to June 30" → "October 1 to September 30"
- Modify: `docs/workflows/INVENTORY_RULES.md` — all July/June references → October/September
- Modify: `docs/claude-memory/MEMORY.md` — season rule

**Step: Commit**

```bash
git add CLAUDE.md docs/workflows/INVENTORY_RULES.md docs/claude-memory/MEMORY.md
git commit -m "docs: update season calendar references to Oct 1 – Sep 30"
```

---

### Task 6: Run Full Verification

**Step 1: TypeScript check**
Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Lint**
Run: `npx eslint src/ --ext .ts,.tsx`
Expected: 0 errors

**Step 3: Unit tests**
Run: `npx vitest run`
Expected: ALL PASS (1,121+ tests)

**Step 4: Build**
Run: `npm run build`
Expected: clean build

---

### Task 7: Apply Migration to Supabase + Verify

**Step 1: Apply migration via MCP**
Use `apply_migration` tool with the full SQL from Task 4.

**Step 2: Verify helper functions exist**
```sql
SELECT compute_season('2025-10-01'::date);  -- expect 2026
SELECT compute_season('2026-09-30'::date);  -- expect 2026
SELECT compute_season('2026-10-01'::date);  -- expect 2027
SELECT season_start_date(2026);              -- expect 2025-10-01
SELECT season_end_date(2026);                -- expect 2026-09-30
```

**Step 3: Verify data migration**
```sql
SELECT table_name, season, count(*) FROM (
  SELECT 'invoices' as table_name, season FROM invoices
  UNION ALL SELECT 'orders', season FROM orders
  UNION ALL SELECT 'payments', season FROM payments
) t GROUP BY table_name, season ORDER BY table_name, season;
```

**Step 4: Spot-check a record in the Jul-Sep overlap**
```sql
SELECT id, invoice_number, invoice_date, season
FROM invoices
WHERE extract(month FROM invoice_date) BETWEEN 7 AND 9
LIMIT 5;
-- These should now have season = extract(year from invoice_date) since months 7-9 < 10
```

**Step 5: Push to GitHub + deploy**
```bash
git push origin main
```
Vercel auto-deploys from main.

---

## Summary of All Changes

| # | Type | Files | Description |
|---|------|-------|-------------|
| 1 | New | 2 | `src/utils/season.ts` + `season.test.ts` |
| 2 | Modify | 3 | ReportShell + 2 test files |
| 3 | Modify | 7 | ApplicationRecords, ARaging, CropPrograms, InventoryPage, Jobs, Reports, YearEndSummaryDialog |
| 4 | New | 1 | SQL migration (helpers + data + 7 RPCs) |
| 5 | Modify | 3 | CLAUDE.md, INVENTORY_RULES.md, MEMORY.md |
| **Total** | | **16 files** | |

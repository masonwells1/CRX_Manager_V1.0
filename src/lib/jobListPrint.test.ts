// Field-app parity #15: tests for the pure job-list print logic — the mapping
// of displayed jobs + visible columns -> print columns/rows + the acre totals
// row. These prove paper == screen WITHOUT rendering a PDF.

import { describe, it, expect } from 'vitest';
import {
  jobPrintCellValue,
  computeJobListTotals,
  buildJobListPrintData,
  type JobListPrintRow,
} from './jobListPrint';
import { JOB_COLUMN_REGISTRY, type JobColumnId } from '../components/jobs/jobListColumns';

function makeRow(overrides: Partial<JobListPrintRow> = {}): JobListPrintRow {
  return {
    status: 'scheduled',
    job_number: 'FJOB-001',
    job_date: '2026-06-20',
    call_date: null,
    total_acres: 100,
    remaining_acres: 40,
    total_price_cents: 12345,
    customer_phone: null,
    printed_at: null,
    customer_name: 'Acme Farms',
    applicator_name: 'Jane Doe',
    vehicle_name: 'Rig 1',
    created_by_name: 'Admin',
    updated_by_name: 'Admin',
    last_printed_by_name: '-',
    batch_name: null,
    locations: ['North 40', 'South 80'],
    crops: ['Corn'],
    chemicals: [{ product_name: 'Atrazine', rate_per_acre: 2, rate_unit: 'qt' }],
    customers: [{ customer_name: 'Acme Farms', account_number: 'A100' }],
    jobTags: [{ name: 'Rush' }],
    ...overrides,
  };
}

describe('jobPrintCellValue', () => {
  it('formats job number, status, applicator, vehicle as the screen shows', () => {
    const r = makeRow({ status: 'in_progress' });
    expect(jobPrintCellValue('job_number', r)).toBe('FJOB-001');
    expect(jobPrintCellValue('status', r)).toBe('in progress'); // underscore -> space
    expect(jobPrintCellValue('applicator_name', r)).toBe('Jane Doe');
    expect(jobPrintCellValue('vehicle_name', r)).toBe('Rig 1');
  });

  it('formats acres and price like the screen', () => {
    const r = makeRow({ total_acres: 1234, remaining_acres: 56, total_price_cents: 100000 });
    expect(jobPrintCellValue('total_acres', r)).toBe((1234).toLocaleString());
    expect(jobPrintCellValue('remaining_acres', r)).toBe((56).toLocaleString());
    expect(jobPrintCellValue('total_price_cents', r)).toBe('$1,000.00');
  });

  it('falls back remaining -> total_acres when remaining is null (matches screen)', () => {
    const r = makeRow({ total_acres: 80, remaining_acres: null });
    expect(jobPrintCellValue('remaining_acres', r)).toBe((80).toLocaleString());
  });

  it('joins customers with account numbers like the chips', () => {
    const r = makeRow({
      customers: [
        { customer_name: 'Acme', account_number: 'A1' },
        { customer_name: 'Beta', account_number: null },
      ],
    });
    expect(jobPrintCellValue('customer_name', r)).toBe('Acme (A1), Beta');
  });

  it('renders chemicals with rate + unit', () => {
    const r = makeRow({
      chemicals: [
        { product_name: 'Atrazine', rate_per_acre: 2, rate_unit: 'qt' },
        { product_name: 'Glyphosate', rate_per_acre: null, rate_unit: null },
      ],
    });
    expect(jobPrintCellValue('chemicals', r)).toBe('Atrazine — 2 qt; Glyphosate');
  });

  it('renders "-" for empty list/text cells (never crashes)', () => {
    const r = makeRow({ crops: [], locations: [], jobTags: [], batch_name: null, customer_phone: null });
    expect(jobPrintCellValue('crops', r)).toBe('-');
    expect(jobPrintCellValue('locations', r)).toBe('-');
    expect(jobPrintCellValue('jobTags', r)).toBe('-');
    expect(jobPrintCellValue('batch_name', r)).toBe('-');
    expect(jobPrintCellValue('customer_phone', r)).toBe('-');
  });

  it('renders wind_direction as "-" (no source yet) instead of crashing', () => {
    expect(jobPrintCellValue('wind_direction', makeRow())).toBe('-');
  });

  it('renders the printed/not-printed status like the screen', () => {
    expect(jobPrintCellValue('printed_at', makeRow({ printed_at: null }))).toBe('Not printed');
    const printed = jobPrintCellValue('printed_at', makeRow({ printed_at: '2026-06-21T10:00:00Z', last_printed_by_name: 'Sam' }));
    expect(printed).toContain('Printed');
    expect(printed).toContain('Sam');
  });

  it('handles a printed row with an unresolved printer name', () => {
    const printed = jobPrintCellValue('printed_at', makeRow({ printed_at: '2026-06-21T10:00:00Z', last_printed_by_name: '-' }));
    expect(printed).toContain('Unknown');
  });

  it('covers every registry column id without throwing', () => {
    const r = makeRow();
    for (const col of JOB_COLUMN_REGISTRY) {
      expect(() => jobPrintCellValue(col.id, r)).not.toThrow();
      expect(typeof jobPrintCellValue(col.id, r)).toBe('string');
    }
  });
});

describe('computeJobListTotals', () => {
  it('sums total and remaining acres over the listed jobs', () => {
    const rows = [
      makeRow({ total_acres: 100, remaining_acres: 40 }),
      makeRow({ total_acres: 50, remaining_acres: 50 }),
      makeRow({ total_acres: 0, remaining_acres: 0 }),
    ];
    expect(computeJobListTotals(rows)).toEqual({ totalAcres: 150, remainingAcres: 90 });
  });

  it('treats null total_acres as 0 and falls back remaining -> total', () => {
    const rows = [
      makeRow({ total_acres: null, remaining_acres: null }),
      makeRow({ total_acres: 30, remaining_acres: null }), // remaining falls back to 30
    ];
    expect(computeJobListTotals(rows)).toEqual({ totalAcres: 30, remainingAcres: 30 });
  });

  it('is zero for an empty list', () => {
    expect(computeJobListTotals([])).toEqual({ totalAcres: 0, remainingAcres: 0 });
  });
});

describe('buildJobListPrintData', () => {
  it('builds columns in the given (registry) order with on-screen headers', () => {
    const ids: JobColumnId[] = ['job_number', 'customer_name', 'total_acres', 'remaining_acres'];
    const { columns } = buildJobListPrintData([makeRow()], ids);
    expect(columns.map((c) => c.key)).toEqual(ids);
    expect(columns.map((c) => c.header)).toEqual(['Job #', 'Customers', 'Tot. ac', 'Rem. ac']);
  });

  it('right-aligns acre + price columns, left-aligns the rest', () => {
    const ids: JobColumnId[] = ['job_number', 'total_acres', 'total_price_cents'];
    const { columns } = buildJobListPrintData([makeRow()], ids);
    expect(columns[0].align).toBe('left');
    expect(columns[1].align).toBe('right');
    expect(columns[2].align).toBe('right');
  });

  it('produces one row per job with a value for every visible column', () => {
    const ids: JobColumnId[] = ['job_number', 'status', 'total_acres'];
    const rows = [makeRow({ job_number: 'A' }), makeRow({ job_number: 'B' })];
    const { rows: printRows } = buildJobListPrintData(rows, ids);
    expect(printRows).toHaveLength(2);
    expect(printRows[0]).toEqual({ job_number: 'A', status: 'scheduled', total_acres: (100).toLocaleString() });
    expect(printRows[1].job_number).toBe('B');
  });

  it('puts the acre totals under their columns and a TOTALS label first', () => {
    const ids: JobColumnId[] = ['job_number', 'customer_name', 'total_acres', 'remaining_acres'];
    const rows = [
      makeRow({ total_acres: 100, remaining_acres: 40 }),
      makeRow({ total_acres: 50, remaining_acres: 10 }),
    ];
    const { totalsRow } = buildJobListPrintData(rows, ids);
    expect(totalsRow).toHaveLength(ids.length);
    expect(totalsRow[0]).toContain('TOTALS');
    expect(totalsRow[0]).toContain('2 jobs');
    expect(totalsRow[1]).toBe(''); // customer column has no total
    expect(totalsRow[2]).toBe((150).toLocaleString(undefined, { maximumFractionDigits: 1 }));
    expect(totalsRow[3]).toBe((50).toLocaleString(undefined, { maximumFractionDigits: 1 }));
  });

  it('singularizes the TOTALS label for a single job', () => {
    const { totalsRow } = buildJobListPrintData([makeRow()], ['job_number', 'total_acres']);
    expect(totalsRow[0]).toContain('1 job)');
  });

  it('drops unknown column ids instead of crashing', () => {
    const ids = ['job_number', 'made_up_col', 'status'] as JobColumnId[];
    const { columns, rows } = buildJobListPrintData([makeRow()], ids);
    expect(columns.map((c) => c.key)).toEqual(['job_number', 'status']);
    expect(Object.keys(rows[0])).toEqual(['job_number', 'status']);
  });

  it('handles an empty job list (header-only print with a zeroed totals row)', () => {
    const ids: JobColumnId[] = ['job_number', 'total_acres'];
    const { columns, rows, totalsRow } = buildJobListPrintData([], ids);
    expect(columns).toHaveLength(2);
    expect(rows).toEqual([]);
    expect(totalsRow[0]).toContain('0 jobs');
    expect(totalsRow[1]).toBe((0).toLocaleString(undefined, { maximumFractionDigits: 1 }));
  });
});

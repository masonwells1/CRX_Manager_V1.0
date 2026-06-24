import { describe, it, expect } from 'vitest';
import {
  JOB_COLUMN_REGISTRY,
  defaultJobListSettings,
  mergeJobListSettings,
  orderedVisibleColumnIds,
  toggleColumn,
  isInvoiceColumnVisible,
  type JobColumnId,
} from './jobListColumns';

describe('jobListColumns registry', () => {
  it('has unique column ids', () => {
    const ids = JOB_COLUMN_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every acceptance-criterion toggle', () => {
    const labels = new Set(JOB_COLUMN_REGISTRY.map((c) => c.label));
    for (const required of [
      'Wind Direction', 'Created By', 'Job Tags', 'Status', 'Updated By',
      'Call Date', 'Remaining Acres', 'Scheduled Date', 'Last Printed By',
      'Customer Phone', 'Customers', 'Applicators', 'Locations', 'Crops',
      'Total Acres', 'Chemical Application',
    ]) {
      expect(labels.has(required)).toBe(true);
    }
  });

  it('marks the ChemMan shared columns as shared', () => {
    const sharedLabels = JOB_COLUMN_REGISTRY.filter((c) => c.shared).map((c) => c.label).sort();
    expect(sharedLabels).toEqual(
      ['Applicators', 'Chemical Application', 'Crops', 'Customers', 'Locations', 'Total Acres'].sort()
    );
  });
});

describe('defaultJobListSettings', () => {
  it('returns only defaultVisible columns and showCompleted=true', () => {
    const d = defaultJobListSettings();
    expect(d.showCompleted).toBe(true);
    const expected = JOB_COLUMN_REGISTRY.filter((c) => c.defaultVisible).map((c) => c.id);
    expect(d.visibleColumns).toEqual(expected);
  });

  it('does not include OFF-by-default columns', () => {
    const d = defaultJobListSettings();
    expect(d.visibleColumns).not.toContain('wind_direction');
    expect(d.visibleColumns).not.toContain('customer_phone');
    expect(d.visibleColumns).not.toContain('total_price_cents');
  });
});

describe('mergeJobListSettings', () => {
  it('returns full defaults for null/undefined (no saved row)', () => {
    expect(mergeJobListSettings(null)).toEqual(defaultJobListSettings());
    expect(mergeJobListSettings(undefined)).toEqual(defaultJobListSettings());
  });

  it('returns full defaults for a non-object', () => {
    expect(mergeJobListSettings('nope')).toEqual(defaultJobListSettings());
    expect(mergeJobListSettings(42)).toEqual(defaultJobListSettings());
  });

  it('uses default visibleColumns when the saved blob is an empty object', () => {
    expect(mergeJobListSettings({})).toEqual(defaultJobListSettings());
  });

  it('keeps the user-chosen subset verbatim', () => {
    const saved = { visibleColumns: ['job_number', 'status'], showCompleted: true };
    expect(mergeJobListSettings(saved).visibleColumns).toEqual(['job_number', 'status']);
  });

  it('honors an EMPTY visibleColumns array (user hid everything)', () => {
    const saved = { visibleColumns: [], showCompleted: true };
    // Empty array is a valid explicit choice -> stays empty (not re-defaulted).
    expect(mergeJobListSettings(saved).visibleColumns).toEqual([]);
  });

  it('drops unknown / removed column ids', () => {
    const saved = { visibleColumns: ['job_number', 'made_up_col', 'status'], showCompleted: true };
    expect(mergeJobListSettings(saved).visibleColumns).toEqual(['job_number', 'status']);
  });

  it('dedups repeated ids', () => {
    const saved = { visibleColumns: ['status', 'status', 'job_number'], showCompleted: true };
    expect(mergeJobListSettings(saved).visibleColumns).toEqual(['status', 'job_number']);
  });

  it('does NOT auto-add a registry column the user never chose', () => {
    // Simulate an older save that predates the "batch_name" column existing.
    const saved = { visibleColumns: ['job_number'], showCompleted: true };
    expect(mergeJobListSettings(saved).visibleColumns).toEqual(['job_number']);
    expect(mergeJobListSettings(saved).visibleColumns).not.toContain('batch_name');
  });

  it('defaults showCompleted to true when absent or invalid', () => {
    expect(mergeJobListSettings({ visibleColumns: ['status'] }).showCompleted).toBe(true);
    expect(
      mergeJobListSettings({ visibleColumns: ['status'], showCompleted: 'yes' }).showCompleted
    ).toBe(true);
  });

  it('honors showCompleted=false', () => {
    expect(
      mergeJobListSettings({ visibleColumns: ['status'], showCompleted: false }).showCompleted
    ).toBe(false);
  });
});

describe('orderedVisibleColumnIds', () => {
  it('returns visible ids in REGISTRY order regardless of saved order', () => {
    // Saved out of order: status before job_number, but registry has job_number first.
    const settings = { visibleColumns: ['status', 'job_number'] as JobColumnId[], showCompleted: true };
    const ordered = orderedVisibleColumnIds(settings);
    expect(ordered.indexOf('job_number')).toBeLessThan(ordered.indexOf('status'));
  });

  it('excludes ids not in the visible set', () => {
    const settings = { visibleColumns: ['job_number'] as JobColumnId[], showCompleted: true };
    expect(orderedVisibleColumnIds(settings)).toEqual(['job_number']);
  });

  it('matches full registry order when everything is visible', () => {
    const allIds = JOB_COLUMN_REGISTRY.map((c) => c.id);
    const settings = { visibleColumns: allIds, showCompleted: true };
    expect(orderedVisibleColumnIds(settings)).toEqual(allIds);
  });
});

describe('isInvoiceColumnVisible (shared toggles, criterion #5)', () => {
  it('shows a NON-shared invoice column regardless of settings', () => {
    const settings = { visibleColumns: [] as JobColumnId[], showCompleted: true };
    // invoice_number / status are not governed by the shared toggles.
    expect(isInvoiceColumnVisible(settings, 'invoice_number')).toBe(true);
    expect(isInvoiceColumnVisible(settings, 'status')).toBe(true);
    expect(isInvoiceColumnVisible(settings, 'balance_cents')).toBe(true);
  });

  it('hides a shared invoice column when the job-list toggle is off', () => {
    const settings = { visibleColumns: ['customer_name'] as JobColumnId[], showCompleted: true };
    // applicator_name + total_acres are shared but NOT in visibleColumns -> hidden.
    expect(isInvoiceColumnVisible(settings, 'applicator_name')).toBe(false);
    expect(isInvoiceColumnVisible(settings, 'total_acres')).toBe(false);
    // customer_name IS on -> visible.
    expect(isInvoiceColumnVisible(settings, 'customer_name')).toBe(true);
  });

  it('shows shared invoice columns that ARE on in the job-list settings', () => {
    const settings = {
      visibleColumns: ['customer_name', 'applicator_name', 'total_acres'] as JobColumnId[],
      showCompleted: true,
    };
    expect(isInvoiceColumnVisible(settings, 'customer_name')).toBe(true);
    expect(isInvoiceColumnVisible(settings, 'applicator_name')).toBe(true);
    expect(isInvoiceColumnVisible(settings, 'total_acres')).toBe(true);
  });

  it('defaults (all shared on) keep every invoice column visible', () => {
    const settings = defaultJobListSettings();
    for (const key of ['invoice_number', 'customer_name', 'applicator_name', 'total_acres', 'status']) {
      expect(isInvoiceColumnVisible(settings, key)).toBe(true);
    }
  });
});

describe('toggleColumn', () => {
  it('removes a visible column', () => {
    const settings = { visibleColumns: ['status', 'job_number'] as JobColumnId[], showCompleted: true };
    expect(toggleColumn(settings, 'status').visibleColumns).toEqual(['job_number']);
  });

  it('adds a hidden column', () => {
    const settings = { visibleColumns: ['job_number'] as JobColumnId[], showCompleted: true };
    expect(toggleColumn(settings, 'status').visibleColumns).toContain('status');
  });

  it('does not mutate the input', () => {
    const settings = { visibleColumns: ['job_number'] as JobColumnId[], showCompleted: true };
    const before = [...settings.visibleColumns];
    toggleColumn(settings, 'status');
    expect(settings.visibleColumns).toEqual(before);
  });

  it('preserves showCompleted', () => {
    const settings = { visibleColumns: ['job_number'] as JobColumnId[], showCompleted: false };
    expect(toggleColumn(settings, 'status').showCompleted).toBe(false);
  });
});

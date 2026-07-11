import { describe, expect, it } from 'vitest';
import { buildLoaderWorksheetPdfPlan, type LoaderWorksheetPdfData } from './loaderWorksheetPdf';

const baseData: LoaderWorksheetPdfData = {
  job_number: 'JOB-100',
  customers: [{ customer_name: 'Smith Farm', account_number: null }],
  scheduled_date: '2026-07-11',
  scheduled_time: null,
  applicator_name: 'Avery Applicator',
  vehicle_name: 'Rogator',
  total_acres: 344.67,
  carrier_rate_gpa: 15,
  tank_capacity: 2000,
  capacity_unit: 'gal',
  products: [{ product_name: 'AMS', total_quantity: 689.34, unit: 'lb' }],
  loader_comment: null,
};

describe('buildLoaderWorksheetPdfPlan', () => {
  it('uses selected-row mode and per-load acres instead of legacy defaults', () => {
    const plan = buildLoaderWorksheetPdfPlan({
      ...baseData,
      load_balance_mode: 'full_loads_remainder',
      per_load_acres: [133.33, 133.33, 78.01],
      loads_done: [0],
    });

    expect(plan.worksheet.valid).toBe(true);
    expect(plan.worksheet.loads.map((load) => Math.round((load.volume / 15) * 100) / 100)).toEqual([133.33, 133.33, 78.01]);
    expect(plan.columns[0]).toMatchObject({ label: 'Load 1', done: true });
    expect(plan.columns[1]).toMatchObject({ label: 'Load 2', done: false });
  });

  it('condenses identical completed full loads while retaining their done mark', () => {
    const plan = buildLoaderWorksheetPdfPlan({
      ...baseData,
      load_balance_mode: 'full_loads_remainder',
      loads_done: [0, 1],
      display_mode: 'condensed',
    });

    expect(plan.columns[0]).toMatchObject({ label: '2 × Loads 1–2', done: true });
    expect(plan.columns[0].loads).toHaveLength(2);
    expect(plan.columns[1]).toMatchObject({ label: 'Load 3', done: false });
  });

  it('keeps condensed product amounts per tank instead of summing the group', () => {
    const plan = buildLoaderWorksheetPdfPlan({
      ...baseData,
      load_balance_mode: 'full_loads_remainder',
      display_mode: 'condensed',
    });

    const groupedColumn = plan.columns[0];
    const perTankAmount = plan.worksheet.loads[0].products[0].amount;
    expect(groupedColumn.loads).toHaveLength(2);
    expect(groupedColumn.load.products[0].amount).toBe(perTankAmount);
    expect(groupedColumn.load.products[0].amount).not.toBe(
      groupedColumn.loads.reduce((sum, load) => sum + load.products[0].amount, 0),
    );
  });

  it('ignores saved done marks beyond the current three-load plan', () => {
    const plan = buildLoaderWorksheetPdfPlan({ ...baseData, loads_done: [0, 5] });

    expect(plan.worksheet.loads_count).toBe(3);
    expect(plan.columns.map((column) => column.done)).toEqual([true, false, false]);
  });
});

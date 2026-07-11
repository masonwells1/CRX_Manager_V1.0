import { describe, expect, it } from 'vitest';
import { computeLoaderWorksheet } from './loaderWorksheet';
import {
  condensedLoaderLoadLabel,
  condenseLoaderLoads,
  hasValidPerLoadAcres,
  isLoaderWorksheetSelectionConflict,
  toggleLoaderLoadDone,
} from './loaderWorksheets';
import type { LoaderLoad } from './loaderWorksheet';

describe('saved loader worksheet helpers', () => {
  it('toggles completed load indexes without duplicates', () => {
    expect(toggleLoaderLoadDone([0, 2], 1, 3)).toEqual([0, 1, 2]);
    expect(toggleLoaderLoadDone([0, 1, 2], 1, 3)).toEqual([0, 2]);
  });

  it('drops stale completed indexes and toggles against the current load plan', () => {
    expect(toggleLoaderLoadDone([0, 5], 1, 3)).toEqual([0, 1]);
    expect(toggleLoaderLoadDone([0, 5], 5, 3)).toEqual([0]);
  });

  it('groups identical adjacent loads only when their done marks agree', () => {
    const worksheet = computeLoaderWorksheet({
      total_acres: 100,
      carrier_rate_gpa: 10,
      tank_capacity: 500,
      products: [{ product_name: 'AMS', total_quantity: 100, unit: 'lb' }],
    });

    const completeGroups = condenseLoaderLoads(worksheet.loads, [0, 1]);
    expect(completeGroups).toHaveLength(1);
    expect(completeGroups[0].loads).toHaveLength(2);
    expect(completeGroups[0].done).toBe(true);
    expect(condensedLoaderLoadLabel(completeGroups[0])).toBe('2 × Loads 1–2');
    expect(completeGroups[0].loads[0].products[0].amount).toBe(50);
    expect(completeGroups[0].loads[1].products[0].amount).toBe(50);

    const mixedGroups = condenseLoaderLoads(worksheet.loads, [0]);
    expect(mixedGroups).toHaveLength(2);
    expect(mixedGroups.map((group) => group.done)).toEqual([true, false]);
  });

  it('condenses full loads with round-four floating-point differences', () => {
    const loads: LoaderLoad[] = [
      { load_number: 1, volume: 2000, is_partial: false, products: [{ product_name: 'AMS', amount: 50, unit: 'lb' }] },
      { load_number: 2, volume: 2000.0001, is_partial: false, products: [{ product_name: 'AMS', amount: 50.0001, unit: 'lb' }] },
    ];

    const groups = condenseLoaderLoads(loads, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].loads).toHaveLength(2);
  });

  it('uses the shared 0.01-acre tolerance for manual load acres', () => {
    expect(hasValidPerLoadAcres([49.995, 50], 2, 100)).toBe(true);
    expect(hasValidPerLoadAcres([49.98, 50], 2, 100)).toBe(false);
    expect(hasValidPerLoadAcres([50], 2, 100)).toBe(false);
  });

  it('recognizes only the database unique-violation code as a selection collision', () => {
    expect(isLoaderWorksheetSelectionConflict({ code: '23505' })).toBe(true);
    expect(isLoaderWorksheetSelectionConflict({ code: '42501' })).toBe(false);
    expect(isLoaderWorksheetSelectionConflict(new Error('23505'))).toBe(false);
  });
});

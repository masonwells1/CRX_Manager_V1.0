import { describe, expect, it } from 'vitest';
import {
  ASSIGNED_VEHICLE_VESSEL_VALUE,
  buildLoaderVesselOptions,
  capacityForLoaderVesselSelection,
} from './loaderVesselOptions';

describe('buildLoaderVesselOptions', () => {
  it('puts the assigned-vehicle fallback first and includes only active gallon vessels with a capacity', () => {
    const options = buildLoaderVesselOptions([
      { id: 'tender', vehicle_name: 'Tender 1', status: 'active', capacity_gallons: 3200, capacity_unit: 'gal', category: 'Tender' },
      { id: 'inactive', vehicle_name: 'Retired Tender', status: 'inactive', capacity_gallons: 2500, capacity_unit: 'gal', category: 'Tender' },
      { id: 'empty', vehicle_name: 'No Capacity', status: 'active', capacity_gallons: null, capacity_unit: 'gal', category: null },
      { id: 'zero', vehicle_name: 'Zero Capacity', status: 'active', capacity_gallons: 0, capacity_unit: 'gal', category: 'Other' },
      { id: 'sprayer', vehicle_name: 'Hagie STS12', status: 'active', capacity_gallons: 1000, capacity_unit: null, category: null },
      { id: 'legacy', vehicle_name: 'Legacy Sprayer', status: 'active', capacity_gallons: 800, category: null },
      { id: 'spreader', vehicle_name: 'Dry Spreader', status: 'active', capacity_gallons: 12000, capacity_unit: 'lbs', category: 'Spreader' },
    ]);

    expect(options).toEqual([
      {
        value: ASSIGNED_VEHICLE_VESSEL_VALUE,
        label: 'Assigned vehicle (default)',
        capacity_gallons: null,
      },
      { value: 'tender', label: 'Tender 1 — 3200 gal · Tender', capacity_gallons: 3200 },
      { value: 'zero', label: 'Zero Capacity — 0 gal · Other', capacity_gallons: 0 },
      { value: 'sprayer', label: 'Hagie STS12 — 1000 gal', capacity_gallons: 1000 },
      { value: 'legacy', label: 'Legacy Sprayer — 800 gal', capacity_gallons: 800 },
    ]);
  });
});

describe('capacityForLoaderVesselSelection', () => {
  const options = buildLoaderVesselOptions([
    { id: 'tender', vehicle_name: 'Tender 1', status: 'active', capacity_gallons: 3200, category: 'Tender' },
  ]);

  it('sets a picked vessel capacity as the editable form override', () => {
    expect(capacityForLoaderVesselSelection('tender', options)).toBe('3200');
  });

  it('clears the override for Assigned vehicle so the existing fallback applies', () => {
    expect(capacityForLoaderVesselSelection(ASSIGNED_VEHICLE_VESSEL_VALUE, options)).toBe('');
  });
});

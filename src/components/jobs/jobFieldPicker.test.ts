import { describe, expect, it } from 'vitest';
import {
  JOB_FIELD_PICKER_MAP_LIMIT,
  filterJobPickerFields,
  mapFieldsForJobPicker,
  selectedJobPickerAcres,
  toggleJobPickerSelection,
  type JobFieldPickerField,
} from './jobFieldPicker';

const fields: JobFieldPickerField[] = [
  {
    id: 'corn-field', customer_id: 'customer-a', customer_name: 'A Farm', field_name: 'North Corn', county: 'Clay', crop_type: 'Corn',
    total_acres: 100, is_active: true, centroid_geojson: null, boundary_geojson: null,
  },
  {
    id: 'bean-field', customer_id: 'customer-b', customer_name: 'B Farm', field_name: 'South Beans', county: 'Pike', crop_type: 'Soybeans',
    total_acres: null, is_active: true, centroid_geojson: null, boundary_geojson: null,
  },
];

describe('jobFieldPicker', () => {
  it('keeps selections when a later filter narrows the displayed fields', () => {
    const selected = toggleJobPickerSelection(new Set(), 'corn-field', new Set());
    const narrowed = filterJobPickerFields(fields, { customerId: '', crop: 'Soybeans', fieldName: '', county: '' });

    expect(narrowed.map((field) => field.id)).toEqual(['bean-field']);
    expect(selected).toEqual(new Set(['corn-field']));
  });

  it('does not select a field that is already on the job', () => {
    expect(toggleJobPickerSelection(new Set(), 'corn-field', new Set(['corn-field']))).toEqual(new Set());
  });

  it('totals null acres as zero', () => {
    expect(selectedJobPickerAcres(fields, new Set(['corn-field', 'bean-field']))).toBe(100);
  });

  it('caps map fields without changing the filtered result count', () => {
    const manyFields = Array.from({ length: JOB_FIELD_PICKER_MAP_LIMIT + 1 }, (_, index) => ({
      ...fields[0],
      id: `field-${index}`,
    }));

    expect(mapFieldsForJobPicker(manyFields)).toHaveLength(JOB_FIELD_PICKER_MAP_LIMIT);
    expect(manyFields).toHaveLength(JOB_FIELD_PICKER_MAP_LIMIT + 1);
  });

  it('uses centroid distance when a map center is supplied for a capped map', () => {
    const near = { ...fields[0], id: 'near', centroid_geojson: '{"type":"Point","coordinates":[-89.01,40.01]}' };
    const far = { ...fields[0], id: 'far', centroid_geojson: '{"type":"Point","coordinates":[-90,41]}' };

    expect(mapFieldsForJobPicker([far, near], 1, [-89, 40]).map((field) => field.id)).toEqual(['near']);
  });
});

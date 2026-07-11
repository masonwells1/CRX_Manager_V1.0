import { describe, expect, it } from 'vitest';
import { getJobFieldRouteNumbers, type JobFieldRouteOrderField } from './jobFieldRouteOrder';

describe('getJobFieldRouteNumbers', () => {
  it('sorts by route order, puts nulls last, and uses field name as the tie-breaker', () => {
    const fields: JobFieldRouteOrderField[] = [
      { id: 'null-order', field_name: 'Zulu', sort_order: null },
      { id: 'route-two', field_name: 'North', sort_order: 2 },
      { id: 'route-one-z', field_name: 'West', sort_order: 1 },
      { id: 'route-one-a', field_name: 'East', sort_order: 1 },
    ];

    expect(getJobFieldRouteNumbers(fields)).toEqual(
      new Map([
        ['route-one-a', '1'],
        ['route-one-z', '2'],
        ['route-two', '3'],
        ['null-order', '4'],
      ])
    );
  });

  it('does not mutate the input array', () => {
    const fields: JobFieldRouteOrderField[] = [
      { id: 'second', field_name: 'Beta', sort_order: 2 },
      { id: 'first', field_name: 'Alpha', sort_order: 1 },
    ];
    const original = [...fields];

    getJobFieldRouteNumbers(fields);

    expect(fields).toEqual(original);
  });
});

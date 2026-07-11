import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, assertRpcResult } = vi.hoisted(() => ({
  rpc: vi.fn(),
  assertRpcResult: vi.fn(<T,>(value: T) => value),
}));

vi.mock('./db', () => ({
  supabase: { rpc },
  assertRpcResult,
}));

import {
  FIELDS_GEOJSON_CACHE_TTL_MS,
  getCachedFieldsGeojson,
  resetFieldsGeojsonCacheForTests,
} from './fieldsGeojsonCache';

const fields = [{
  id: 'field-1',
  customer_id: 'customer-1',
  customer_name: 'North Farm',
  field_name: 'North 80',
  county: 'Clay',
  crop_type: 'Corn',
  total_acres: 80,
  is_active: true,
  centroid_geojson: '{"type":"Point","coordinates":[-89.4,40]}',
  boundary_geojson: '{"type":"Polygon","coordinates":[]}',
}];

describe('fieldsGeojsonCache', () => {
  beforeEach(() => {
    resetFieldsGeojsonCacheForTests();
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: fields, error: null });
  });

  it('shares a successful full-geometry RPC response for five minutes', async () => {
    await expect(getCachedFieldsGeojson(1_000)).resolves.toEqual(fields);
    await expect(getCachedFieldsGeojson(1_000 + FIELDS_GEOJSON_CACHE_TTL_MS - 1)).resolves.toEqual(fields);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_fields_with_geojson');
    expect(assertRpcResult).toHaveBeenCalledWith(fields, 'get_fields_with_geojson');
  });

  it('refreshes after the cache expires and does not cache a failed RPC', async () => {
    await getCachedFieldsGeojson(1_000);
    rpc.mockResolvedValueOnce({ data: [{ ...fields[0], id: 'field-2' }], error: null });
    await expect(getCachedFieldsGeojson(1_000 + FIELDS_GEOJSON_CACHE_TTL_MS)).resolves.toEqual([{ ...fields[0], id: 'field-2' }]);

    resetFieldsGeojsonCacheForTests();
    rpc.mockResolvedValueOnce({ data: null, error: new Error('RLS denied') });
    await expect(getCachedFieldsGeojson(1_000)).rejects.toThrow('RLS denied');
    await getCachedFieldsGeojson(1_001);

    expect(rpc).toHaveBeenCalledTimes(4);
  });
});

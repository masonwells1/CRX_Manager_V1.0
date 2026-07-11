import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockEq, mockOrder, mockLimit, mockFetchJobMapImages } = vi.hoisted(() => {
  const mockLimit = vi.fn();
  const mockOrder = vi.fn(() => ({ limit: mockLimit }));
  const mockEq = vi.fn(() => ({ order: mockOrder }));
  const mockSelect = vi.fn(() => ({ eq: mockEq }));
  const mockFrom = vi.fn(() => ({ select: mockSelect }));
  const mockFetchJobMapImages = vi.fn();
  return { mockFrom, mockSelect, mockEq, mockOrder, mockLimit, mockFetchJobMapImages };
});

vi.mock('./db', () => ({
  supabase: { from: mockFrom },
  assertRpcResult: <T>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) throw new Error(`${rpcName} returned no data`);
    return data as T;
  },
}));

vi.mock('./jobMapImages', () => ({ fetchJobMapImages: mockFetchJobMapImages }));

import { fetchPreviousApplications, prepareApplicatorSheetPrintData } from './applicatorSheetPrintData';
import type { ApplicatorSheetData } from './applicatorSheetData';

describe('fetchPreviousApplications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shapes, sorts, limits, and excludes the current job record', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [
        {
          application_date: '2026-07-01',
          product_data: [{ product_name: 'Atrazine', rate_per_acre: 1, rate_unit: 'qt/ac' }],
          applicator_name: 'Casey Crew',
          source_type: 'job',
          source_id: 'older-job',
          application_record_fields: [{ field_id: 'field-1' }],
        },
        {
          application_date: '2026-07-10',
          product_data: [{ product_name: 'This Job Product', rate_per_acre: 2, rate_unit: 'pt/ac' }],
          applicator_name: 'Current Applicator',
          source_type: 'job',
          source_id: 'current-job',
          application_record_fields: [{ field_id: 'field-1' }],
        },
        {
          application_date: '2026-07-05',
          product_data: [{ product_name: 'NIS', rate_per_acre: 0.25, rate_unit: 'pt/ac' }],
          applicator_name: null,
          source_type: 'blend_ticket',
          source_id: 'ticket-1',
          application_record_fields: [{ field_id: 'field-1' }],
        },
      ],
      error: null,
    });
    mockLimit.mockResolvedValueOnce({
      data: [{
        application_date: '2026-06-01',
        product_data: [],
        applicator_name: 'Avery Applicator',
        source_type: 'job',
        source_id: 'older-job-2',
        application_record_fields: [{ field_id: 'field-2' }],
      }],
      error: null,
    });

    const history = await fetchPreviousApplications([
      { field_id: 'field-1', stop: 1, field_name: 'North 40', county: null, state: null, acres: 40, crop: null, pest: null },
      { field_id: 'field-2', stop: 2, field_name: 'South 80', county: null, state: null, acres: 80, crop: null, pest: null },
    ], 'current-job', 1);

    expect(mockFrom).toHaveBeenCalledWith('application_records');
    expect(mockEq).toHaveBeenNthCalledWith(1, 'application_record_fields.field_id', 'field-1');
    expect(mockEq).toHaveBeenNthCalledWith(2, 'application_record_fields.field_id', 'field-2');
    expect(mockOrder).toHaveBeenCalledWith('application_date', { ascending: false });
    expect(mockLimit).toHaveBeenCalledWith(3);
    expect(history).toEqual([
      {
        fieldId: 'field-1',
        fieldName: 'North 40',
        records: [{ date: '2026-07-05', summary: 'NIS (0.25 pt/ac)', applicator: null }],
      },
      {
        fieldId: 'field-2',
        fieldName: 'South 80',
        records: [{ date: '2026-06-01', summary: 'Product details not recorded', applicator: 'Avery Applicator' }],
      },
    ]);
  });

  it('keeps the newest parent record within the query ceiling when it applies to multiple fields', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [
        {
          application_date: '2026-07-12',
          product_data: [{ product_name: 'Newest', rate_per_acre: 1, rate_unit: 'qt/ac' }],
          applicator_name: 'Casey Crew',
          source_type: 'job',
          source_id: 'newest-job',
          application_record_fields: [{ field_id: 'field-1' }, { field_id: 'field-2' }],
        },
        {
          application_date: '2026-07-11',
          product_data: [{ product_name: 'Older', rate_per_acre: 2, rate_unit: 'qt/ac' }],
          applicator_name: 'Avery Applicator',
          source_type: 'job',
          source_id: 'older-job',
          application_record_fields: [{ field_id: 'field-1' }],
        },
      ],
      error: null,
    });
    mockLimit.mockResolvedValueOnce({
      data: [
        {
          application_date: '2026-07-12',
          product_data: [{ product_name: 'Newest', rate_per_acre: 1, rate_unit: 'qt/ac' }],
          applicator_name: 'Casey Crew',
          source_type: 'job',
          source_id: 'newest-job',
          application_record_fields: [{ field_id: 'field-2' }],
        },
      ],
      error: null,
    });

    const history = await fetchPreviousApplications([
      { field_id: 'field-1', stop: 1, field_name: 'North 40', county: null, state: null, acres: 40, crop: null, pest: null },
      { field_id: 'field-2', stop: 2, field_name: 'South 80', county: null, state: null, acres: 80, crop: null, pest: null },
    ], 'current-job', 1);

    expect(history).toEqual([
      {
        fieldId: 'field-1',
        fieldName: 'North 40',
        records: [{ date: '2026-07-12', summary: 'Newest (1 qt/ac)', applicator: 'Casey Crew' }],
      },
      {
        fieldId: 'field-2',
        fieldName: 'South 80',
        records: [{ date: '2026-07-12', summary: 'Newest (1 qt/ac)', applicator: 'Casey Crew' }],
      },
    ]);
  });

  it('returns an empty history when RLS denies the joined read', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'permission denied for table application_records' } });

    await expect(fetchPreviousApplications(
      [{ field_id: 'field-1', stop: 1, field_name: 'North 40', county: null, state: null, acres: 40, crop: null, pest: null }],
      'current-job',
      3,
    )).resolves.toEqual([]);
  });

  it('keeps history for a quieter field when a hot field fills its own query ceiling', async () => {
    mockLimit
      .mockResolvedValueOnce({
        data: [
          { application_date: '2026-07-12', product_data: [], applicator_name: null, source_type: 'job', source_id: 'hot-1', application_record_fields: [{ field_id: 'field-1' }] },
          { application_date: '2026-07-11', product_data: [], applicator_name: null, source_type: 'job', source_id: 'hot-2', application_record_fields: [{ field_id: 'field-1' }] },
          { application_date: '2026-07-10', product_data: [], applicator_name: null, source_type: 'job', source_id: 'hot-3', application_record_fields: [{ field_id: 'field-1' }] },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { application_date: '2026-06-01', product_data: [], applicator_name: 'Avery Applicator', source_type: 'job', source_id: 'quiet-job', application_record_fields: [{ field_id: 'field-2' }] },
        ],
        error: null,
      });

    const history = await fetchPreviousApplications([
      { field_id: 'field-1', stop: 1, field_name: 'North 40', county: null, state: null, acres: 40, crop: null, pest: null },
      { field_id: 'field-2', stop: 2, field_name: 'South 80', county: null, state: null, acres: 80, crop: null, pest: null },
    ], 'current-job', 1);

    expect(mockEq).toHaveBeenNthCalledWith(1, 'application_record_fields.field_id', 'field-1');
    expect(mockEq).toHaveBeenNthCalledWith(2, 'application_record_fields.field_id', 'field-2');
    expect(mockLimit).toHaveBeenCalledTimes(2);
    expect(mockLimit).toHaveBeenCalledWith(3);
    expect(history).toEqual([
      { fieldId: 'field-1', fieldName: 'North 40', records: [{ date: '2026-07-12', summary: 'Product details not recorded', applicator: null }] },
      { fieldId: 'field-2', fieldName: 'South 80', records: [{ date: '2026-06-01', summary: 'Product details not recorded', applicator: 'Avery Applicator' }] },
    ]);
  });

  it('does not fetch maps when the print options exclude map pages', async () => {
    const data: ApplicatorSheetData = {
      job_number: 'JOB-2026-001',
      customers: [],
      scheduled_date: '2026-07-11',
      scheduled_time: null,
      applicator_name: null,
      vehicle_name: null,
      fields: [],
      products: [],
      total_acres: 0,
      loader_comment: null,
    };

    const result = await prepareApplicatorSheetPrintData('job-1', data, {
      mapPages: 'none',
      includePreviousApplications: false,
      previousApplicationsPerField: 3,
      blankSections: 0,
      includeBillingSplits: false,
      showBanner: true,
    });

    expect(mockFetchJobMapImages).not.toHaveBeenCalled();
    expect(result.maps).toBeNull();
  });
});

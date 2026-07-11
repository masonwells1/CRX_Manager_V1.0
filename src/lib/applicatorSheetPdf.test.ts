import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicatorSheetData } from './applicatorSheetData';

let pageCount = 1;

const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  setDrawColor: vi.fn(),
  line: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  getImageProperties: vi.fn(() => ({ width: 1000, height: 700 })),
  addImage: vi.fn(),
  addPage: vi.fn(() => { pageCount += 1; }),
  deletePage: vi.fn(() => { pageCount -= 1; }),
  setPage: vi.fn(),
  getNumberOfPages: vi.fn(() => pageCount),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    (doc as typeof mockDoc).lastAutoTable = { finalY: ((opts.startY as number) || 0) + 50 };
  }),
}));

import { generateApplicatorSheetPdf } from './applicatorSheetPdf';

function makeSheetData(overrides: Partial<ApplicatorSheetData> = {}): ApplicatorSheetData {
  return {
    job_number: 'JOB-2026-001',
    customers: [{ customer_name: 'Smith Farm', account_number: '1001' }],
    scheduled_date: '2026-07-11',
    scheduled_time: null,
    applicator_name: 'Avery Applicator',
    vehicle_name: 'Sprayer 1',
    fields: [{ stop: 1, field_name: 'North 40', county: 'Crawford', state: 'IL', acres: 40, crop: null, pest: null }],
    products: [],
    total_acres: 40,
    loader_comment: null,
    ...overrides,
  };
}

describe('generateApplicatorSheetPdf map pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pageCount = 1;
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('keeps the existing page count when maps are absent', async () => {
    await generateApplicatorSheetPdf(makeSheetData(), 'original', null);

    expect(pageCount).toBe(1);
    expect(mockDoc.addImage).not.toHaveBeenCalled();
  });

  it('appends one overview and one page for each successfully fetched field map', async () => {
    await generateApplicatorSheetPdf(makeSheetData({
      maps: {
        overview: 'data:image/png;base64,b3ZlcnZpZXc=',
        perField: [
          {
            fieldId: 'field-1',
            fieldName: 'North 40',
            customerName: 'Smith Farm',
            acres: 40,
            centroidLat: 39.15,
            centroidLng: -89.05,
            dataUrl: 'data:image/png;base64,ZmllbGQtMQ==',
          },
          {
            fieldId: 'field-2',
            fieldName: 'South 80',
            customerName: null,
            acres: 80,
            centroidLat: null,
            centroidLng: null,
            dataUrl: 'data:image/png;base64,ZmllbGQtMg==',
          },
        ],
      },
    }), 'enhanced', null);

    expect(pageCount).toBe(4);
    expect(mockDoc.addImage).toHaveBeenCalledTimes(3);
    const renderedText = mockDoc.text.mock.calls.flat(Infinity).filter((value: unknown): value is string => typeof value === 'string');
    expect(renderedText).toContain('Job Field Map — Overview');
    expect(renderedText.some((value) => value.includes('North 40 · Smith Farm · 40 acres · Lat: 39.150000, Lng: -89.050000'))).toBe(true);
    expect(renderedText).toContain('South 80 · 80 acres');
    expect(renderedText.some((value) => value.includes('South 80 · Smith Farm'))).toBe(false);
  });

  it('expands the map header before placing the image and caps wrapped details at three lines', async () => {
    mockDoc.splitTextToSize.mockImplementation((text: string) => text.includes('Long Header Field')
      ? ['Long Header Field', 'Smith Farm · 40 acres', 'Lat: 39.150000, Lng: -89.050000', 'unused fourth line']
      : [text]);

    await generateApplicatorSheetPdf(makeSheetData({
      maps: {
        overview: null,
        perField: [{
          fieldId: 'field-1',
          fieldName: 'Long Header Field',
          customerName: 'Smith Farm',
          acres: 40,
          centroidLat: 39.15,
          centroidLng: -89.05,
          dataUrl: 'data:image/png;base64,ZmllbGQtMQ==',
        }],
      },
    }), 'original', null);

    expect(mockDoc.rect.mock.calls).toContainEqual([0, 0, 612, 78.5, 'F']);
    expect(mockDoc.addImage.mock.calls[0][3]).toBe(98.5);
    expect(mockDoc.text.mock.calls.some((call) => Array.isArray(call[0])
      && call[0][2] === 'Lat: 39.150000, Lng: -89.050000…')).toBe(true);
  });
});

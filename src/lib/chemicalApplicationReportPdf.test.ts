import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChemicalApplicationReportData } from './chemicalApplicationReportData';

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
  addPage: vi.fn(),
  setPage: vi.fn(),
  getNumberOfPages: vi.fn(() => 2),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

const autoTableBodies: unknown[][][] = [];

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    autoTableBodies.push(opts.body as unknown[][]);
    (doc as typeof mockDoc).lastAutoTable = {
      finalY: ((opts.startY as number) || 0) + 100,
    };
  }),
}));

import { generateChemicalApplicationReportPdf } from './chemicalApplicationReportPdf';

function makeReport(
  overrides: Partial<ChemicalApplicationReportData> = {},
): ChemicalApplicationReportData {
  return {
    job_number: 'JOB-2026-0042',
    customers: [{ customer_name: 'Smith Farm', account_number: '1001' }],
    application_date: '2026-07-14',
    scheduled_time: '08:30',
    applicator_name: 'Avery Applicator',
    total_acres: 120,
    crops_summary: 'Corn',
    pests_summary: 'Waterhemp',
    fields: [{
      field_name: 'North 120',
      county: 'Crawford',
      state: 'IL',
      acres: 120,
      crop: 'Corn',
      pest: 'Waterhemp',
    }],
    chemicals: [{
      product_name: 'Atrazine 4L',
      epa_registration: '100-497',
      rate_per_acre_display: '2 QT/ac',
      total_applied_display: '240 QT',
      gl_lb_display: '60 gal',
      rei_display: '12 hr',
      phi_display: '60 d',
    }],
    ...overrides,
  };
}

function renderedText(): string[] {
  return mockDoc.text.mock.calls
    .flat(Infinity)
    .filter((value: unknown): value is string => typeof value === 'string');
}

function tableCells(): string[] {
  return autoTableBodies
    .flat(Infinity)
    .filter((value: unknown): value is string => typeof value === 'string');
}

describe('generateChemicalApplicationReportPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoTableBodies.length = 0;
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('renders the official report identity, customer, job, and field details', async () => {
    await generateChemicalApplicationReportPdf(makeReport());

    const text = renderedText();
    const cells = tableCells();
    expect(text).toContain('Chemical Application Report');
    expect(text.some((value) => value.includes('Smith Farm') && value.includes('1001'))).toBe(true);
    expect(text.some((value) => value.includes('Job JOB-2026-0042'))).toBe(true);
    expect(text.some((value) => value.includes('Avery Applicator'))).toBe(true);
    expect(cells).toEqual(expect.arrayContaining([
      'North 120',
      'Crawford',
      'IL',
      'Corn',
      'Waterhemp',
      '120',
    ]));
  });

  it('renders the chemical compliance and application values', async () => {
    await generateChemicalApplicationReportPdf(makeReport());

    expect(tableCells()).toEqual(expect.arrayContaining([
      'Atrazine 4L',
      '100-497',
      '2 QT/ac',
      '240 QT',
      '60 gal',
      '12 hr',
      '60 d',
    ]));
  });

  it('uses safe missing-value fallbacks, saves predictably, and draws every footer', async () => {
    await generateChemicalApplicationReportPdf(makeReport({
      chemicals: [{
        product_name: 'Unregistered Test Product',
        epa_registration: null,
        rate_per_acre_display: '—',
        total_applied_display: '—',
        gl_lb_display: '—',
        rei_display: '—',
        phi_display: '—',
      }],
    }));

    expect(tableCells().filter((cell) => cell === '—').length).toBeGreaterThanOrEqual(6);
    expect(mockDoc.save).toHaveBeenCalledWith(
      'chemical-application-report-JOB-2026-0042.pdf',
    );
    expect(mockDoc.setPage).toHaveBeenNthCalledWith(1, 1);
    expect(mockDoc.setPage).toHaveBeenNthCalledWith(2, 2);
  });
});

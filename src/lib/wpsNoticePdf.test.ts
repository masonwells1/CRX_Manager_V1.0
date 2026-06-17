/**
 * wpsNoticePdf.test.ts — Regression test for the WPS Pre-Application Notice PDF.
 *
 * Gauntlet finding MED-5: this compliance-sensitive generator (40 CFR Part 170)
 * had no test. Locks in that the required WPS / pesticide-label fields render:
 * notice language, EPA registration number, signal word, application rate, REI
 * (restricted-entry interval), and PHI (pre-harvest interval).
 *
 * Uses the same jsPDF/autoTable mock pattern as invoicePdf.test.ts /
 * receivingPdf.test.ts. NOTE: generateWpsNoticePdf returns Promise<void> (it
 * does not hand back the doc), and its two autoTable bodies (Treated Areas,
 * Products) are passed to the mocked autoTable — so product-row content (EPA
 * reg, signal word, rate, REI, PHI) is asserted via the autoTable `body`, while
 * the header/notice prose is asserted via mockDoc.text calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock jsPDF doc instance ─────────────────────────────────────────────

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
  roundedRect: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  getTextWidth: vi.fn(() => 50),
  setLineDashPattern: vi.fn(),
  addPage: vi.fn(),
  setPage: vi.fn(),
  getNumberOfPages: vi.fn(() => 1),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

// Capture the body rows passed to each autoTable call so product/field cells
// (EPA reg, signal word, rate, REI, PHI) can be inspected.
const autoTableBodies: unknown[][][] = [];

vi.mock('jspdf', () => {
  function JsPDFMock() { return mockDoc; }
  return { default: JsPDFMock };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn((doc: Record<string, unknown>, opts: Record<string, unknown>) => {
    autoTableBodies.push(opts.body as unknown[][]);
    (doc as typeof mockDoc).lastAutoTable = { finalY: ((opts.startY as number) || 0) + 100 };
  }),
}));

import { generateWpsNoticePdf } from './wpsNoticePdf';
import type { WpsNoticeData, WpsNoticeField, WpsNoticeProduct } from './wpsNoticePdf';

// ── Test Data Factories ─────────────────────────────────────────────────

function makeField(overrides: Partial<WpsNoticeField> = {}): WpsNoticeField {
  return {
    field_name: 'North 40',
    county: 'Crawford',
    state: 'IL',
    acres: 120,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<WpsNoticeProduct> = {}): WpsNoticeProduct {
  return {
    product_name: 'Atrazine 4L',
    epa_registration: '100-497',
    signal_word: 'CAUTION',
    rei_hours: 12,
    phi_days: 60,
    rate_per_acre: 2,
    rate_unit: 'QT',
    ...overrides,
  };
}

function makeWpsData(overrides: Partial<WpsNoticeData> = {}): WpsNoticeData {
  return {
    job_number: 'JOB-2026-0010',
    customer_name: 'Smith Farm',
    application_date: '2026-03-01',
    scheduled_time: '08:00',
    applicator_name: 'Driver Test',
    fields: [makeField()],
    products: [makeProduct()],
    ...overrides,
  };
}

/** All string args passed to doc.text(), flattened (splitTextToSize returns arrays). */
function textStrings(): string[] {
  return mockDoc.text.mock.calls
    .flat(Infinity)
    .filter((arg: unknown): arg is string => typeof arg === 'string');
}

/** Every cell string across all autoTable bodies captured this run. */
function autoTableCells(): string[] {
  return autoTableBodies
    .flat(Infinity)
    .filter((cell: unknown): cell is string => typeof cell === 'string');
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('generateWpsNoticePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoTableBodies.length = 0;
    mockDoc.lastAutoTable = { finalY: 300 };
  });

  it('completes without throwing and saves the PDF', async () => {
    await expect(generateWpsNoticePdf(makeWpsData())).resolves.toBeUndefined();
    expect(mockDoc.save).toHaveBeenCalledTimes(1);
  });

  it('renders the WPS notice title and 40 CFR Part 170 citation (notice language)', async () => {
    await generateWpsNoticePdf(makeWpsData());
    const strings = textStrings();
    expect(strings).toContain('WPS PRE-APPLICATION NOTICE');
    expect(strings.some((s) => s.includes('Worker Protection Standard') && s.includes('40 CFR Part 170'))).toBe(true);
  });

  it('renders the required Worker Protection notice language (REI keep-out + posting)', async () => {
    await generateWpsNoticePdf(makeWpsData());
    const strings = textStrings();
    // Keep-out-until-REI-expires notice
    expect(strings.some((s) =>
      s.includes('OUT of the treated area') && s.includes('restricted-entry interval'),
    )).toBe(true);
    // Oral notification / posting requirement directed to the label
    expect(strings.some((s) =>
      s.includes('Oral notification') && s.includes('posting') && s.includes('40 CFR 170.409'),
    )).toBe(true);
    // 30-day central-posting retention requirement
    expect(strings.some((s) =>
      s.includes('30 days') && s.includes('170.311'),
    )).toBe(true);
  });

  it('renders the active-ingredients / label callout so it is not a standalone substitute', async () => {
    await generateWpsNoticePdf(makeWpsData());
    const strings = textStrings();
    expect(strings.some((s) =>
      s.includes('active ingredient') && s.includes('not a substitute'),
    )).toBe(true);
  });

  it('renders the operator/customer name and applicator', async () => {
    await generateWpsNoticePdf(makeWpsData());
    const strings = textStrings();
    expect(strings.some((s) => s.includes('Smith Farm'))).toBe(true);
    expect(strings.some((s) => s.includes('Driver Test') && s.includes('JOB-2026-0010'))).toBe(true);
  });

  it('renders the EPA registration number in the product table', async () => {
    await generateWpsNoticePdf(makeWpsData());
    expect(autoTableCells()).toContain('100-497');
  });

  it('renders the signal word in the product table', async () => {
    await generateWpsNoticePdf(makeWpsData({ products: [makeProduct({ signal_word: 'WARNING' })] }));
    expect(autoTableCells()).toContain('WARNING');
  });

  it('renders the application rate with unit per acre', async () => {
    await generateWpsNoticePdf(makeWpsData());
    expect(autoTableCells()).toContain('2 QT/ac');
  });

  it('renders the REI (restricted-entry interval) in hours when entered', async () => {
    await generateWpsNoticePdf(makeWpsData({ products: [makeProduct({ rei_hours: 24 })] }));
    expect(autoTableCells()).toContain('24 hours');
  });

  it('renders the PHI (pre-harvest interval) in days when entered', async () => {
    await generateWpsNoticePdf(makeWpsData({ products: [makeProduct({ phi_days: 30 })] }));
    expect(autoTableCells()).toContain('30 days');
  });

  it('falls back to "see product label" for REI/PHI when not stored', async () => {
    await generateWpsNoticePdf(makeWpsData({
      products: [makeProduct({ rei_hours: null, phi_days: null })],
    }));
    const cells = autoTableCells();
    expect(cells.filter((c) => c === 'see product label').length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to "see label" for a missing EPA registration number', async () => {
    await generateWpsNoticePdf(makeWpsData({
      products: [makeProduct({ epa_registration: null })],
    }));
    expect(autoTableCells()).toContain('see label');
  });

  it('renders treated-area field, county and state', async () => {
    await generateWpsNoticePdf(makeWpsData());
    const cells = autoTableCells();
    expect(cells).toContain('North 40');
    expect(cells).toContain('Crawford');
    expect(cells).toContain('IL');
  });

  it('handles multiple products and fields', async () => {
    await generateWpsNoticePdf(makeWpsData({
      fields: [
        makeField({ field_name: 'North 40' }),
        makeField({ field_name: 'South 80', county: 'Lawrence' }),
      ],
      products: [
        makeProduct({ product_name: 'Atrazine 4L', epa_registration: '100-497', signal_word: 'CAUTION' }),
        makeProduct({ product_name: 'Liberty 280 SL', epa_registration: '264-829', signal_word: 'WARNING' }),
      ],
    }));
    const cells = autoTableCells();
    expect(cells).toContain('100-497');
    expect(cells).toContain('264-829');
    expect(cells).toContain('South 80');
  });

  it('saves with a job-number-based filename by default', async () => {
    await generateWpsNoticePdf(makeWpsData({ job_number: 'JOB-2026-0099' }));
    expect(mockDoc.save).toHaveBeenCalledWith('wps-notice-JOB-2026-0099.pdf');
  });

  it('honors an explicit filename override', async () => {
    await generateWpsNoticePdf(makeWpsData(), 'custom-wps.pdf');
    expect(mockDoc.save).toHaveBeenCalledWith('custom-wps.pdf');
  });
});

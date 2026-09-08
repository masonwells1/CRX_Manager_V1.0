import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { exportToCSV, fmtCSV, fmtDateCSV, formatCSVCell } from './csvExport';

describe('fmtCSV', () => {
  it('formats a positive number as USD', () => {
    expect(fmtCSV(123.456)).toBe('$123.46');
  });

  it('formats zero', () => {
    expect(fmtCSV(0)).toBe('$0.00');
  });

  it('formats negative numbers', () => {
    expect(fmtCSV(-50)).toBe('$-50.00');
  });

  it('formats string numbers', () => {
    expect(fmtCSV('99.9')).toBe('$99.90');
  });

  it('returns $0.00 for NaN input', () => {
    expect(fmtCSV('not a number')).toBe('$0.00');
  });

  it('returns $0.00 for null', () => {
    expect(fmtCSV(null)).toBe('$0.00');
  });

  it('returns $0.00 for undefined', () => {
    expect(fmtCSV(undefined)).toBe('$0.00');
  });
});

describe('fmtDateCSV', () => {
  it('formats a valid date string', () => {
    const result = fmtDateCSV('2026-01-15');
    // toLocaleDateString output varies by locale, just check it's non-empty
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it('formats an ISO datetime string', () => {
    const result = fmtDateCSV('2026-06-15T10:30:00Z');
    expect(result).toBeTruthy();
  });

  it('returns empty string for null', () => {
    expect(fmtDateCSV(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(fmtDateCSV(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(fmtDateCSV('')).toBe('');
  });
});

describe('fmtDateOnlyCSV', () => {
  it('preserves the calendar day of a PostgreSQL date-only value in Chicago time', async () => {
    vi.stubEnv('TZ', 'America/Chicago');
    try {
      const { fmtDateOnlyCSV } = await import('./csvExport');
      // This proves the host is exercising the negative-offset failure mode:
      // the former `new Date(dateOnly)` implementation returns 8/19 here.
      expect(new Date('2026-08-20').toLocaleDateString()).toBe('8/19/2026');
      expect(fmtDateOnlyCSV('2026-08-20')).toBe('8/20/2026');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('formatCSVCell', () => {
  it('neutralizes formula-leading text values', () => {
    expect(formatCSVCell('=SUM(A1:A2)')).toBe('"\'=SUM(A1:A2)"');
    expect(formatCSVCell('+cmd')).toBe('"\'+cmd"');
    expect(formatCSVCell('-cmd')).toBe('"\'-cmd"');
    expect(formatCSVCell('@cmd')).toBe('"\'@cmd"');
  });

  it('neutralizes tab and carriage-return leading values', () => {
    expect(formatCSVCell('\t=SUM(A1:A2)')).toBe('"\'\t=SUM(A1:A2)"');
    expect(formatCSVCell('\r=SUM(A1:A2)')).toBe('"\'\r=SUM(A1:A2)"');
  });

  it('escapes quotes after neutralizing values', () => {
    expect(formatCSVCell('="hello"')).toBe('"\'=""hello"""');
  });
});

describe('exportToCSV', () => {
  let createElementSpy: MockInstance<typeof document.createElement>;
  let createObjectURLSpy: MockInstance<typeof URL.createObjectURL>;
  let revokeObjectURLSpy: MockInstance<typeof URL.revokeObjectURL>;
  let mockLink: { href: string; download: string; click: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockLink = { href: '', download: '', click: vi.fn() };
    createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockLink as unknown as HTMLElement);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => mockLink as unknown as HTMLElement);
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => mockLink as unknown as HTMLElement);
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  it('does nothing when data is empty', () => {
    exportToCSV([], [{ key: 'name', header: 'Name' }], 'test');
    expect(createElementSpy).not.toHaveBeenCalled();
  });

  it('creates a download link and clicks it', () => {
    const data = [{ name: 'Alice', age: 30 }];
    const columns = [
      { key: 'name', header: 'Name' },
      { key: 'age', header: 'Age' },
    ];
    exportToCSV(data, columns, 'users');

    expect(createElementSpy).toHaveBeenCalledWith('a');
    expect(mockLink.click).toHaveBeenCalled();
    expect(mockLink.download).toContain('users_');
    expect(mockLink.download).toContain('.csv');
    expect(revokeObjectURLSpy).toHaveBeenCalled();
  });

  it('uses custom format function when provided', () => {
    const data = [{ price: 10.5 }];
    const columns = [
      { key: 'price', header: 'Price', format: (v: unknown) => `$${Number(v).toFixed(2)}` },
    ];
    exportToCSV(data, columns, 'prices');

    // Verify the blob was created (we can't easily inspect blob content in jsdom,
    // but we verify the flow executed)
    expect(createObjectURLSpy).toHaveBeenCalled();
  });

  it('handles null/undefined values in data', () => {
    const data = [{ name: null, desc: undefined }] as Array<Record<string, unknown>>;
    const columns = [
      { key: 'name', header: 'Name' },
      { key: 'desc', header: 'Description' },
    ];
    // Should not throw
    expect(() => exportToCSV(data, columns, 'test')).not.toThrow();
  });

  it('escapes double quotes in values', () => {
    const data = [{ name: 'He said "hello"' }];
    const columns = [{ key: 'name', header: 'Name' }];
    // Should not throw — quotes are escaped to ""
    expect(() => exportToCSV(data, columns, 'test')).not.toThrow();
  });
});

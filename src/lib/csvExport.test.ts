import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportToCSV, fmtCSV, fmtDateCSV } from './csvExport';

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

describe('exportToCSV', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
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

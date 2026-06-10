import { describe, it, expect } from 'vitest';
import { getLicenseStatus, licenseStatusLabel } from './licenseStatus';

const TODAY = new Date(2026, 5, 10); // 2026-06-10 local

describe('getLicenseStatus', () => {
  it('returns none when there are no licenses', () => {
    expect(getLicenseStatus([], TODAY)).toEqual({ status: 'none', daysUntilExpiry: null, latestExpiry: null });
  });

  it('returns none when all licenses are inactive', () => {
    expect(getLicenseStatus([{ expiry_date: '2026-12-31', is_active: false }], TODAY).status).toBe('none');
  });

  it('returns expired when ALL active licenses are past expiry', () => {
    const s = getLicenseStatus(
      [
        { expiry_date: '2025-12-31', is_active: true },
        { expiry_date: '2026-01-15', is_active: true },
      ],
      TODAY,
    );
    expect(s.status).toBe('expired');
    expect(s.latestExpiry).toBe('2026-01-15');
    expect(s.daysUntilExpiry).toBeLessThan(0);
  });

  it('uses the LATEST active license (one valid among expired = not expired)', () => {
    const s = getLicenseStatus(
      [
        { expiry_date: '2025-12-31', is_active: true },
        { expiry_date: '2027-12-31', is_active: true },
      ],
      TODAY,
    );
    expect(s.status).toBe('valid');
    expect(s.latestExpiry).toBe('2027-12-31');
  });

  it('ignores inactive licenses when finding the latest expiry', () => {
    const s = getLicenseStatus(
      [
        { expiry_date: '2027-12-31', is_active: false },
        { expiry_date: '2026-01-15', is_active: true },
      ],
      TODAY,
    );
    expect(s.status).toBe('expired');
    expect(s.latestExpiry).toBe('2026-01-15');
  });

  it('returns expiring_soon within 30 days (inclusive)', () => {
    expect(getLicenseStatus([{ expiry_date: '2026-07-10', is_active: true }], TODAY).status).toBe('expiring_soon');
    expect(getLicenseStatus([{ expiry_date: '2026-06-10', is_active: true }], TODAY)).toMatchObject({
      status: 'expiring_soon',
      daysUntilExpiry: 0,
    });
  });

  it('returns valid beyond 30 days', () => {
    expect(getLicenseStatus([{ expiry_date: '2026-07-11', is_active: true }], TODAY).status).toBe('valid');
  });

  it('expiry today is NOT expired (matches DB gate: expiry_date < CURRENT_DATE)', () => {
    expect(getLicenseStatus([{ expiry_date: '2026-06-10', is_active: true }], TODAY).status).not.toBe('expired');
  });
});

describe('licenseStatusLabel', () => {
  it('labels each status', () => {
    expect(licenseStatusLabel(getLicenseStatus([], TODAY))).toBe('No license on file');
    expect(licenseStatusLabel(getLicenseStatus([{ expiry_date: '2026-01-15', is_active: true }], TODAY))).toBe(
      'License expired 2026-01-15',
    );
    expect(licenseStatusLabel(getLicenseStatus([{ expiry_date: '2026-06-11', is_active: true }], TODAY))).toBe(
      'License expires in 1 day',
    );
    expect(licenseStatusLabel(getLicenseStatus([{ expiry_date: '2027-12-31', is_active: true }], TODAY))).toBe(
      'Licensed through 2027-12-31',
    );
  });
});

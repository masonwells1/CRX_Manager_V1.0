/**
 * licenseStatus.ts — applicator license expiry status (deep-dive H1 B5)
 *
 * Mirrors the DB gate in `_enforce_applicator_license()` (migration
 * 20260610185714): a person is "expired" only when they HAVE active licenses
 * and ALL of them are past expiry. No license on file is 'none' (allowed by
 * the DB gate; the UI surfaces it as a soft warning).
 */

export interface LicenseLike {
  expiry_date: string; // 'YYYY-MM-DD'
  is_active: boolean;
}

export type LicenseStatusKind = 'none' | 'expired' | 'expiring_soon' | 'valid';

export interface LicenseStatus {
  status: LicenseStatusKind;
  /** Days until the LATEST active license expires (negative = past). Null when none. */
  daysUntilExpiry: number | null;
  /** Latest active expiry date ('YYYY-MM-DD'). Null when none. */
  latestExpiry: string | null;
}

const MS_PER_DAY = 86_400_000;
export const EXPIRING_SOON_DAYS = 30;

/** Parse 'YYYY-MM-DD' as a LOCAL date (avoids the UTC-midnight off-by-one). */
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function getLicenseStatus(licenses: LicenseLike[], today: Date = new Date()): LicenseStatus {
  const active = licenses.filter((l) => l.is_active);
  if (active.length === 0) {
    return { status: 'none', daysUntilExpiry: null, latestExpiry: null };
  }

  const latestExpiry = active.reduce(
    (max, l) => (l.expiry_date > max ? l.expiry_date : max),
    active[0].expiry_date,
  );

  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((parseLocalDate(latestExpiry).getTime() - startOfToday.getTime()) / MS_PER_DAY);

  if (days < 0) return { status: 'expired', daysUntilExpiry: days, latestExpiry };
  if (days <= EXPIRING_SOON_DAYS) return { status: 'expiring_soon', daysUntilExpiry: days, latestExpiry };
  return { status: 'valid', daysUntilExpiry: days, latestExpiry };
}

/** Short human label for badges, e.g. "License expired 2026-01-31". */
export function licenseStatusLabel(s: LicenseStatus): string {
  switch (s.status) {
    case 'none':
      return 'No license on file';
    case 'expired':
      return `License expired ${s.latestExpiry}`;
    case 'expiring_soon':
      return `License expires in ${s.daysUntilExpiry} day${s.daysUntilExpiry === 1 ? '' : 's'}`;
    case 'valid':
      return `Licensed through ${s.latestExpiry}`;
  }
}

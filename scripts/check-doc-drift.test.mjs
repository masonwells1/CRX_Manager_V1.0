import assert from 'node:assert/strict';
import {
  chicagoCalendarStamp,
  manualFreshnessBoundary,
  parseLatestMigrationHistoryEntry,
} from './check-doc-drift-lib.mjs';

assert.equal(
  parseLatestMigrationHistoryEntry('# Migration History (latest entry 916)'),
  '916',
  'the history header must describe the latest sequence rather than a false row count',
);
assert.equal(
  parseLatestMigrationHistoryEntry('# Migration History (916 migration-history entries)'),
  undefined,
  'the old count-shaped header must not silently pass as a sequence claim',
);
assert.equal(
  chicagoCalendarStamp(new Date('2026-09-05T03:30:00.000Z')),
  '20260904',
  'freshness uses the repository business timezone rather than UTC',
);
assert.equal(
  manualFreshnessBoundary('20260905', '20260904'),
  '20260904',
  'a deliberately future-stamped candidate must not force a future verification claim',
);
assert.equal(
  manualFreshnessBoundary('20260903', '20260904'),
  '20260903',
  'an ordinary migration still defines the minimum freshness boundary',
);

console.log('PASS - check-doc-drift helpers preserve truthful history and Chicago-date freshness.');

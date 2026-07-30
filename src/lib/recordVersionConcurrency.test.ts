import { describe, expect, it } from 'vitest';
import { buildRowVersionPatch, readRowVersion } from './recordVersionConcurrency';

describe('whole-record row-version client contract', () => {
  it('omits the token for an insert and includes the exact loaded token for an update', () => {
    expect(buildRowVersionPatch(false, null)).toEqual({});
    expect(buildRowVersionPatch(true, 7)).toEqual({ row_version_expected: 7 });
  });

  it('does not invent a version from malformed or stale-shaped data', () => {
    expect(readRowVersion(8)).toBe(8);
    expect(readRowVersion(0)).toBeNull();
    expect(readRowVersion(1.5)).toBeNull();
    expect(readRowVersion('8')).toBeNull();
  });
});

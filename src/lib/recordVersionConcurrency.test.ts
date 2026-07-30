import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('keeps quote and customer version reads compatible with pre-migration schemas', () => {
    for (const page of ['QuoteBuilder.tsx', 'CustomerDetail.tsx']) {
      const source = readFileSync(resolve(process.cwd(), 'src', 'pages', page), 'utf8');
      expect(source).not.toContain(".select('row_version')");
      expect(source).not.toContain('.select("row_version")');
    }
  });
});

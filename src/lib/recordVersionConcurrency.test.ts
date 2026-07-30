import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRowVersionPatch, readRowVersion, resolveDirectMutationRowVersion } from './recordVersionConcurrency';

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

  it('adopts a direct-mutation token only when it is exactly the next version', () => {
    expect(resolveDirectMutationRowVersion(4, 5)).toEqual({ kind: 'adopt', rowVersion: 5 });
    expect(resolveDirectMutationRowVersion(4, 6)).toEqual({ kind: 'recovery', rowVersion: null });
    expect(resolveDirectMutationRowVersion(7, 9)).toEqual({ kind: 'recovery', rowVersion: null });
    expect(resolveDirectMutationRowVersion(7, undefined)).toEqual({ kind: 'recovery', rowVersion: null });
  });

  it('keeps pre-migration direct writes compatible but fails closed once one side has a token', () => {
    expect(resolveDirectMutationRowVersion(null, undefined)).toEqual({ kind: 'legacy', rowVersion: null });
    expect(resolveDirectMutationRowVersion(null, null)).toEqual({ kind: 'legacy', rowVersion: null });
    expect(resolveDirectMutationRowVersion(null, 1)).toEqual({ kind: 'recovery', rowVersion: null });
  });

  it('keeps quote and customer version reads compatible with pre-migration schemas', () => {
    for (const page of ['QuoteBuilder.tsx', 'CustomerDetail.tsx']) {
      const source = readFileSync(resolve(process.cwd(), 'src', 'pages', page), 'utf8');
      expect(source).not.toContain(".select('row_version')");
      expect(source).not.toContain('.select("row_version")');
    }
  });

  it('routes every direct quote/customer mutation through the exact-next-token guard', () => {
    const quoteBuilder = readFileSync(resolve(process.cwd(), 'src/pages/QuoteBuilder.tsx'), 'utf8');
    const customerDetail = readFileSync(resolve(process.cwd(), 'src/pages/CustomerDetail.tsx'), 'utf8');
    expect(quoteBuilder.match(/applyDirectQuoteMutationRowVersion\(/g)).toHaveLength(2);
    expect(quoteBuilder).toContain('const previousRowVersion = quoteRowVersionRef.current;');
    expect(customerDetail).toContain('const previousRowVersion = customerRowVersionRef.current;');
    expect(customerDetail).toContain('resolveDirectMutationRowVersion(previousRowVersion, nextRowVersion)');
  });
});

import { describe, expect, it } from 'vitest';

// The smoke runner is a Node ESM script rather than TypeScript application code.
// @ts-expect-error -- it deliberately has no declaration file.
import { interpretResult } from '../../scripts/smoke/interpret-result.mjs';

describe('run-smoke result parser', () => {
  it('accepts only terminal PostgreSQL pass raises', () => {
    expect(interpretResult('psql:chain.sql:42: ERROR:  SMOKE_PASS_ROLLBACK restore quote')).toEqual({ pass: true });
    expect(
      interpretResult('psql:C:\\CRX_Manager\\scripts\\smoke\\chain.sql:42: ERROR:  SMOKE_PASS_ROLLBACK restore quote'),
    ).toEqual({ pass: true });
    expect(interpretResult('ERROR:  SMOKE_PASS_ROLLBACK (9/9 incl. cross-actor)')).toEqual({ pass: true });
    // The exact bare token also passes.
    expect(interpretResult('ERROR:  SMOKE_PASS_ROLLBACK')).toEqual({ pass: true });
  });

  it('refuses any identifier that merely EXTENDS the pass token', () => {
    // Three rounds of the same bug taught the shape of the fix: the matcher
    // ALLOWLISTS real delimiters (end, space, open paren) instead of
    // enumerating forbidden extension characters. Each historical bypass stays
    // pinned red here: plain extension (Sol), $-extension (CodeRabbit —
    // PostgreSQL identifiers may contain $), and non-ASCII identifier letters
    // (Sol — identifiers also permit é, λ and friends).
    for (const attack of [
      'ERROR:  SMOKE_PASS_ROLLBACK_BUT_FAILED',
      'ERROR:  SMOKE_PASS_ROLLBACK$BUT_FAILED',
      'ERROR:  SMOKE_PASS_ROLLBACKéBUT_FAILED',
      'ERROR:  SMOKE_PASS_ROLLBACKλBUT_FAILED',
    ]) {
      expect(interpretResult(attack).pass, attack).toBe(false);
    }
  });

  it('keeps failures that merely quote a pass token red', () => {
    const result = interpretResult(
      'psql:chain.sql:42: ERROR:  SMOKE_FAIL expected SMOKE_PASS_ROLLBACK but write was rejected',
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/SMOKE_FAIL/);
  });

  it('recognizes only a terminal prerequisite raise as skippable', () => {
    expect(interpretResult('ERROR:  SMOKE_PREREQ: quote restore boundary is not deployed')).toMatchObject({
      pass: false,
      prereq: true,
    });

    const quoted = interpretResult('ERROR:  SMOKE_FAIL expected SMOKE_PREREQ but fixture was missing');
    expect(quoted.pass).toBe(false);
    expect(quoted.prereq).toBeUndefined();
  });
});

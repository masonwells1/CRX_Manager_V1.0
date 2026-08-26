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

  it('refuses an identifier that merely EXTENDS the pass token (Sol, 2026-08-26)', () => {
    // startsWith() alone accepted this: the token boundary must be the end of
    // the message or a character that cannot extend a PostgreSQL identifier.
    const result = interpretResult('ERROR:  SMOKE_PASS_ROLLBACK_BUT_FAILED');
    expect(result.pass).toBe(false);
    // PostgreSQL identifiers may also contain `$` (CodeRabbit, 2026-08-26) —
    // a boundary that excluded only [A-Za-z0-9_] let this through.
    expect(interpretResult('ERROR:  SMOKE_PASS_ROLLBACK$BUT_FAILED').pass).toBe(false);
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

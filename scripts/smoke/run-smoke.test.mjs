import assert from 'node:assert/strict';
import { interpretResult } from './run-smoke.mjs';

assert.deepEqual(
  interpretResult('psql:chain.sql:42: ERROR:  SMOKE_PASS_ROLLBACK restore quote'),
  { pass: true },
  'the terminal PostgreSQL pass raise must be accepted',
);
assert.deepEqual(
  interpretResult('psql:C:\\CRX_Manager\\scripts\\smoke\\chain.sql:42: ERROR:  SMOKE_PASS_ROLLBACK restore quote'),
  { pass: true },
  'a Windows absolute psql path must still recognize the terminal pass raise',
);
assert.deepEqual(
  interpretResult('ERROR:  SMOKE_PASS_ROLLBACK (9/9 incl. cross-actor)'),
  { pass: true },
  'a documented suffixed terminal pass raise must remain green',
);

const quotedPass = interpretResult(
  'psql:chain.sql:42: ERROR:  SMOKE_FAIL expected SMOKE_PASS_ROLLBACK but write was rejected',
);
assert.equal(quotedPass.pass, false, 'a failure that quotes the pass token must never turn green');
assert.match(quotedPass.message, /SMOKE_FAIL/);

const prereq = interpretResult('ERROR:  SMOKE_PREREQ: quote restore boundary is not deployed');
assert.equal(prereq.pass, false);
assert.equal(prereq.prereq, true, 'only a PostgreSQL prerequisite raise is skippable');

const quotedPrereq = interpretResult('ERROR:  SMOKE_FAIL expected SMOKE_PREREQ but fixture was missing');
assert.equal(quotedPrereq.pass, false);
assert.equal(quotedPrereq.prereq, undefined, 'a failure that quotes the prerequisite token must stay red');

console.log('run-smoke parser: terminal errors only; quoted control tokens stay non-green');

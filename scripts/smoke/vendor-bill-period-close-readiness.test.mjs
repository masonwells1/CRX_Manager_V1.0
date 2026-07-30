import assert from 'node:assert/strict';
import { waitForDatabaseReadiness } from './vendor-bill-period-close-readiness.mjs';

let clock = 0;
let observations = 0;
const success = await waitForDatabaseReadiness({
  label: 'test advisory lock',
  timeoutMs: 30,
  intervalMs: 10,
  now: () => clock,
  sleep: async (ms) => { clock += ms; },
  observe: async () => ({ ready: ++observations === 3, advisory_waiters: observations }),
});
assert.equal(success.advisory_waiters, 3);

clock = 0;
await assert.rejects(
  waitForDatabaseReadiness({
    label: 'test missing advisory lock',
    timeoutMs: 20,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    observe: async () => ({ ready: false, advisory_waiters: 0 }),
  }),
  /database readiness timeout for test missing advisory lock; last observed .*advisory_waiters.*0/,
);

console.log('vendor-bill-period-close-readiness: success and timeout paths passed');

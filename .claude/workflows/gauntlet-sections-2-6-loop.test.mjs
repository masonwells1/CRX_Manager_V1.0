import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./gauntlet-sections-2-6-loop.js', import.meta.url), 'utf8');

assert.match(
  source,
  /if \(layerOk\(critic\)\)[\s\S]*?else[\s\S]*?blocked\.push/,
  'a blocked or malformed completeness critic must be recorded as blocked evidence',
);
assert.match(
  source,
  /if \(!res\.adjudication\?\.settled\)[\s\S]*?break/,
  'the orchestrator must stop before advancing past an unsettled section',
);

console.log('gauntlet-sections-2-6-loop tests passed');

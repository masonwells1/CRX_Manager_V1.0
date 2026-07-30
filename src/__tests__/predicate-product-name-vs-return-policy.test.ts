import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression cases for the phrase set matched by
// scripts/db-invariant-sweeps/predicates/product-name-vs-return-policy.sql
// (Codex low-severity finding on PR #286: the first alternative was missing its
// \m word anchor, so "MONO RETURN" false-flagged, while "ALL SALES FINAL" and
// "NON RETURN" were missed entirely).
//
// The pattern is READ OUT OF THE SQL FILE rather than duplicated here, so it
// cannot drift from the predicate that actually runs. Postgres POSIX syntax is
// translated to a JS RegExp by the mechanical mapping below; the authoritative
// check remains the predicate executed against the live catalog (baseline: 0
// violations / 604 products, all 21 no_return products matched). This test is
// the standing net that catches a careless edit to the phrase set.
const PREDICATE = path.resolve(
  process.cwd(),
  'scripts/db-invariant-sweeps/predicates/product-name-vs-return-policy.sql',
);

// Postgres punctuation class, spelled out: ASCII ! through ~ minus alphanumerics.
const PUNCT = '\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E';

function extractPattern(): string {
  const sql = readFileSync(PREDICATE, 'utf8');
  const m = sql.match(/~\*\s*'([^']+)'/);
  if (!m) throw new Error('could not find the ~* pattern literal in ' + PREDICATE);
  return m[1];
}

// \m = start of word, \M = end of word; both sit against a word character in
// this pattern, so JS \b is equivalent. ~* is case-insensitive => the 'i' flag.
function toJsRegExp(posix: string): RegExp {
  const translated = posix
    .replace(/\[\[:space:\]\[:punct:\]\]/g, `[\\s${PUNCT}]`)
    .replace(/\\m/g, '\\b')
    .replace(/\\M/g, '\\b');
  return new RegExp(translated, 'i');
}

// CONTAINMENT: every fixture below is a SYNTHETIC string. The repo is public
// and the predicate's own header forbids real product names or supplier SKUs in
// tracked files, so these must never be copied out of the live catalog — not
// even as "realistic" examples. "ITEM <n>" carries the same test signal.
const MUST_MATCH: Array<[string, string]> = [
  ['NO RETURN', 'ITEM ONE NO RETURN'],
  ['NO-RETURN, hyphenated', 'ITEM TWO NO-RETURN'],
  ['NORETURN, run together', 'ITEM THREE NORETURN'],
  ['NO RETURNS, plural', 'ITEM FOUR NO RETURNS'],
  ['NON RETURN, space separated', 'ITEM FIVE NON RETURN'],
  ['NON-RETURNABLE', 'ITEM SIX NON-RETURNABLE'],
  ['NONRETURNABLE', 'ITEM SEVEN NONRETURNABLE'],
  ['NOT RETURNABLE', 'ITEM EIGHT NOT RETURNABLE'],
  // The separator class is [[:space:][:punct:]], which already covers the
  // hyphen — an automated reviewer read it as whitespace-only, so the
  // hyphenated form is pinned here rather than left to a comment thread.
  ['NOT-RETURNABLE, hyphenated', 'ITEM NINE NOT-RETURNABLE'],
  ['NOTRETURNABLE, run together', 'ITEM TEN NOTRETURNABLE'],
  ['FINAL SALE', 'ITEM ELEVEN FINAL SALE'],
  ['ALL SALES FINAL, reversed word order', 'ITEM TWELVE ALL SALES FINAL'],
  ['ALL SALES ARE FINAL, with the filler verb', 'ITEM THIRTEEN ALL SALES ARE FINAL'],
  ['lower case still matches', 'item fourteen no return'],
];

// Near misses. Each of these contains the letters of a trigger phrase but does
// not assert a no-return policy; flagging one would send Mason chasing a
// product that is perfectly returnable.
const MUST_NOT_MATCH: Array<[string, string]> = [
  ['"no" inside another word', 'MONO RETURN COMPONENT'],
  ['"no" inside another word, plural', 'TECHNO RETURNS UNIT'],
  ['ordinary product name', 'ITEM FIFTEEN 2.5 GAL'],
  ['bare NR formulation code is deliberately out of scope', 'ITEM SIXTEEN 280 NR'],
  ['the word return alone is not an assertion', 'RETURN FREIGHT SURCHARGE'],
  // A non-return valve is spray equipment; the phrase describes how it moves
  // fluid, not whether Crop RX will take it back.
  ['NON-RETURN VALVE is equipment, not a policy', 'NON-RETURN VALVE KIT'],
  ['NON RETURN VALVE, unhyphenated', 'ITEM SEVENTEEN NON RETURN VALVE'],
  ['NON-RETURN VALVES, plural', 'NON-RETURN VALVES 3/4 IN'],
];

describe('product-name-vs-return-policy predicate pattern', () => {
  const pattern = toJsRegExp(extractPattern());

  it.each(MUST_MATCH)('flags a name asserting no-return: %s', (_label, sample) => {
    expect(pattern.test(sample)).toBe(true);
  });

  it.each(MUST_NOT_MATCH)('does not flag: %s', (_label, sample) => {
    expect(pattern.test(sample)).toBe(false);
  });

  it('anchors every alternative at a word boundary', () => {
    // Split on top-level | only — a naive split also breaks up the nested
    // (s|able) group and reports a false failure.
    const raw = extractPattern();
    const alternatives: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of raw) {
      if (ch === '|' && depth === 0) {
        alternatives.push(current);
        current = '';
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      current += ch;
    }
    alternatives.push(current);

    expect(alternatives.length).toBeGreaterThan(1);
    // Each alternative must open with \m. Without it the alternative can match
    // mid-word, which is exactly the "MONO RETURN" false positive.
    for (const alt of alternatives) {
      expect(alt.startsWith('(\\m')).toBe(true);
    }
  });

  it('never selects product_name or sku — the repo is public', () => {
    const sql = readFileSync(PREDICATE, 'utf8');
    const body = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(body).not.toMatch(/\bp\.product_name\b(?![\s\S]{0,40}~\*)/);
    expect(body).not.toMatch(/\bp\.sku\b/);
  });
});

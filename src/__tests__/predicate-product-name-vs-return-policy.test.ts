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

// Split on top-level separators only. A naive split also breaks up nested
// groups — `(s|able)` for the pattern, a comma inside a function call for a
// projection list — and reports a false failure.
function splitTopLevel(source: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of source) {
    if (ch === separator && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    current += ch;
  }
  out.push(current);
  return out;
}

// Every item projected by any SELECT in the predicate. String literals are
// blanked first so their punctuation cannot confuse the split.
function projections(body: string): string[] {
  const masked = body.replace(/'[^']*'/g, "''");
  return [...masked.matchAll(/\bselect\b([\s\S]*?)\bfrom\b/gi)]
    .flatMap((m) => splitTopLevel(m[1], ','))
    .map((item) => item.trim())
    .filter(Boolean);
}

// The complete set of names a projected expression may mention. Anything else
// — another column, another function, a bare table alias — fails the audit.
const ALLOWED_COLUMNS = new Set(['id', 'return_policy', 'is_active']);
const ALLOWED_FUNCTIONS = new Set(['quote_literal']);
const ALLOWED_CAST_TYPES = new Set(['text']);

// Classify every identifier in a projected expression and return the ones that
// are not on an allowlist. Blacklisting row-producing constructors was the
// earlier design and it lost: json_build_object('row', p) passed every check
// while serializing the whole products row, so an allowlist replaced it. The
// decisive rule is the last one — a table alias may appear ONLY as a qualifier
// immediately before a dot, because a bare alias IS the whole row.
function auditExpression(expr: string): string[] {
  const masked = expr.replace(/'[^']*'/g, "''");
  const problems: string[] = [];

  for (const m of masked.matchAll(/[a-z_][a-z0-9_]*/gi)) {
    const ident = m[0];
    const lower = ident.toLowerCase();
    const before = masked.slice(0, m.index);
    const after = masked.slice(m.index + ident.length);

    if (/::\s*$/.test(before)) {
      if (!ALLOWED_CAST_TYPES.has(lower)) problems.push(`cast to ${ident}`);
    } else if (/^\s*\./.test(after)) {
      // A qualifier. The column it qualifies is audited on the next iteration.
    } else if (/\.\s*$/.test(before)) {
      if (!ALLOWED_COLUMNS.has(lower)) problems.push(`column ${ident}`);
    } else if (/^\s*\(/.test(after)) {
      if (!ALLOWED_FUNCTIONS.has(lower)) problems.push(`function ${ident}`);
    } else {
      problems.push(`bare identifier ${ident}`);
    }
  }

  return problems;
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
  // "NON-RETURN VALVE" is the technical name of a check valve and is excluded
  // below; "NON-RETURNABLE VALVE" says the valve cannot be sent back, which is
  // a policy assertion and must still flag. The valve exclusion is therefore
  // narrowed to the RETURN/RETURNS spellings only.
  ['NON-RETURNABLE VALVE is a policy, not the valve type', 'ITEM EIGHTEEN NON-RETURNABLE VALVE'],
  ['NON-RETURNABLE VALVES, plural', 'ITEM NINETEEN NON-RETURNABLE VALVES'],
  // ...and the equipment term is "NON-RETURN VALVE" specifically, so the NO
  // spelling gets no exemption either: a valve marked "NO RETURN" is a policy.
  ['NO RETURN VALVE is a policy, not the valve type', 'ITEM TWENTY NO RETURN VALVE'],
  ['NO-RETURN VALVES, plural', 'ITEM TWENTYONE NO-RETURN VALVES'],
  // Compound wording. The separator class spans whitespace and punctuation
  // only, so an intervening WORD used to break the match entirely and the
  // product kept the 'unknown' default with the sweep silent.
  ['NO REFUNDS OR RETURNS', 'ITEM TWENTYTWO NO REFUNDS OR RETURNS'],
  ['NO REFUND OR RETURN, singular', 'ITEM TWENTYTHREE NO REFUND OR RETURN'],
  ['NO EXCHANGES OR RETURNS', 'ITEM TWENTYFOUR NO EXCHANGES OR RETURNS'],
  ['NO CREDIT RETURNS, no connector word', 'ITEM TWENTYFIVE NO CREDIT RETURNS'],
  ['NOT REFUNDABLE OR RETURNABLE', 'ITEM TWENTYSIX NOT REFUNDABLE OR RETURNABLE'],
  ['NOT EXCHANGEABLE OR RETURNABLE', 'ITEM TWENTYSEVEN NOT EXCHANGEABLE OR RETURNABLE'],
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
  ['NONRETURN VALVE, run together', 'NONRETURN VALVE ASSY'],
  // The intervening-word vocabulary is a closed list for this reason: any
  // filler word between the negation and RETURN would flag these.
  ['unrelated words between NO and RETURN', 'NO TILL SEED RETURN TRAY'],
  ['"no" ending a word, plural', 'CASINO RETURNS DISPLAY'],
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
    const alternatives = splitTopLevel(extractPattern(), '|');

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

    // Alias-agnostic on purpose: an earlier version of this test matched the
    // literal spellings "p.product_name" and "p.sku", so renaming the alias or
    // dropping the qualifier would have slipped a catalog name into the sweep
    // output unnoticed. Match the bare column with any qualifier or none.
    const NAME = /(?:\b[a-z_][a-z0-9_]*\s*\.\s*)?\bproduct_name\b/gi;
    const SKU = /(?:\b[a-z_][a-z0-9_]*\s*\.\s*)?\bsku\b/gi;

    // Exactly one product_name reference is permitted — the ~* filter that
    // decides which rows are flagged. It is compared, never emitted.
    const nameRefs = body.match(NAME) ?? [];
    expect(nameRefs).toHaveLength(1);
    expect(body).toMatch(/(?:\b[a-z_][a-z0-9_]*\s*\.\s*)?\bproduct_name\s*~\*/i);

    // The SKU has no legitimate use here at all.
    expect(body.match(SKU) ?? []).toHaveLength(0);

    // Naming the columns is not enough. `SELECT p.*` emits product_name and sku
    // without spelling either one, so every check above stays green while the
    // sweep leaks the whole catalog row. Enumerating the leak FORMS turned into
    // whack-a-mole — p.*, then a bare * mid-list, then row_to_json(p), then a
    // lone alias, then json_build_object('row', p), which is absent from any
    // constructor blacklist and still serializes every products column. So the
    // rule is inverted: each projected expression may mention only names that
    // are explicitly allowed, and anything unrecognized fails closed.
    for (const item of projections(body)) {
      const expr = item.split(/\bas\b/i)[0].trim();
      // A wildcard is not an identifier, so the audit cannot see it.
      expect(expr, `wildcard projection: ${item}`).not.toMatch(/\*/);
      expect(auditExpression(expr), `unsafe projection: ${item}`).toEqual([]);
    }
  });
});

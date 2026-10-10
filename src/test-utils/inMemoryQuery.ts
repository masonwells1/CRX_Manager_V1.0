import { vi } from 'vitest';

/**
 * A tiny in-memory stand-in for a PostgREST `from(table)` query chain.
 *
 * Unlike a pass-through mock, it actually APPLIES the filters the page builds
 * (eq / neq / is / in / gt / gte / lt / lte / or) to a fixed row set. A test can
 * therefore prove which rows a list query really returns — e.g. that a
 * prior-season open invoice survives the season window — instead of only
 * asserting that some filter method was called.
 *
 * Values compare as strings, which is correct for the ISO dates and timestamps
 * these list queries filter on. Only the operators the invoice lists use are
 * supported; anything else throws so a test cannot silently pass on an
 * unsupported filter.
 */

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function cell(row: Row, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : String(value);
}

function comparison(column: string, op: string, raw: string): Predicate {
  switch (op) {
    case 'eq': return (r) => cell(r, column) === raw;
    case 'neq': return (r) => cell(r, column) !== raw;
    case 'gt': return (r) => { const v = cell(r, column); return v !== null && v > raw; };
    case 'gte': return (r) => { const v = cell(r, column); return v !== null && v >= raw; };
    case 'lt': return (r) => { const v = cell(r, column); return v !== null && v < raw; };
    case 'lte': return (r) => { const v = cell(r, column); return v !== null && v <= raw; };
    case 'is':
      if (raw !== 'null') throw new Error(`inMemoryQuery: unsupported is.${raw}`);
      return (r) => cell(r, column) === null;
    case 'in': {
      if (!raw.startsWith('(') || !raw.endsWith(')')) throw new Error(`inMemoryQuery: bad in list ${raw}`);
      const values = raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      return (r) => values.includes(cell(r, column) ?? '');
    }
    default:
      throw new Error(`inMemoryQuery: unsupported operator ${op}`);
  }
}

/** Parse one PostgREST logic-tree term: `col.op.value`, `and(...)` or `or(...)`. */
function parseTerm(term: string): Predicate {
  const logical = /^(and|or)\((.*)\)$/s.exec(term);
  if (logical) {
    const children = splitTopLevel(logical[2]).map(parseTerm);
    return logical[1] === 'and'
      ? (r) => children.every((p) => p(r))
      : (r) => children.some((p) => p(r));
  }
  const firstDot = term.indexOf('.');
  const secondDot = term.indexOf('.', firstDot + 1);
  if (firstDot < 0 || secondDot < 0) throw new Error(`inMemoryQuery: cannot parse ${term}`);
  return comparison(term.slice(0, firstDot), term.slice(firstDot + 1, secondDot), term.slice(secondDot + 1));
}

export interface InMemoryQueryLog {
  /** Every `.or(...)` expression the page sent, in order. */
  orExpressions: string[];
}

export function buildInMemoryQuery(rows: Row[], log?: InMemoryQueryLog) {
  const predicates: Predicate[] = [];
  let headCount = false;
  let limit: number | null = null;
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = vi.fn((_columns?: string, options?: { count?: string; head?: boolean }) => {
    headCount = Boolean(options?.head);
    return chain;
  });
  chain.eq = vi.fn((c: string, v: unknown) => { predicates.push((r) => cell(r, c) === String(v)); return chain; });
  chain.neq = vi.fn((c: string, v: unknown) => { predicates.push((r) => cell(r, c) !== String(v)); return chain; });
  chain.is = vi.fn((c: string, v: unknown) => {
    if (v !== null) throw new Error('inMemoryQuery: only is(null) is supported');
    predicates.push((r) => cell(r, c) === null);
    return chain;
  });
  chain.in = vi.fn((c: string, values: unknown[]) => {
    const wanted = values.map(String);
    predicates.push((r) => wanted.includes(cell(r, c) ?? ''));
    return chain;
  });
  chain.gt = vi.fn((c: string, v: unknown) => { predicates.push(comparison(c, 'gt', String(v))); return chain; });
  chain.gte = vi.fn((c: string, v: unknown) => { predicates.push(comparison(c, 'gte', String(v))); return chain; });
  chain.lt = vi.fn((c: string, v: unknown) => { predicates.push(comparison(c, 'lt', String(v))); return chain; });
  chain.lte = vi.fn((c: string, v: unknown) => { predicates.push(comparison(c, 'lte', String(v))); return chain; });
  chain.or = vi.fn((expr: string) => {
    log?.orExpressions.push(expr);
    const terms = splitTopLevel(expr).map(parseTerm);
    predicates.push((r) => terms.some((p) => p(r)));
    return chain;
  });
  chain.order = vi.fn(self);
  chain.limit = vi.fn((n: number) => { limit = n; return chain; });

  const result = () => {
    let matched = rows.filter((r) => predicates.every((p) => p(r)));
    if (limit !== null) matched = matched.slice(0, limit);
    return headCount
      ? { data: null, error: null, count: matched.length }
      : { data: matched, error: null, count: matched.length };
  };
  chain.then = (resolve: (value: ReturnType<typeof result>) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve().then(result).then(resolve, reject);
  const first = () => Promise.resolve().then(() => {
    const { data } = result();
    return { data: Array.isArray(data) ? data[0] ?? null : null, error: null };
  });
  chain.maybeSingle = vi.fn(first);
  chain.single = vi.fn(first);
  return chain;
}

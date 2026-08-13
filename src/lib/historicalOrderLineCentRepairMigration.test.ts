import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH =
  'supabase/recovery-replays/20260812154757_repair_historical_order_line_cents_public_replay.sql';
const DIGEST = '0f8ccef3bf6d3291c654d5abb24a151e16ad759851f5eddfc65d1585d7f5b7db';

const migration = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');

function replaceAfter(source: string, start: number, search: string, replacement: string): string {
  const index = source.indexOf(search, start);
  if (index < 0) throw new Error(`mutation target is missing: ${search}`);
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function assertReplaySafe(source: string): void {
  const lock = source.indexOf(
    'LOCK TABLE public.order_items, public.orders IN ACCESS EXCLUSIVE MODE;',
  );
  const derivation = source.indexOf('SELECT jsonb_agg(');
  const dirtyPredicate = source.indexOf(
    'oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2);',
    derivation,
  );
  const digestGuard = source.indexOf(
    `v_snapshot_digest IS DISTINCT FROM '${DIGEST}'`,
  );
  const countGuard = source.indexOf('jsonb_array_length(v_approved) <> 35');
  const siblingCountGuard = source.indexOf('v_impacted_line_count <> 151');
  const impactGuard = source.indexOf(
    'v_header_profit_delta IS DISTINCT FROM (-0.01)::numeric',
  );
  const update = source.indexOf('UPDATE public.order_items AS oi');
  const postimageGuard = source.indexOf('APPROVED_REPAIR_POSTIMAGE_MISMATCH');
  const constraint = source.indexOf(
    'ADD CONSTRAINT order_items_total_price_whole_cents_chk',
  );

  const required = [
    lock,
    derivation,
    dirtyPredicate,
    digestGuard,
    countGuard,
    siblingCountGuard,
    impactGuard,
    update,
    postimageGuard,
    constraint,
  ];
  if (required.some((index) => index < 0)) {
    throw new Error('cent-repair replay contract marker is missing');
  }
  if (!(lock < derivation && derivation < digestGuard && digestGuard < impactGuard && impactGuard < update)) {
    throw new Error('cent-repair write is not behind the locked preimage and impact guards');
  }
  if (!(update < postimageGuard && postimageGuard < constraint)) {
    throw new Error('cent-repair constraint is not behind the mapped postimage guard');
  }
  if (source.includes('APPROVED_SET_WITHHELD') || source.includes('$approved_rows$')) {
    throw new Error('public cent-repair replay still depends on a withheld explicit row map');
  }
}

describe('historical order-line cent repair public recovery replay', () => {
  it('cannot masquerade as the private applied migration source', () => {
    expect(() => readFileSync(
      'supabase/migrations/20260812154757_repair_historical_order_line_cents.sql',
      'utf8',
    )).toThrow();
    expect(migration).toContain('PUBLIC RECOVERY REPLAY — NOT A MIGRATION LEDGER SOURCE');
  });

  it('derives the private candidate set and gates the write on the original full snapshot', () => {
    expect(() => assertReplaySafe(migration)).not.toThrow();
  });

  it('rejects loss of the fixed full-snapshot digest', () => {
    const mutated = migration.split(DIGEST).join('f'.repeat(64));
    expect(() => assertReplaySafe(mutated)).toThrow(/marker is missing/);
  });

  it('rejects a candidate derivation that no longer selects every dirty line', () => {
    const mutated = replaceAfter(
      migration,
      migration.indexOf('SELECT jsonb_agg('),
      'oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2);',
      'false;',
    );
    expect(() => assertReplaySafe(mutated)).toThrow(/marker is missing/);
  });

  it('rejects moving the repair write ahead of the financial-impact guard', () => {
    const mutated = migration.replace(
      '  SELECT count(*)\n    INTO v_profit_change_count',
      '  UPDATE public.order_items AS oi SET total_price = oi.total_price;\n\n'
        + '  SELECT count(*)\n    INTO v_profit_change_count',
    );
    expect(() => assertReplaySafe(mutated)).toThrow(/not behind the locked preimage/);
  });

  it('rejects restoring the unreplayable withheld-map branch', () => {
    const mutated = migration.replace(
      '  v_approved jsonb;',
      "  v_approved jsonb := $approved_rows$ [] $approved_rows$::jsonb;\n  -- APPROVED_SET_WITHHELD",
    );
    expect(() => assertReplaySafe(mutated)).toThrow(/withheld explicit row map/);
  });
});

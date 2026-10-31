import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mason 2026-10-27: a booked price on a sent quote changes straight away; a higher price needs the
// rep's "grower agreed" tick; who, when, the old price and who ticked are recorded. Behaviour is
// proven on a local replay (booking scenarios S19, S19b, S20, S20b, every other scenario
// unchanged); this pins the migration text so the record cannot be skipped or written by users.
const sql = readFileSync('supabase/migrations/20261029120000_booking_price_override.sql', 'utf8')
  .replace(/\r\n/g, '\n');
const code = sql.replace(/--.*$/gm, '');

describe('20261029120000 booking price override', () => {
  it('adds a read-only, RLS-protected record in whole cents', () => {
    expect(code).toContain('CREATE TABLE public.quote_price_changes (');
    expect(code).toMatch(/old_price_cents bigint NOT NULL,\s+new_price_cents bigint NOT NULL,/);
    expect(code).toContain('CHECK (new_price_cents < old_price_cents OR grower_confirmed_by IS NOT NULL)');
    expect(code).toContain('ALTER TABLE public.quote_price_changes ENABLE ROW LEVEL SECURITY;');
    expect(code).toContain('GRANT SELECT ON public.quote_price_changes TO authenticated;');
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)/);
  });

  it('save_quote records each change and refuses an unticked raise', () => {
    expect(code).toContain('IF v_price_locked THEN');
    expect(code).toMatch(/IF v_pc\.new_cents > v_pc\.old_cents AND NOT \(v_confirmed_ids \? \(v_pc\.id::text\)\) THEN\s+RAISE EXCEPTION 'QUOTE_PRICE_RAISE_NEEDS_GROWER_CONFIRMATION:/);
    expect(code).toContain('INSERT INTO quote_price_changes (quote_id, quote_item_id, product_id, old_price_cents, new_price_cents,');
  });

  it('the sent-price check accepts only a line the customer was sent, at its latest recorded price', () => {
    expect(code).toMatch(/WHERE i\.item->>'quote_item_id' = qi\.id::text\s+AND i\.item->>'product_id' = qi\.product_id::text\s+AND \(\s+\(i\.item->>'price_per_unit'\)::numeric = qi\.price_per_unit\s+OR ROUND\(qi\.price_per_unit \* 100\) = \(/);
    expect(code).toContain('ORDER BY c.id DESC LIMIT 1)');
  });

  it('re-emits only the two pinned functions, inside one transaction', () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    expect(code).toContain("'cef92527a26f50ba4c55ef4a4ed810ab'");
    expect(code).toContain("'5a0391efa6a8141dc8ba9b86c31ae38b'");
    expect(code).toContain('DO $preflight$');
    expect(code).toContain('DO $postflight$');
  });
});

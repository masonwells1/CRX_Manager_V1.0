import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const boundary = read('supabase/migrations/20260814063000_quote_sections_rpc_owned.sql');
const boundarySmoke = read('scripts/smoke/smoke-quote-section-write-boundary.sql');
const builder = read('src/pages/QuoteBuilder.tsx');
const prover = read('scripts/smoke/prove-pricing-audit-real-schema.mjs');
const specs = JSON.parse(read('scripts/smoke/smoke-specs.json')) as {
  specs: Record<string, { chain: string; container_only?: boolean; covers?: string[] }>;
};

describe('quote conversion safety boundaries', () => {
  it('makes quote_sections RPC-owned without removing its read path', () => {
    expect(boundary).toContain('DROP POLICY IF EXISTS qsections_insert');
    expect(boundary).toContain('DROP POLICY IF EXISTS qsections_update');
    expect(boundary).toContain('DROP POLICY IF EXISTS qsections_delete');
    expect(boundary).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES\s+ON TABLE public\.quote_sections FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(boundary).not.toMatch(/REVOKE[^;]*\bSELECT\b/i);
    expect(boundary).toContain("policyname = 'qsections_select' AND cmd = 'SELECT'");
    expect(boundary).toContain("has_any_column_privilege(v_role, 'public.quote_sections', v_priv)");
  });

  it('proves every direct browser write is denied and owned sections still render', () => {
    expect(boundarySmoke).toContain('INSERT INTO public.quote_sections');
    expect(boundarySmoke).toContain('UPDATE public.quote_sections');
    expect(boundarySmoke).toContain('DELETE FROM public.quote_sections');
    expect(boundarySmoke).toContain('TRUNCATE public.quote_sections CASCADE');
    expect(boundarySmoke.match(/WHEN insufficient_privilege THEN NULL;/g)).toHaveLength(4);
    expect(boundarySmoke).toContain('authenticated SELECT no longer renders the owned quote section');
    expect(boundarySmoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });

  it('keeps acceptance server-owned when approval is cancelled', () => {
    expect(builder).toContain(': await saveQuote(status);');
    expect(builder).not.toContain("await saveQuote('accepted')");
    expect(builder).not.toContain("setStatus('accepted');");
    expect(builder).toContain('The quote state and inventory reservations were left unchanged; no order was created.');
    expect(builder).not.toContain("supabase.rpc('compensate_quote_conversion_failure'");
    expect(builder).not.toContain(".from('quotes')\n          .update({ status: revertTo })");
  });

  it('registers the container-only boundary smoke in the captured-ledger proof', () => {
    expect(specs.specs.quote_section_write_boundary).toMatchObject({
      chain: 'smoke-quote-section-write-boundary.sql',
      container_only: true,
    });
    expect(prover).toContain("'20260814063000_quote_sections_rpc_owned.sql'");
    expect(prover).toContain("'smoke-quote-section-write-boundary.sql'");
  });
});

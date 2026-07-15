import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const migration = read(
  'supabase',
  'migrations',
  '20260715203911_park_returns_creation_rpc_only.sql',
);
const predicate = read(
  'scripts',
  'db-invariant-sweeps',
  'predicates',
  'returns-lifecycle-rpc-owned.sql',
);
const smoke = read('scripts', 'smoke', 'smoke-return-credit-chain.sql');

describe('applied return creation write boundary', () => {
  it('closes header INSERT without revoking guarded return UPDATE/DELETE', () => {
    const returnTableRevokes = migration
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((statement) => statement.replace(/\s+/g, ' ').trim())
      .filter((statement) => /REVOKE/i.test(statement) && /ON TABLE public\.returns/i.test(statement));

    expect(migration).toContain('APPLIED LIVE (2026-07-15)');
    expect(migration).toContain('Supabase ledger version 20260715203911');
    expect(migration).toMatch(/DROP POLICY IF EXISTS returns_insert ON public\.returns;/i);
    expect(returnTableRevokes).toEqual([
      'REVOKE INSERT ON TABLE public.returns FROM PUBLIC, anon, authenticated',
    ]);
  });

  it('keeps create_return callable and makes direct item writes privilege-closed', () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.return_items\s+FROM PUBLIC, anon, authenticated;/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_return\(jsonb, jsonb, text\)\s+TO authenticated, service_role;/i,
    );
    expect(migration).toContain("p.prosrc LIKE '%INSERT INTO public.returns%'");
    expect(migration).toContain("p.prosrc LIKE '%INSERT INTO public.return_items%'");
  });

  it('has standing catalog drift predicates for policies and inherited privileges', () => {
    expect(predicate).toContain("p.polcmd IN ('a', '*')");
    expect(predicate).toContain(
      "has_table_privilege('authenticated', 'public.returns', 'INSERT')",
    );
    expect(predicate).toContain("has_table_privilege('anon', 'public.returns', 'INSERT')");
    expect(predicate).toContain("p.polcmd IN ('a', 'w', 'd', '*')");
    expect(predicate).toContain(
      "has_table_privilege('authenticated', 'public.return_items', 'DELETE')",
    );
    expect(predicate).toContain("has_table_privilege('anon', 'public.return_items', 'DELETE')");
  });

  it('has rollback-only behavioral probes plus the canonical positive path', () => {
    expect(smoke).toContain("current_user <> 'authenticated'");
    expect(smoke).toMatch(
      /SET LOCAL ROLE authenticated;[\s\S]*current_user <> 'authenticated'[\s\S]*BEGIN\s+INSERT INTO public\.returns[\s\S]*WHEN insufficient_privilege THEN[\s\S]*END;\s+RESET ROLE;/i,
    );
    expect(smoke).toMatch(
      /SET LOCAL ROLE authenticated;[\s\S]*current_user <> 'authenticated'[\s\S]*BEGIN\s+UPDATE public\.return_items[\s\S]*WHEN insufficient_privilege THEN[\s\S]*END;\s+RESET ROLE;/i,
    );
    expect(smoke).toContain('v_res := create_return(');
    expect(smoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });
});

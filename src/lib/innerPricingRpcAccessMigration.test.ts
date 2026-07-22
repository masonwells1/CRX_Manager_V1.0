import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationSql = readFileSync(
  join(repoRoot, 'supabase', 'migrations', '20260722100456_revoke_inner_pricing_rpc_access.sql'),
  'utf8',
);

describe('inner pricing RPC privilege repair migration', () => {
  it('revokes both retained Phase 1a engines from every application role', () => {
    expect(migrationSql).toContain('public.preview_product_pricing_changes(');
    expect(migrationSql).toContain('public.apply_product_pricing_change_set(');
    expect(migrationSql.match(/FROM PUBLIC, anon, authenticated, service_role;/g)).toHaveLength(2);
  });

  it('fails closed unless the governed wrapper pair remains callable', () => {
    expect(migrationSql).toContain('INNER_PRICING_RPC_EXECUTE_PRIVILEGE_DRIFT');
    expect(migrationSql).toContain('GOVERNED_PRICING_WRAPPER_EXECUTE_PRIVILEGE_DRIFT');
    expect(migrationSql).toContain('public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)');
    expect(migrationSql).toContain('public.apply_product_cost_basis_change_set(uuid,text,uuid,text)');
  });
});

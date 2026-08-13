import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260813080000_lock_quote_versions_writes_to_rpc.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const smoke = readFileSync(
  'scripts/smoke/smoke-quote-version-restore-quarantine.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const prover = readFileSync(
  'scripts/smoke/prove-pricing-audit-real-schema.mjs',
  'utf8',
).replace(/\r\n/g, '\n');
const predicate = readFileSync(
  'scripts/db-invariant-sweeps/predicates/quote-version-restore-quarantine.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const specs = JSON.parse(readFileSync('scripts/smoke/smoke-specs.json', 'utf8'));

describe('legacy quote-version restore quarantine', () => {
  it('captures the legacy set inside the same locked transaction as the RPC-only boundary', () => {
    const preflight = migration.indexOf('DO $precond$');
    const preflightEnd = migration.indexOf('$precond$;', preflight);
    const lock = migration.indexOf('LOCK TABLE public.quote_versions IN ACCESS EXCLUSIVE MODE;');
    const createTable = migration.indexOf('CREATE TABLE public.quote_version_restore_quarantine');
    const insert = migration.indexOf(
      'INSERT INTO public.quote_version_restore_quarantine (version_id)',
    );
    const dropPolicy = migration.indexOf(
      'DROP POLICY IF EXISTS qversions_insert ON public.quote_versions;',
    );
    const revokeWrites = migration.indexOf(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES',
    );
    const replaceWrapper = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.restore_quote_version(',
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(preflightEnd).toBeGreaterThan(preflight);
    expect(lock).toBeGreaterThan(preflightEnd);
    expect(createTable).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(createTable);
    expect(dropPolicy).toBeGreaterThan(insert);
    expect(revokeWrites).toBeGreaterThan(dropPolicy);
    expect(replaceWrapper).toBeGreaterThan(revokeWrites);
    expect(migration).toContain('a pre-boundary quote version escaped the atomic quarantine capture');
  });

  it('keeps quarantine private and denies before the restore implementation', () => {
    const wrapperStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.restore_quote_version(',
    );
    const deny = migration.indexOf('QUOTE_VERSION_RESTORE_QUARANTINED', wrapperStart);
    const delegate = migration.indexOf(
      '_restore_quote_version_below_cost_impl_20260810',
      wrapperStart,
    );

    expect(migration).toContain(
      'ALTER TABLE public.quote_version_restore_quarantine ENABLE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain(
      'ALTER TABLE public.quote_version_restore_quarantine FORCE ROW LEVEL SECURITY;',
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.quote_version_restore_quarantine\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(deny).toBeGreaterThan(wrapperStart);
    expect(delegate).toBeGreaterThan(deny);
    for (const key of [
      'quote-version-quarantine:relation-missing',
      'quote-version-quarantine:table-boundary-drifted',
      'quote-version-quarantine:immutability-guard-drifted',
      'quote-version-quarantine:restore-wrapper-drifted',
    ]) {
      expect(predicate).toContain(`'${key}' AS violation_key`);
    }
  });

  it('proves legacy denial and post-boundary create plus restore on the real wrapper', () => {
    expect(smoke).toContain("v_legacy_version uuid := '00000000-0000-4000-9000-000000000017'");
    expect(smoke).toContain("SQLERRM = 'QUOTE_VERSION_RESTORE_QUARANTINED'");
    expect(smoke).toContain('public.create_quote_version(');
    expect(smoke.match(/public\.restore_quote_version\(/g)).toHaveLength(2);
    expect(smoke).toContain("v_restored->>'status' IS DISTINCT FROM 'restored'");
    expect(smoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });

  it('registers and executes the integrated boundary plus container smoke', () => {
    const spec = specs.specs.quote_version_restore_quarantine;
    expect(spec.chain).toBe('smoke-quote-version-restore-quarantine.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.covers).toEqual(['create_quote_version', 'restore_quote_version']);
    expect(prover).toContain("'20260813080000_lock_quote_versions_writes_to_rpc.sql'");
    expect(prover).not.toContain('20260813170000_quarantine_legacy_quote_version_restore.sql');
    expect(prover).toContain("'smoke-quote-version-restore-quarantine.sql'");
    expect(prover).toContain('smoke_quote_version_quarantine=SMOKE_PASS_ROLLBACK');
  });
});

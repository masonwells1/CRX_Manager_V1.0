import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20260813090000_restrict_restore_quote_owner_impl.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('restore quote owner implementation ACL migration', () => {
  it('pins the exact governed wrapper chain before changing permissions', () => {
    expect(sql).toContain("md5(v_owner_body) <> 'd8408e3b19b536f1210e51da3970272e'");
    expect(sql).toContain("<> 'd533d681ebc6ceb94338cd6f77220d71'");
    expect(sql).toContain("<> '322a16413d9ec087ebff86b7ba3bd82c'");
    expect(sql).toContain("<> '712235d2f7d428c885044af57f9fce13'");
    expect(sql).toContain("v_check_body !~ 'IDEMPOTENCY_CROSS_OP_KEY_REUSE'");
    expect(sql).toContain("v_check_body !~ 'v_existing.operation IS DISTINCT FROM p_operation'");
    expect(sql).toContain("t.tgname = 'guard_idempotency_key_insert'");
  });

  it('revokes every application path while preserving postgres execution', () => {
    expect(sql).toMatch(
      /BEGIN;[\s\S]*REVOKE ALL ON FUNCTION public\._restore_quote_version_owner_impl[\s\S]*\$postflight\$;[\s\S]*COMMIT;/,
    );
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._restore_quote_version_owner_impl\(uuid, uuid, uuid, text\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\._restore_quote_version_owner_impl\(uuid, uuid, uuid, text\)\s+TO postgres;/,
    );
    expect(sql).toContain("has_function_privilege('service_role', v_owner_impl, 'EXECUTE')");
    expect(sql).toContain("has_function_privilege('authenticated', v_public_wrapper, 'EXECUTE')");
  });

  it('is permission-only and does not replace a function or mutate business rows', () => {
    expect(sql).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(sql).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE\s+TABLE)\s+public\./i);
  });
});

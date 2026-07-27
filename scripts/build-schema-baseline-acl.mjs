#!/usr/bin/env node

// Build supabase/baselines/<high-water>_acl_lockdown.sql from live introspection.
//
// Input is the raw statement list emitted by:
//   psql -At -f scripts/schema-baseline-acl.sql
//
// The artifact revokes every Supabase-managed role down to nothing, re-grants
// exactly what production holds, and restores the default privileges that govern
// objects created after the restore. Without it a restored project hands the
// unauthenticated `anon` role full CRUD on every table, because a new Supabase
// project's default privileges grant it and `REVOKE ... FROM PUBLIC` does not
// strip a role-specific grant.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [sourceArg, outputArg, highWaterArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || !/^\d{14}$/.test(highWaterArg ?? '')) {
  console.error(
    'Usage: node scripts/build-schema-baseline-acl.mjs <acl-statements.sql> <output.sql> <14-digit-high-water>',
  );
  process.exit(1);
}

const MANAGED_ROLES = ['anon', 'authenticated', 'service_role', 'metabase_ro'];
// PUBLIC is not a role that can be listed in the REVOKE role list twice, but it is a
// legitimate grantee: a new function grants EXECUTE to PUBLIC by default and
// production kept that on part of the schema.
const VALID_GRANTEES = new Set([...MANAGED_ROLES, 'PUBLIC']);
const OBJECT_CLASSES = ['TABLES', 'SEQUENCES', 'ROUTINES'];

const sourcePath = path.resolve(sourceArg);
const outputPath = path.resolve(outputArg);
const statements = readFileSync(sourcePath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (statements.length === 0) {
  throw new Error('no ACL statements were captured; refusing to emit an empty lockdown');
}

const allowed = /^(GRANT .+ TO .+;|ALTER DEFAULT PRIVILEGES FOR ROLE .+ GRANT .+ TO .+;)$/;
for (const [index, statement] of statements.entries()) {
  if (!allowed.test(statement)) {
    throw new Error(`ACL statement ${index + 1} is not a recognised GRANT: ${statement}`);
  }
  const grantee = statement.slice(statement.lastIndexOf(' TO ') + 4, -1);
  if (!VALID_GRANTEES.has(grantee)) {
    throw new Error(`ACL statement ${index + 1} grants to unmanaged role ${grantee}`);
  }
}

const defaultPrivilegeStatements = statements.filter((s) => s.startsWith('ALTER DEFAULT PRIVILEGES'));
if (defaultPrivilegeStatements.length === 0) {
  throw new Error('no default-privilege statements were captured; the lockdown would not bind future objects');
}

const roleList = MANAGED_ROLES.join(', ');
const output = [
  `-- CRX public-schema ACL lockdown at live high-water ${highWaterArg}.`,
  '-- Apply immediately after the public schema baseline, before the platform overlay.',
  '--',
  '-- A schema dump can only GRANT. A new Supabase project already grants `anon`',
  '-- full CRUD on every table and EXECUTE on every function through',
  '-- ALTER DEFAULT PRIVILEGES, and `REVOKE ... FROM PUBLIC` does not strip a',
  '-- role-specific grant. Restoring the schema alone therefore leaves the',
  '-- unauthenticated role holding privileges production revoked. This file resets',
  '-- the managed roles and reproduces production exactly.',
  '',
  'BEGIN;',
  '',
  'DO $baseline_acl_roles$',
  'BEGIN',
  `  IF EXISTS (`,
  `    SELECT 1 FROM unnest(ARRAY[${MANAGED_ROLES.map((r) => `'${r}'`).join(', ')}]) AS required(rolname)`,
  `    WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = required.rolname)`,
  `  ) THEN`,
  `    RAISE EXCEPTION 'BASELINE_ACL_RESTORE_REQUIRES_MANAGED_ROLES';`,
  '  END IF;',
  'END;',
  '$baseline_acl_roles$;',
  '',
  '-- Reset: strip everything the target may have granted on its own.',
  ...OBJECT_CLASSES.map(
    (objects) => `REVOKE ALL ON ALL ${objects} IN SCHEMA "public" FROM PUBLIC, ${roleList};`,
  ),
  ...OBJECT_CLASSES.map(
    (objects) =>
      `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON ${objects} FROM PUBLIC, ${roleList};`,
  ),
  '',
  '-- Reproduce production.',
  ...statements,
  '',
  '-- Fail closed: the reset above must not have left a managed role over-granted.',
  'DO $baseline_acl_verify$',
  'DECLARE',
  '  v_leaked text;',
  'BEGIN',
  '  SELECT string_agg(format(\'%s on %s\', grantee, obj), \', \' ORDER BY obj, grantee)',
  '    INTO v_leaked',
  '  FROM (',
  '    SELECT pg_get_userbyid(a.grantee) AS grantee,',
  '           format(\'%I.%I\', n.nspname, c.relname) AS obj',
  '    FROM pg_class c',
  '    JOIN pg_namespace n ON n.oid = c.relnamespace',
  '    CROSS JOIN LATERAL aclexplode(c.relacl) a',
  "    WHERE n.nspname = 'public'",
  "      AND c.relkind IN ('r', 'p', 'v', 'm')",
  "      AND pg_get_userbyid(a.grantee) = 'anon'",
  "      AND a.privilege_type NOT IN ('SELECT', 'MAINTAIN')",
  '  ) s;',
  '',
  '  IF v_leaked IS NOT NULL THEN',
  "    RAISE EXCEPTION 'BASELINE_ACL_ANON_OVER_GRANTED: %', v_leaked;",
  '  END IF;',
  'END;',
  '$baseline_acl_verify$;',
  '',
  'COMMIT;',
  '',
].join('\n');

writeFileSync(outputPath, output, 'utf8');
console.log(
  JSON.stringify(
    {
      source: sourcePath,
      output: outputPath,
      grant_statements: statements.length,
      default_privilege_statements: defaultPrivilegeStatements.length,
      high_water: highWaterArg,
    },
    null,
    2,
  ),
);

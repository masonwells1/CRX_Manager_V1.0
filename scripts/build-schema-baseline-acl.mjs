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

// The emitted table guard treats PUBLIC as anon, because anon inherits it. If a
// capture ever contains a table or sequence grant to PUBLIC, the artifact would grant
// it and then its own guard would reject it — a file that cannot apply. Catch that
// here, where the message can say what to do, rather than at restore time.
const publicRelationGrants = statements.filter((s) =>
  /^GRANT .+ ON (TABLE|SEQUENCE) .+ TO PUBLIC;$/.test(s),
);
if (publicRelationGrants.length > 0) {
  throw new Error(
    `capture grants ${publicRelationGrants.length} relation privilege(s) to PUBLIC, which anon inherits; ` +
      `review production before baselining: ${publicRelationGrants[0]}`,
  );
}

// Functions cannot be guarded the way tables are. Production legitimately grants
// `anon` EXECUTE on part of the schema — that is how the PostgREST `/rpc/` surface
// works — so "anon holds no EXECUTE" would reject live's own state. What must hold
// after a restore is that anon holds EXECUTE on exactly the functions captured here
// and no others. This is the sharpest check in the file: restoring the public schema
// alone leaves anon holding EXECUTE on *every* function, because the target
// project's default privileges grant it as each one is created. Measured on the
// disposable restore, that is 527 functions before this artifact runs and the
// captured count after.
//
// Extension-owned functions are excluded, matching the capture. They belong to
// `supabase_admin`, the project owner cannot revoke them (the restore logs a
// `no privileges could be revoked` warning for each), and the baseline does not
// manage them. Counting them would make the guard assert something this file has
// no power to enforce.
const anonExecuteGrants = statements.filter((s) =>
  /^GRANT EXECUTE ON FUNCTION .+ TO anon;$/.test(s),
).length;

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
  '  v_anon_execute integer;',
  'BEGIN',
  '  -- Grantee 0 is PUBLIC, and anon inherits everything PUBLIC holds, so a table',
  '  -- privilege granted to PUBLIC reaches the unauthenticated role just as surely as',
  '  -- one granted to anon by name. Filtering on the name alone would let a bad capture',
  '  -- hand PUBLIC write access to a table and still pass. Production grants nothing to',
  '  -- PUBLIC on tables or sequences (only EXECUTE on functions), so this widening',
  '  -- rejects drift without rejecting live. Column privileges are scanned too: they',
  '  -- are not visible in relacl, so a capture that handed anon INSERT on a single',
  '  -- column would otherwise pass a guard that only looked at whole tables.',
  '  SELECT string_agg(format(\'%s on %s\', grantee, obj), \', \' ORDER BY obj, grantee)',
  '    INTO v_leaked',
  '  FROM (',
  '    SELECT CASE WHEN a.grantee = 0 THEN \'PUBLIC\' ELSE pg_get_userbyid(a.grantee) END AS grantee,',
  '           format(\'%I.%I\', n.nspname, c.relname) AS obj',
  '    FROM pg_class c',
  '    JOIN pg_namespace n ON n.oid = c.relnamespace',
  '    CROSS JOIN LATERAL aclexplode(c.relacl) a',
  "    WHERE n.nspname = 'public'",
  "      AND c.relkind IN ('r', 'p', 'v', 'm')",
  "      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) = 'anon')",
  "      AND a.privilege_type NOT IN ('SELECT', 'MAINTAIN')",
  '    UNION ALL',
  '    SELECT CASE WHEN a.grantee = 0 THEN \'PUBLIC\' ELSE pg_get_userbyid(a.grantee) END AS grantee,',
  '           format(\'%I.%I.%I\', n.nspname, c.relname, att.attname) AS obj',
  '    FROM pg_attribute att',
  '    JOIN pg_class c ON c.oid = att.attrelid',
  '    JOIN pg_namespace n ON n.oid = c.relnamespace',
  '    CROSS JOIN LATERAL aclexplode(att.attacl) a',
  "    WHERE n.nspname = 'public'",
  "      AND c.relkind IN ('r', 'p', 'v', 'm')",
  '      AND att.attnum > 0',
  '      AND NOT att.attisdropped',
  "      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) = 'anon')",
  "      AND a.privilege_type NOT IN ('SELECT', 'MAINTAIN')",
  '  ) s;',
  '',
  '  IF v_leaked IS NOT NULL THEN',
  "    RAISE EXCEPTION 'BASELINE_ACL_ANON_OVER_GRANTED: %', v_leaked;",
  '  END IF;',
  '',
  '  SELECT count(*)',
  '    INTO v_anon_execute',
  '  FROM pg_proc p',
  '  JOIN pg_namespace n ON n.oid = p.pronamespace',
  '  CROSS JOIN LATERAL aclexplode(p.proacl) a',
  "  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'",
  "  WHERE n.nspname = 'public'",
  "    AND pg_get_userbyid(a.grantee) = 'anon'",
  "    AND a.privilege_type = 'EXECUTE'",
  '    AND d.objid IS NULL;',
  '',
  `  IF v_anon_execute <> ${anonExecuteGrants} THEN`,
  `    RAISE EXCEPTION 'BASELINE_ACL_ANON_EXECUTE_DRIFTED: expected ${anonExecuteGrants}, found %', v_anon_execute;`,
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
      column_grants: statements.filter((s) => /^GRANT [A-Z]+\(/.test(s)).length,
      anon_execute_grants: anonExecuteGrants,
      high_water: highWaterArg,
    },
    null,
    2,
  ),
);

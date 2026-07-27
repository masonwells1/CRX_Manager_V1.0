#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(repoRoot, 'supabase', 'baselines');
const manifestPath = path.join(baselineDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const fail = (message) => {
  console.error(`SCHEMA_BASELINE_INVALID: ${message}`);
  process.exitCode = 1;
};
const countMatches = (source, pattern) => [...source.matchAll(pattern)].length;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();

if (!/^\d{14}$/.test(manifest.migrations_high_water ?? '')) {
  fail('manifest high-water is not a 14-digit version');
}
// Checked by exact name and position, not by length: an operator restores whatever
// restore_order lists, so a manifest that dropped the ACL lockdown and repeated
// another artifact would still be six entries long and would rebuild a project with
// `anon` over-granted.
const EXPECTED_RESTORE_ORDER = [
  'extensions.sql',
  'public_schema.sql.br',
  'acl_lockdown.sql',
  'platform_overlay.sql',
  'cron_jobs.sql',
  'migration_history.sql',
];
{
  const expected = EXPECTED_RESTORE_ORDER.map(
    (suffix) => `${manifest.migrations_high_water}_${suffix}`,
  );
  const actual = Array.isArray(manifest.restore_order) ? manifest.restore_order : [];
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail(`manifest restore_order must be exactly ${expected.join(', ')}`);
  }
}

// The fingerprints and the ACL capture in this manifest are only meaningful if the
// queries that produced them are recorded and unchanged. Binding each SQL file's
// hash makes a silent edit fail the gate instead of quietly redefining what
// "matches production" means.
for (const [file, field] of [
  ['schema-baseline-fingerprints.sql', 'fingerprint_sql_sha256'],
  ['schema-baseline-acl.sql', 'acl_sql_sha256'],
]) {
  const sqlPath = path.join(repoRoot, 'scripts', file);
  try {
    const actual = sha256(readFileSync(sqlPath));
    if (actual !== manifest[field]) {
      fail(`scripts/${file} sha256 ${actual} does not match manifest ${field} ${manifest[field]}`);
    }
  } catch (error) {
    fail(`scripts/${file} is unreadable: ${error.message}`);
  }
}

// A baseline is only trustworthy once it has actually been restored into a
// throwaway database and matched against live. The required list is enumerated
// rather than inferred from whatever keys happen to be present: iterating the
// object alone would pass a proof that simply omitted the checks it failed.
const REQUIRED_RESTORE_PROOFS = [
  'restore_order_applied_clean',
  'ledger_rows_and_high_water_match_live',
  'all_catalog_fingerprints_match_live',
  'relation_and_function_acl_match_live',
  'function_source_matches_live',
  'history_restore_fail_closed',
  'cron_restore_fail_closed',
  'acl_lockdown_reapply_is_idempotent',
  'post_baseline_migration_replays_clean',
];
{
  const proof = manifest.disposable_restore_proof;
  if (!proof || typeof proof !== 'object') {
    fail('manifest is missing disposable_restore_proof');
  } else {
    if (!Number.isInteger(proof.postgres_major)) {
      fail('disposable_restore_proof.postgres_major must be the integer major version restored into');
    }
    for (const check of REQUIRED_RESTORE_PROOFS) {
      if (!Object.hasOwn(proof, check)) {
        fail(`disposable_restore_proof is missing required proof ${check}`);
      }
    }
    for (const [check, value] of Object.entries(proof)) {
      if (check !== 'postgres_major' && value !== true) {
        fail(`disposable_restore_proof.${check} is not true`);
      }
    }
  }
}

const decodedArtifacts = new Map();
for (const [name, expected] of Object.entries(manifest.artifacts ?? {})) {
  const artifactPath = path.join(baselineDir, name);
  let buffer;
  try {
    buffer = readFileSync(artifactPath);
  } catch (error) {
    fail(`${name} is missing: ${error.message}`);
    continue;
  }
  if (statSync(artifactPath).size !== expected.bytes) {
    fail(`${name} byte length drifted`);
  }
  if (sha256(buffer) !== expected.sha256) {
    fail(`${name} SHA-256 drifted`);
  }
  let decoded = buffer;
  if (expected.encoding === 'brotli') {
    try {
      decoded = brotliDecompressSync(buffer);
    } catch (error) {
      fail(`${name} Brotli payload is invalid: ${error.message}`);
      continue;
    }
    if (decoded.length !== expected.decoded_bytes) {
      fail(`${name} decoded byte length drifted`);
    }
    if (sha256(decoded) !== expected.decoded_sha256) {
      fail(`${name} decoded SHA-256 drifted`);
    }
  } else if (expected.encoding) {
    fail(`${name} has unsupported encoding ${expected.encoding}`);
    continue;
  }
  decodedArtifacts.set(name, decoded);
}

const publicSchemaName = `${manifest.migrations_high_water}_public_schema.sql.br`;
const publicSchema = decodedArtifacts.get(publicSchemaName)?.toString('utf8') ?? '';
if (!publicSchema) {
  fail(`${publicSchemaName} did not decode to SQL`);
}
const platformOverlay = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_platform_overlay.sql`),
  'utf8',
);
const extensions = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_extensions.sql`),
  'utf8',
);
if (!extensions.includes("rolname = 'metabase_ro'") ||
    !extensions.includes('CREATE ROLE metabase_ro NOLOGIN')) {
  fail('extension bootstrap does not provision the metabase_ro grant target');
}
const cronJobs = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_cron_jobs.sql`),
  'utf8',
);
const history = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_migration_history.sql`),
  'utf8',
);
const aclLockdown = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_acl_lockdown.sql`),
  'utf8',
);
const buckets = JSON.parse(
  readFileSync(
    path.join(baselineDir, `${manifest.migrations_high_water}_storage_buckets.json`),
    'utf8',
  ),
);

const expectedCounts = manifest.catalog_counts;
const extensionFunctionSignatures = manifest.public_extension_function_signatures;
if (!Array.isArray(extensionFunctionSignatures) ||
    extensionFunctionSignatures.length !== expectedCounts.public_extension_functions ||
    new Set(extensionFunctionSignatures).size !== extensionFunctionSignatures.length) {
  fail('public extension function signature inventory is missing, duplicated, or count-drifted');
}
const staticCounts = {
  public_tables: countMatches(publicSchema, /^CREATE TABLE /gm),
  public_app_functions: countMatches(publicSchema, /^CREATE (?:OR REPLACE )?FUNCTION /gm),
  public_extension_functions: extensionFunctionSignatures.length,
  public_policies: countMatches(publicSchema, /^CREATE POLICY /gm),
  storage_object_policies: countMatches(platformOverlay, /^CREATE POLICY /gm),
  storage_buckets: buckets.length,
  auth_user_crx_triggers: countMatches(
    platformOverlay,
    /^CREATE OR REPLACE TRIGGER "on_auth_user_created"/gm,
  ),
};
for (const [key, actual] of Object.entries(staticCounts)) {
  if (actual !== expectedCounts[key]) {
    fail(`${key} expected ${expectedCounts[key]}, found ${actual}`);
  }
}
if (countMatches(platformOverlay, /^DROP POLICY IF EXISTS /gm) !== expectedCounts.storage_object_policies) {
  fail('platform overlay does not replace every captured Storage policy');
}
const bucketInsertValues = platformOverlay.match(
  /INSERT INTO "storage"\."buckets"[\s\S]*?\nVALUES\n([\s\S]*?);\r?\nCOMMIT;/,
)?.[1] ?? '';
if (countMatches(bucketInsertValues, /^\s+\('/gm) !== expectedCounts.storage_buckets) {
  fail('platform overlay bucket row count drifted from the bucket snapshot');
}
const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const expectedBucketInsertValues = buckets.map((bucket, index) => {
  const mimeTypes = bucket.allowed_mime_types == null
    ? 'NULL'
    : `ARRAY[${bucket.allowed_mime_types.map(quoteLiteral).join(', ')}]::text[]`;
  const row = [
    quoteLiteral(bucket.id),
    quoteLiteral(bucket.name),
    bucket.public ? 'true' : 'false',
    bucket.file_size_limit == null ? 'NULL' : String(bucket.file_size_limit),
    mimeTypes,
  ].join(', ');
  return `  (${row})${index === buckets.length - 1 ? '' : ','}`;
}).join('\n');
if (bucketInsertValues !== expectedBucketInsertValues) {
  fail('platform overlay bucket contents drifted from the bucket snapshot');
}

for (const extension of ['pg_cron', 'pgcrypto', 'postgis', 'uuid-ossp', 'plpgsql_check']) {
  if (!extensions.includes(`EXTENSION IF NOT EXISTS ${extension}`) &&
      !extensions.includes(`EXTENSION IF NOT EXISTS "${extension}"`)) {
    fail(`extension prerequisite ${extension} is missing`);
  }
}

const cronMatches = [...cronJobs.matchAll(
  /^SELECT cron\.schedule\('([^']+)', '([^']+)', '([^']+)'\);$/gm,
)];
if (cronMatches.length !== expectedCounts.operational_cron_jobs) {
  fail(`operational_cron_jobs expected ${expectedCounts.operational_cron_jobs}, found ${cronMatches.length}`);
} else {
  const contract = cronMatches
    .map(([, name, schedule, command]) => `${name}|${schedule}|${command}`)
    .sort()
    .join('\n');
  const contractHash = createHash('md5').update(contract).digest('hex');
  if (contractHash !== manifest.catalog_fingerprints.cron_contracts) {
    fail('cron job contract fingerprint drifted');
  }
}
if (!cronJobs.includes('BASELINE_CRON_RESTORE_REQUIRES_ABSENT_JOBS')) {
  fail('cron restore is not fail-closed');
}

// The ACL lockdown is the artifact that stops a restored project from handing the
// unauthenticated `anon` role the full CRUD that a new Supabase project's default
// privileges grant. Its shape is checked statically so a truncated or reordered
// capture cannot be published as a lockdown.
{
  const managedRoles = ['anon', 'authenticated', 'service_role', 'metabase_ro'];
  const roleList = managedRoles.join(', ');
  for (const objects of ['TABLES', 'SEQUENCES', 'ROUTINES']) {
    if (!aclLockdown.includes(`REVOKE ALL ON ALL ${objects} IN SCHEMA "public" FROM PUBLIC, ${roleList};`)) {
      fail(`ACL lockdown does not reset existing ${objects} privileges`);
    }
    if (!aclLockdown.includes(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON ${objects} FROM PUBLIC, ${roleList};`,
    )) {
      fail(`ACL lockdown does not reset default privileges for ${objects}`);
    }
  }
  for (const sentinel of ['BASELINE_ACL_RESTORE_REQUIRES_MANAGED_ROLES', 'BASELINE_ACL_ANON_OVER_GRANTED']) {
    if (!aclLockdown.includes(sentinel)) {
      fail(`ACL lockdown is missing the ${sentinel} guard`);
    }
  }
  const grants = [...aclLockdown.matchAll(/^GRANT .+ TO .+;$/gm)];
  const defaultGrants = [...aclLockdown.matchAll(/^ALTER DEFAULT PRIVILEGES FOR ROLE .+ GRANT .+ TO .+;$/gm)];
  const statements = grants.length + defaultGrants.length;
  if (statements !== manifest.acl_statements) {
    fail(`acl_statements expected ${manifest.acl_statements}, found ${statements}`);
  }
  if (defaultGrants.length === 0) {
    fail('ACL lockdown re-grants nothing by default; future migrations would inherit the target project defaults');
  }
  // Reading a table is gated by RLS; writing to one is not something the
  // unauthenticated role may ever be handed by a published baseline. Sequences are
  // deliberately not covered: production grants anon USAGE/UPDATE on them, which is
  // the stock Supabase posture and only allows drawing a number, not reading rows.
  const anonWrites = [...aclLockdown.matchAll(/^GRANT (.+) ON TABLE (\S+) TO anon;$/gm)].filter(([, privileges]) =>
    privileges.split(', ').some((privilege) => !['SELECT', 'MAINTAIN'].includes(privilege)),
  );
  if (anonWrites.length > 0) {
    fail(`ACL lockdown grants anon write access on ${anonWrites.map(([, , object]) => object).join(', ')}`);
  }
}

const historyLines = history.split(/\r?\n/);
const copyStart = historyLines.findIndex((line) =>
  line.startsWith('COPY "supabase_migrations"."schema_migrations"'),
);
const copyEnd = historyLines.indexOf('\\.', copyStart + 1);
if (copyStart < 0 || copyEnd < 0) {
  fail('migration history COPY block is missing');
} else {
  const rows = historyLines.slice(copyStart + 1, copyEnd).map((line) => {
    const [version, name, ...extra] = line.split('\t');
    if (extra.length > 0 || !/^\d{14}$/.test(version) || !name) {
      fail(`invalid migration history row: ${line}`);
    }
    return { version, name };
  });
  const versions = new Set(rows.map(({ version }) => version));
  if (rows.length !== manifest.migration_ledger_rows || versions.size !== rows.length) {
    fail('migration history row count or uniqueness drifted');
  }
  if ([...versions].sort().at(-1) !== manifest.migrations_high_water) {
    fail('migration history high-water drifted');
  }
}

if (!history.includes('BASELINE_HISTORY_RESTORE_REQUIRES_EMPTY_LEDGER')) {
  fail('migration history restore is not fail-closed');
}
if (/^(COPY|INSERT INTO) "public"/m.test(publicSchema)) {
  fail('public schema baseline unexpectedly contains business data');
}

const secretPatterns = [
  /postgres(?:ql)?:\/\//i,
  /SUPABASE_(?:SERVICE_ROLE|ANON)_KEY/i,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}/,
];
for (const [name] of Object.entries(manifest.artifacts ?? {})) {
  const source = decodedArtifacts.get(name)?.toString('utf8') ?? '';
  if (secretPatterns.some((pattern) => pattern.test(source))) {
    fail(`${name} contains a credential-shaped value`);
  }
}

if (!process.exitCode) {
  console.log(
    `SCHEMA_BASELINE_PASS high_water=${manifest.migrations_high_water} ledger_rows=${manifest.migration_ledger_rows}`,
  );
}

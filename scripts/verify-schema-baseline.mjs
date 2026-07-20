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
if (!Array.isArray(manifest.restore_order) || manifest.restore_order.length !== 5) {
  fail('manifest restore_order must contain five ordered SQL artifacts');
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
const cronJobs = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_cron_jobs.sql`),
  'utf8',
);
const history = readFileSync(
  path.join(baselineDir, `${manifest.migrations_high_water}_migration_history.sql`),
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
  public_app_functions: countMatches(publicSchema, /^CREATE OR REPLACE FUNCTION /gm),
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

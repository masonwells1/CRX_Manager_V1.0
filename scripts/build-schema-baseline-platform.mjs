#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [schemaArg, bucketsArg, outputArg, highWaterArg, foundationArg] = process.argv.slice(2);
if (!schemaArg || !bucketsArg || !outputArg || !/^\d{14}$/.test(highWaterArg ?? '')) {
  console.error(
    'Usage: node scripts/build-schema-baseline-platform.mjs <auth-storage-dump.sql> <buckets.json> <output.sql> <14-digit-high-water> [platform-foundation.sql]',
  );
  process.exit(1);
}

const schemaPath = path.resolve(schemaArg);
const bucketsPath = path.resolve(bucketsArg);
const outputPath = path.resolve(outputArg);
const source = readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n');
const buckets = JSON.parse(readFileSync(bucketsPath, 'utf8'));

if (!Array.isArray(buckets) || buckets.length === 0) {
  throw new Error('storage bucket snapshot must be a non-empty array');
}

const triggerMatch = source.match(
  /^CREATE OR REPLACE TRIGGER "on_auth_user_created"[^;]+;$/m,
);
if (!triggerMatch) {
  throw new Error('on_auth_user_created trigger was not found in the platform schema dump');
}

const policyMatches = source.match(/^CREATE POLICY[\s\S]*?;$/gm) ?? [];
const policies = policyMatches.filter((statement) =>
  statement.includes(' ON "storage"."objects" '),
);
if (policies.length === 0 || policies.length !== policyMatches.length) {
  throw new Error('platform schema dump contained missing or unexpected policies');
}

const policyNames = policies.map((statement) => {
  const match = statement.match(/^CREATE POLICY "([^"]+)"/);
  if (!match) throw new Error('could not parse storage policy name');
  return match[1];
});
if (new Set(policyNames).size !== policyNames.length) {
  throw new Error('platform schema dump contained duplicate storage policy names');
}

const bucketIds = buckets.map((bucket) => bucket.id);
if (bucketIds.some((id) => typeof id !== 'string' || id.length === 0)) {
  throw new Error('storage bucket snapshot contains an invalid id');
}
if (new Set(bucketIds).size !== bucketIds.length) {
  throw new Error('storage bucket snapshot contains duplicate ids');
}

const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const nullableInteger = (value) => (value == null ? 'NULL' : String(value));
const textArray = (values) =>
  values == null
    ? 'NULL'
    : `ARRAY[${values.map(quoteLiteral).join(', ')}]::text[]`;

const bucketRows = buckets.map((bucket) =>
  [
    quoteLiteral(bucket.id),
    quoteLiteral(bucket.name),
    bucket.public ? 'true' : 'false',
    nullableInteger(bucket.file_size_limit),
    textArray(bucket.allowed_mime_types),
  ].join(', '),
);

const output = [
  `-- CRX Supabase platform overlay at live high-water ${highWaterArg}.`,
  '-- Apply after the matching public schema baseline on a NEW Supabase project.',
  '-- This restores only CRX-owned auth/storage objects; Supabase owns the platform schemas.',
  'BEGIN;',
  '',
  '-- Fail closed: this artifact is a from-zero restore step, not a converger.',
  '--',
  '-- Its DROP POLICY IF EXISTS lines cover only the policy names live holds today, so',
  '-- applying it to a database that still carries a *previous* baseline\'s policies would',
  '-- leave those retired names in place. Policies are OR\'ed, so a retired unscoped policy',
  '-- surviving next to its scoped replacement silently widens access.',
  '--',
  '-- In practice that cannot happen: the bucket INSERT below has no ON CONFLICT, so a',
  '-- second apply dies on a primary-key collision and the whole transaction rolls back.',
  '-- That protection is accidental, though, and it reports itself as an opaque',
  '-- "duplicate key value violates unique constraint" error. This guard makes the refusal',
  '-- deliberate and legible instead, and stops depending on the INSERT to enforce it.',
  'DO $baseline_platform_buckets$',
  'BEGIN',
  '  IF EXISTS (',
  `    SELECT 1 FROM "storage"."buckets" WHERE "id" = ANY (ARRAY[${bucketIds
    .map(quoteLiteral)
    .join(', ')}]::text[])`,
  '  ) THEN',
  "    RAISE EXCEPTION 'BASELINE_PLATFORM_RESTORE_REQUIRES_ABSENT_BUCKETS';",
  '  END IF;',
  'END;',
  '$baseline_platform_buckets$;',
  '',
  'DROP TRIGGER IF EXISTS "on_auth_user_created" ON "auth"."users";',
  triggerMatch[0],
  '',
  ...policyNames.map(
    (name) =>
      `DROP POLICY IF EXISTS ${quoteIdentifier(name)} ON "storage"."objects";`,
  ),
  '',
  ...policies,
  '',
  'INSERT INTO "storage"."buckets"',
  '  ("id", "name", "public", "file_size_limit", "allowed_mime_types")',
  'VALUES',
  bucketRows.map((row, index) => `  (${row})${index === bucketRows.length - 1 ? '' : ','}`).join('\n') + ';',
  'COMMIT;',
  '',
].join('\n');

writeFileSync(outputPath, output, 'utf8');

let foundationPath = null;
if (foundationArg) {
  foundationPath = path.resolve(foundationArg);
  let foundation = source.replace(triggerMatch[0], '');
  for (const policy of policies) foundation = foundation.replace(policy, '');
  writeFileSync(foundationPath, foundation, 'utf8');
}

console.log(
  JSON.stringify({
    schema_source: schemaPath,
    bucket_source: bucketsPath,
    output: outputPath,
    platform_foundation: foundationPath,
    policies: policies.length,
    buckets: buckets.length,
    high_water: highWaterArg,
  }),
);

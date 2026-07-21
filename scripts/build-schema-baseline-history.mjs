#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [sourceArg, outputArg, highWaterArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || !/^\d{14}$/.test(highWaterArg ?? '')) {
  console.error(
    'Usage: node scripts/build-schema-baseline-history.mjs <pg_dump.sql> <output.sql> <14-digit-high-water>',
  );
  process.exit(1);
}

const sourcePath = path.resolve(sourceArg);
const outputPath = path.resolve(outputArg);
const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/);
const copyStart = lines.findIndex((line) =>
  line.startsWith('COPY "supabase_migrations"."schema_migrations"'),
);
const copyEnd = lines.indexOf('\\.', copyStart + 1);
if (copyStart < 0 || copyEnd < 0) {
  throw new Error('schema_migrations COPY block was not found in the source dump');
}

const rows = lines.slice(copyStart + 1, copyEnd).map((line, index) => {
  const fields = line.split('\t');
  if (fields.length !== 6) {
    throw new Error(`schema_migrations row ${index + 1} has ${fields.length} fields, expected 6`);
  }
  const [version, , name] = fields;
  if (!/^\d{14}$/.test(version)) {
    throw new Error(`schema_migrations row ${index + 1} has invalid version ${version}`);
  }
  return { version, name };
});

const versions = new Set(rows.map((row) => row.version));
if (versions.size !== rows.length) {
  throw new Error('schema_migrations dump contains duplicate versions');
}
if (!versions.has(highWaterArg) || [...versions].sort().at(-1) !== highWaterArg) {
  throw new Error(`requested high-water ${highWaterArg} does not match the dumped ledger`);
}

const output = [
  `-- CRX production migration-ledger baseline at live high-water ${highWaterArg}.`,
  '-- Restore only into a NEW Supabase project after applying the matching public schema baseline.',
  '-- The fail-closed check prevents overwriting an existing migration ledger.',
  'BEGIN;',
  'DO $baseline_guard$',
  'BEGIN',
  '  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations) THEN',
  "    RAISE EXCEPTION 'BASELINE_HISTORY_RESTORE_REQUIRES_EMPTY_LEDGER';",
  '  END IF;',
  'END;',
  '$baseline_guard$;',
  'COPY "supabase_migrations"."schema_migrations" ("version", "name") FROM stdin;',
  ...rows.map(({ version, name }) => `${version}\t${name}`),
  '\\.',
  'COMMIT;',
  '',
].join('\n');

writeFileSync(outputPath, output, 'utf8');
console.log(
  JSON.stringify({
    source: sourcePath,
    output: outputPath,
    rows: rows.length,
    high_water: highWaterArg,
  }),
);

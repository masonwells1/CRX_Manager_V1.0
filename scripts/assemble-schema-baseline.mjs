#!/usr/bin/env node

// Assemble supabase/baselines/ from reviewed live introspection.
//
// This does NOT talk to the database. It consumes files produced by the
// documented read-only capture step in supabase/baselines/README.md and emits
// the seven hash-bound artifacts plus manifest.json. Keeping capture and assembly
// separate means the assembly is deterministic and reviewable.
//
// Usage:
//   node scripts/assemble-schema-baseline.mjs <work-dir> <14-digit-high-water>
//
// Expected in <work-dir> (see README "Refreshing the baseline"):
//   public_schema.sql                    build-schema-baseline-public.mjs
//   <high-water>_acl_lockdown.sql        build-schema-baseline-acl.mjs
//   <high-water>_platform_overlay.sql    build-schema-baseline-platform.mjs
//   <high-water>_storage_buckets.json    live storage.buckets snapshot
//   <high-water>_migration_history.sql   build-schema-baseline-history.mjs
//   live_fingerprints.txt                scripts/schema-baseline-fingerprints.sql output
//   ext_sigs.txt                         public extension function signatures
//   key_fn_md5.txt                       pinned function body md5s
//   counts.txt                           live catalog counts
//   restore_proof.json                   disposable restore proof result

import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

const [workArg, highWater] = process.argv.slice(2);
if (!workArg || !/^\d{14}$/.test(highWater ?? '')) {
  console.error('Usage: node scripts/assemble-schema-baseline.mjs <work-dir> <14-digit-high-water>');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(repoRoot, 'supabase', 'baselines');
const work = path.resolve(workArg);
const read = (name) => readFileSync(path.join(work, name), 'utf8');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex').toUpperCase();

const pairs = (text) =>
  Object.fromEntries(
    text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.lastIndexOf('=');
        if (index < 0) throw new Error(`expected key=value, got: ${line}`);
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

const fingerprints = pairs(read('live_fingerprints.txt'));

// The fingerprints are the fidelity contract, so the capture has to be complete before
// it is published. A psql run that died partway still leaves a well-formed key=value
// file, and every later comparison would then be made against whatever survived. The
// expected names are derived from the recorded SQL itself rather than duplicated here,
// so adding a digest to that file cannot leave this check behind.
{
  const fingerprintSql = readFileSync(
    path.join(repoRoot, 'scripts', 'schema-baseline-fingerprints.sql'),
    'utf8',
  );
  // Tolerant of whitespace on purpose. A stricter pattern silently shrinks the
  // expected set when the SQL is reformatted, which turns this guard into the very
  // thing it exists to prevent: a digest quietly dropped from the contract.
  const expected = [...fingerprintSql.matchAll(/^\s*SELECT\s+'([a-z_]+)'\s*,\s*md5\s*\(/gm)].map(
    (m) => m[1],
  );
  if (expected.length === 0) {
    throw new Error('scripts/schema-baseline-fingerprints.sql declares no fingerprints');
  }
  const missing = expected.filter((name) => !/^[0-9a-f]{32}$/.test(fingerprints[name] ?? ''));
  if (missing.length > 0) {
    throw new Error(
      `live_fingerprints.txt is missing a valid md5 for: ${missing.join(', ')}; ` +
        're-run the capture against live',
    );
  }
  const unexpected = Object.keys(fingerprints).filter((name) => !expected.includes(name));
  if (unexpected.length > 0) {
    throw new Error(
      `live_fingerprints.txt has fingerprints the recorded SQL does not define: ${unexpected.join(', ')}`,
    );
  }
}
const keyFunctionMd5 = pairs(read('key_fn_md5.txt'));
const counts = pairs(read('counts.txt'));
const extensionSignatures = read('ext_sigs.txt').trim().split(/\r?\n/).filter(Boolean);
const restoreProof = JSON.parse(read('restore_proof.json'));

// Header rewrite: the extension and cron artifacts are stable text whose only
// version-dependent content is the high-water stamped in their header comment.
// Carrying them forward verbatim keeps their reviewed hard stops intact.
const restamp = (name) => {
  const source = readFileSync(path.join(baselineDir, name), 'utf8');
  const previous = name.slice(0, 14);
  // The stamp is expected exactly once, in the header comment. Asserting that
  // before rewriting keeps a coincidental 14-digit run elsewhere in the file — a
  // cron schedule, a literal, a migration version in a comment — from being
  // silently rewritten along with it.
  const occurrences = source.split(previous).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${name} contains ${occurrences} occurrences of ${previous}; expected exactly 1`);
  }
  return source.replaceAll(previous, highWater);
};

const artifactNames = {
  extensions: `${highWater}_extensions.sql`,
  publicSchema: `${highWater}_public_schema.sql.br`,
  aclLockdown: `${highWater}_acl_lockdown.sql`,
  platformOverlay: `${highWater}_platform_overlay.sql`,
  cronJobs: `${highWater}_cron_jobs.sql`,
  history: `${highWater}_migration_history.sql`,
  buckets: `${highWater}_storage_buckets.json`,
};

const previousManifest = JSON.parse(readFileSync(path.join(baselineDir, 'manifest.json'), 'utf8'));
const previousHighWater = previousManifest.migrations_high_water;

writeFileSync(
  path.join(baselineDir, artifactNames.extensions),
  restamp(`${previousHighWater}_extensions.sql`),
  'utf8',
);
writeFileSync(
  path.join(baselineDir, artifactNames.cronJobs),
  restamp(`${previousHighWater}_cron_jobs.sql`),
  'utf8',
);
for (const [source, target] of [
  [`${highWater}_acl_lockdown.sql`, artifactNames.aclLockdown],
  [`${highWater}_platform_overlay.sql`, artifactNames.platformOverlay],
  [`${highWater}_migration_history.sql`, artifactNames.history],
  [`${highWater}_storage_buckets.json`, artifactNames.buckets],
]) {
  copyFileSync(path.join(work, source), path.join(baselineDir, target));
}

// The public schema is stored Brotli-compressed: an expanded 60k+ line generated
// artifact blows past reviewer request limits when Git renders its full diff.
const publicSchema = readFileSync(path.join(work, 'public_schema.sql'));
const compressed = brotliCompressSync(publicSchema, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});
writeFileSync(path.join(baselineDir, artifactNames.publicSchema), compressed);

const artifacts = {};
for (const name of Object.values(artifactNames).sort()) {
  const filePath = path.join(baselineDir, name);
  const buffer = readFileSync(filePath);
  artifacts[name] = { bytes: statSync(filePath).size, sha256: sha256(buffer) };
  if (name.endsWith('.br')) {
    artifacts[name].encoding = 'brotli';
    artifacts[name].decoded_bytes = publicSchema.length;
    artifacts[name].decoded_sha256 = sha256(publicSchema);
  }
}

const manifest = {
  format_version: 3,
  project_id: previousManifest.project_id,
  generated_at: new Date().toISOString(),
  migrations_high_water: highWater,
  migration_ledger_rows: Number(counts.ledger_rows),
  fingerprint_sql_sha256: sha256(
    readFileSync(path.join(repoRoot, 'scripts', 'schema-baseline-fingerprints.sql')),
  ),
  acl_sql_sha256: sha256(readFileSync(path.join(repoRoot, 'scripts', 'schema-baseline-acl.sql'))),
  acl_statements: readFileSync(path.join(work, `${highWater}_acl_lockdown.sql`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^(GRANT|ALTER DEFAULT PRIVILEGES FOR ROLE) .+ TO .+;$/.test(line)).length,
  restore_order: [
    artifactNames.extensions,
    artifactNames.publicSchema,
    artifactNames.aclLockdown,
    artifactNames.platformOverlay,
    artifactNames.cronJobs,
    artifactNames.history,
  ],
  artifacts,
  catalog_counts: {
    public_tables: Number(counts.public_tables),
    public_app_functions: Number(counts.public_app_functions),
    public_extension_functions: Number(counts.public_extension_functions),
    public_policies: Number(counts.public_policies),
    storage_object_policies: Number(counts.storage_object_policies),
    storage_buckets: Number(counts.storage_buckets),
    auth_user_crx_triggers: Number(counts.auth_user_crx_triggers),
    operational_cron_jobs: Number(counts.operational_cron_jobs),
  },
  public_extension_function_signatures: extensionSignatures,
  catalog_fingerprints: fingerprints,
  key_function_prosrc_md5: keyFunctionMd5,
  disposable_restore_proof: restoreProof,
};

writeFileSync(
  path.join(baselineDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

console.log(
  JSON.stringify(
    {
      high_water: highWater,
      previous_high_water: previousHighWater,
      ledger_rows: manifest.migration_ledger_rows,
      artifacts: Object.keys(artifacts).length,
      compressed_bytes: artifacts[artifactNames.publicSchema].bytes,
      decoded_bytes: artifacts[artifactNames.publicSchema].decoded_bytes,
    },
    null,
    2,
  ),
);

#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for the draw-down price-tier split migration
 * (20260816120000_draw_down_split_order_lines_by_price_tier).
 *
 * It restores the supported baseline, replays every ledger-selected migration
 * up to the one immediately BEFORE this candidate, and first proves the smoke
 * FAILS there — the guard it asserts does not exist yet, so a passing run would
 * mean the smoke proves nothing. It then applies the candidate and requires the
 * same smoke to execute to SMOKE_PASS_ROLLBACK. It never reads a DB URL and
 * always removes its network-disabled container.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-draw-tier-schema-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const barrier = path.join(ROOT, 'supabase', 'migrations', '20260816110000_draw_down_cutover_barrier.sql');
const candidate = path.join(ROOT, 'supabase', 'migrations', '20260816120000_draw_down_split_order_lines_by_price_tier.sql');
// The live apply was assigned version 20260816174353; B7 kept the logical
// filename below on disk after that version was recorded in Supabase.
const liveHighWater = path.join(ROOT, 'supabase', 'migrations', '20260813080000_lock_quote_versions_writes_to_rpc.sql');
const smokeFile = path.join(ROOT, 'scripts', 'smoke', 'smoke-restore-version-drawn-guard.sql');
const pricedProductSmokeFiles = [
  path.join(ROOT, 'scripts', 'smoke', 'smoke-order-draw-lock.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-auth-probe-template.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-planned-holds-drawn-sync.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-draw-ledger-reversal.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-job_from_quote_activity_feed_fix.sql'),
];
// Empty, and it must stay empty. The single entry that used to live here
// (20260810010308_active_team_note_assignment_actor.sql) was never real drift:
// copySql() now feeds LF into PostgreSQL, so the function body this migration
// md5-pins matches and all 56 migrations replay. Approving that skip was
// accepting a line-ending artifact as evidence. If an entry ever needs adding
// back, prove it is not a CRLF artifact first.
const expectedSkippedMigrations = [];

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024, ...options });
  if (result.error || (!options.allowFailure && result.status !== 0)) throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  return result;
}
function psql(sql, options = {}) {
  return docker(['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, allowFailure: options.allowFailure });
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
/**
 * Copy SQL into the container as LF, never as the checkout's own bytes.
 * Git hands Windows a CRLF working tree, and `docker cp` would install those
 * bytes verbatim: a function created by a CRLF migration gets a CRLF prosrc,
 * so a LATER migration's LF-based md5 preflight fails and looks exactly like
 * historical live-base drift. That made this proof platform-dependent -- it
 * "passed" on Windows by approving a skip that does not exist on an LF
 * checkout. prove-draw-down-quote-intent-binding.mjs already normalizes;
 * this now matches it. Binary baseline artifacts still use copy() verbatim.
 */
function copySql(local, name) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try {
    writeFileSync(staged, readFileSync(local, 'utf8').replaceAll('\r\n', '\n'), 'utf8');
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally {
    try {
      unlinkSync(staged);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
function apply(name, user) { psql(`\\i /tmp/${name}`, { user }); }
/**
 * Apply one migration the way the real Supabase apply path does: the whole file
 * in a SINGLE transaction. Several migrations use SET LOCAL / LOCK TABLE, which
 * are silently degraded (or hard errors) under psql autocommit, so replaying
 * them statement-at-a-time would not reproduce production behaviour.
 * Verified for this replay set: no migration uses CREATE INDEX CONCURRENTLY,
 * VACUUM, or its own BEGIN/COMMIT, so none of them is transaction-hostile.
 */
function applyMigration(name, options = {}) {
  const result = docker(
    ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', `/tmp/${name}`],
    { allowFailure: options.allowFailure },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    // The image exposes a temporary bootstrap server, stops it, prints this
    // canonical entrypoint marker, and only then execs the final server. Do not
    // accept readiness until that lifecycle boundary has actually occurred.
    const logs = docker(['logs', NAME], { allowFailure: true });
    const initComplete = `${logs.stdout}\n${logs.stderr}`.includes(
      'PostgreSQL init process complete; ready for start up.',
    );
    if (initComplete
      && docker(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
      const query = docker(
        ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'],
        { allowFailure: true },
      );
      if (query.status === 0 && query.stdout.trim() === '1') return;
    }
    wait(500);
  }
  throw new Error(`disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`);
}
function selectedMigrations() {
  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const migrations = result.stdout.split(/\r?\n/).filter((l) => l.startsWith('supabase/migrations/')).map((relative) => path.join(ROOT, relative));
  const candidateIndex = migrations.indexOf(candidate);
  const liveHighWaterIndex = migrations.indexOf(liveHighWater);
  assert.notEqual(candidateIndex, -1, 'candidate migration is not in the ledger-selected post-baseline replay');
  assert.notEqual(liveHighWaterIndex, -1, 'verified live high-water migration is not in the ledger-selected post-baseline replay');
  assert.ok(liveHighWaterIndex < candidateIndex, 'verified live high-water source must precede the parked candidate in disk replay order');
  return migrations.slice(0, candidateIndex + 1);
}
function runSmoke(file, tag) {
  copySql(file, `${tag}-${path.basename(file)}`);
  const result = psql(`\\i /tmp/${tag}-${path.basename(file)}`, { allowFailure: true });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}
function hasRollbackPass(output) {
  return output
    .split(/\r?\n/)
    .some((line) => /^(?:psql:[^:\r\n]+:\d+:\s+)?ERROR:\s+SMOKE_PASS_ROLLBACK\b/.test(line));
}

try {
  assert.equal(hasRollbackPass('NOTICE: SMOKE_PASS_ROLLBACK'), false, 'a notice must not satisfy the rollback pass marker');
  assert.equal(hasRollbackPass('ERROR: SMOKE_FAIL: expected SMOKE_PASS_ROLLBACK'), false, 'a failure quoting the token must not satisfy the rollback pass marker');
  assert.equal(hasRollbackPass('psql:/tmp/smoke.sql:42: ERROR:  SMOKE_PASS_ROLLBACK'), true, 'the anchored psql rollback error must satisfy the pass marker');
  for (const file of [barrier, candidate, liveHighWater, smokeFile, ...pricedProductSmokeFiles]) assert.ok(readFileSync(file, 'utf8').length > 0, `missing required artifact ${file}`);
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();

  const artifacts = ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql'];
  for (const artifact of artifacts) copy(path.join(BASELINE, artifact), artifact);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(`baseline decompression failed: ${schema.stderr.toString()}`);
  apply('20260727174805_extensions.sql');
  psql(schema.stdout.toString());
  psql(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
      name text NOT NULL, owner_id text
    );
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
  `, { user: 'supabase_admin' });
  apply('20260727174805_acl_lockdown.sql');
  apply('20260727174805_platform_overlay.sql', 'supabase_admin');
  apply('20260727174805_cron_jobs.sql');
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  apply('20260727174805_migration_history.sql');

  const migrations = selectedMigrations();
  const candidateIndex = migrations.indexOf(candidate);
  const barrierIndex = migrations.indexOf(barrier);
  const liveHighWaterIndex = migrations.indexOf(liveHighWater);
  assert.equal(barrierIndex, liveHighWaterIndex + 1, 'cutover barrier must immediately follow the verified live high-water source');
  assert.equal(candidateIndex, barrierIndex + 1, 'tier-split candidate must immediately follow the cutover barrier');

  // Some already-applied historical migrations open with a PREFLIGHT DO block
  // asserting the exact live base they were authored against (function body
  // md5, policy text, trigger shape). Those are apply-time gates for the LIVE
  // database and were satisfied there; a from-scratch container rebuild is a
  // different base, so such a gate could in principle fail on a divergence that
  // is real but historical and unrelated to this candidate. No migration in
  // this set does so today: every one of them replays. Any PREFLIGHT_FAIL is
  // SKIPPED (the whole migration is one transaction, so nothing partial lands)
  // and REPORTED, and the assertion below fails closed the moment the skip set
  // stops being empty. Any other error is fatal. The candidate's own guards are
  // never skipped.
  const skipped = [];
  for (const [index, migration] of migrations.slice(0, liveHighWaterIndex + 1).entries()) {
    const name = `migration-${index}.sql`;
    copySql(migration, name);
    const applied = applyMigration(name, { allowFailure: true });
    if (applied.status === 0) continue;
    if (!/PREFLIGHT_FAIL/.test(applied.output)) {
      throw new Error(`replay failed on ${path.basename(migration)}:\n${applied.output}`);
    }
    const file = path.basename(migration);
    const reason = (applied.output.match(/PREFLIGHT_FAIL[^\n]*/) ?? ['PREFLIGHT_FAIL'])[0];
    const expected = expectedSkippedMigrations.find((entry) => entry.file === file);
    assert.ok(expected, `unapproved historical PREFLIGHT skip: ${file}\n${reason}`);
    // Git checks out this tracked SQL as CRLF on Windows and LF on Linux.
    // Hash the canonical LF text so the same reviewed migration has one pin
    // across local proof, CI, and the exact-SHA review snapshot.
    const canonicalText = readFileSync(migration, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(
      createHash('sha256').update(canonicalText, 'utf8').digest('hex'),
      expected.sha256,
      `approved historical PREFLIGHT migration content changed: ${file}`,
    );
    assert.equal(reason, expected.reason, `approved historical PREFLIGHT reason changed: ${file}`);
    skipped.push({ file, reason });
  }
  console.log(`[prover] replayed ${liveHighWaterIndex + 1 - skipped.length}/${liveHighWaterIndex + 1} post-baseline migrations through the verified live high-water source`);
  if (skipped.length > 0) {
    console.log(`[prover] SKIPPED ${skipped.length} migration(s) on historical live-base drift:`);
    for (const entry of skipped) console.log(`[prover]   - ${entry.file}\n[prover]     ${entry.reason}`);
  }
  assert.deepEqual(
    skipped.map((entry) => entry.file),
    expectedSkippedMigrations.map((entry) => entry.file),
    'historical PREFLIGHT skip set changed; re-review the replay base before trusting this proof',
  );

  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('00000000-0000-4000-8000-000000000001', 'draw-tier-admin@example.invalid', '{"full_name":"Draw Tier Admin","role":"admin"}'),
      ('00000000-0000-4000-8000-000000000002', 'draw-tier-driver@example.invalid', '{"full_name":"Draw Tier Driver","role":"driver"}'),
      ('00000000-0000-4000-8000-000000000003', 'draw-tier-backup-admin@example.invalid', '{"full_name":"Draw Tier Backup Admin","role":"admin"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, role, is_active) VALUES
      ('00000000-0000-4000-8000-000000000001', 'draw-tier-admin@example.invalid', 'admin', true),
      ('00000000-0000-4000-8000-000000000002', 'draw-tier-driver@example.invalid', 'driver', true),
      ('00000000-0000-4000-8000-000000000003', 'draw-tier-backup-admin@example.invalid', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
  `);

  // The smoke borrows two already-priced products (a real database always has
  // them). This container is schema-only, so seed them here. Pricing cannot be
  // written through the governed trigger without a full previewed change set,
  // so disable that trigger for the seed alone — safe because this container is
  // disposable and the trigger is restored immediately. Nothing here runs
  // against, or resembles a write to, the live database.
  psql(`
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (product_name, unit_size, current_cost, tier1_price)
    VALUES ('[PROVER] Draw Tier A', 'gal', 3.00, 10.00),
           ('[PROVER] Draw Tier B', 'gal', 4.00, 8.00);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
  `);

  // The five pricing-fixture regressions target the verified LIVE schema.
  // Run them before either parked migration so the proof cannot accidentally
  // validate fixtures only after the barrier has replaced draw_down_quote.
  for (const file of pricedProductSmokeFiles) {
    const result = runSmoke(file, 'current-live');
    assert.notEqual(result.status, 0, `${path.basename(file)} unexpectedly committed instead of rolling back:\n${result.output}`);
    assert.equal(hasRollbackPass(result.output), true, `${path.basename(file)} did not execute to SMOKE_PASS_ROLLBACK on the current live schema:\n${result.output}`);
    console.log(`[prover] CURRENT-LIVE PASS ${path.basename(file)}`);
  }

  // Preserve the production apply boundary: barrier and tier-split candidate
  // are separate transactions, with the mutation check between them.
  copySql(barrier, 'barrier.sql');
  applyMigration('barrier.sql');
  console.log('[prover] cutover barrier migration applied');

  // ---- Mutation test: the smoke must NOT pass before the candidate applies ----
  const before = runSmoke(smokeFile, 'before');
  console.log(`[prover] PRE-CANDIDATE smoke tail:\n${before.output.split('\n').slice(-6).join('\n')}`);
  assert.equal(
    hasRollbackPass(before.output),
    false,
    `smoke reached SMOKE_PASS_ROLLBACK BEFORE the candidate applied — it does not actually prove the new guard:\n${before.output}`,
  );
  assert.match(
    before.output,
    /SMOKE_PREREQ: 20260816120000/,
    `pre-candidate smoke did not identify the parked migration as its missing prerequisite:\n${before.output}`,
  );

  // ---- Apply the candidate, then require a real pass ----
  // The candidate is the artifact under review: it must be LF byte-verbatim,
  // not normalized on its way in, so what applies here is what applies live.
  assert.ok(
    !readFileSync(candidate, 'utf8').includes('\r'),
    'candidate migration is not LF byte-verbatim',
  );
  copy(candidate, 'candidate.sql');
  applyMigration('candidate.sql');
  console.log('[prover] candidate migration applied');

  const after = runSmoke(smokeFile, 'after');
  assert.notEqual(after.status, 0, `smoke unexpectedly committed instead of rolling back:\n${after.output}`);
  assert.equal(hasRollbackPass(after.output), true, `smoke did not execute to SMOKE_PASS_ROLLBACK after the candidate applied:\n${after.output}`);

  console.log(`[prover] current-live source replay plus parked candidate reached ${path.basename(migrations.at(-1))}`);

  console.log('DRAW_TIER_REAL_SCHEMA_PASS baseline=20260727174805 live_high_water=20260816174353 priced_product_smokes=5/5 parked_candidate=20260816120000 pre_candidate=SMOKE_PREREQ_AS_REQUIRED post_candidate=SMOKE_PASS_ROLLBACK smoke=smoke-restore-version-drawn-guard.sql');
} catch (error) {
  console.error(`DRAW_TIER_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}

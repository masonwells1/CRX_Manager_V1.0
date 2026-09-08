#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL proof for customer-document Storage visibility.
 *
 * It first proves the historical owner-id OR policy exposes a soft-deleted
 * document, applies the exact forward migration, and then proves:
 *   - soft-deleted bytes are hidden from the uploader immediately;
 *   - live metadata remains readable for the assigned rep;
 *   - a fresh metadata-free upload remains readable for INSERT ... RETURNING;
 *   - the bootstrap expires after five minutes;
 *   - another customer's path remains hidden and unprobeable.
 * Everything runs in one transaction in a disposable, network-less container.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME_PREFIX = `crx-customer-document-soft-delete-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'postgres:17-alpine';
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260908054649_revoke_deleted_customer_document_bytes.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-customer-document-soft-delete-bytes.sql');
const TIMEOUT_MS = 5 * 60 * 1000;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    ...options,
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed${result.error ? ` (${result.error.message})` : ''}:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function waitForDatabase(name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = docker(
      ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    if (ready.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

function runProof(migration, suffix, smoke = SMOKE) {
  const name = `${NAME_PREFIX}-${suffix}`;
  docker([
    'run', '--detach', '--rm', '--name', name,
    '--network', 'none',
    '--env', 'POSTGRES_PASSWORD=postgres',
    IMAGE,
  ]);
  try {
    waitForDatabase(name);
    docker(['cp', migration, `${name}:/tmp/20260908054649_revoke_deleted_customer_document_bytes.sql`]);
    docker(['cp', smoke, `${name}:/tmp/smoke-customer-document-soft-delete-bytes.sql`]);
    return docker([
      'exec', name,
      'psql', '-U', 'postgres', '-d', 'postgres', '-X',
      '-v', 'ON_ERROR_STOP=1',
      '-f', '/tmp/smoke-customer-document-soft-delete-bytes.sql',
    ], { allowFailure: true });
  } finally {
    docker(['rm', '--force', name], { allowFailure: true });
  }
}

const clean = runProof(MIGRATION, 'clean');
const cleanOutput = `${clean.stdout}\n${clean.stderr}`;
if (clean.status !== 0 || !cleanOutput.includes('SMOKE_PASS_ROLLBACK customer_document_soft_delete_bytes')) {
  throw new Error(`Clean proof failed or omitted the rollback marker:\n${cleanOutput}`);
}
process.stdout.write(cleanOutput);

const tempDir = mkdtempSync(path.join(tmpdir(), 'crx-customer-document-mutant-'));
try {
  function expectRejected(result, marker, description) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(marker)) {
      throw new Error(`${description} did not fail at ${marker}:\n${output}`);
    }
  }

  function writeSmokeMutation(filename, needle, replacement) {
    const source = readFileSync(SMOKE, 'utf8');
    if (source.split(needle).length !== 2) throw new Error(`Smoke mutation anchor is not singular: ${needle}`);
    // A replacement function preserves PostgreSQL dollar-quote delimiters;
    // String.replace replacement text interprets `$$` as one literal `$`.
    const mutated = source.replace(needle, () => replacement);
    if (mutated === source) throw new Error(`Smoke mutation made no change: ${needle}`);
    const target = path.join(tempDir, filename);
    writeFileSync(target, mutated, 'utf8');
    return target;
  }

  const source = readFileSync(MIGRATION, 'utf8');
  const needle = 'AND NOT public.customer_document_path_has_metadata_for_actor(storage.objects.name)';
  if (!source.includes(needle)) throw new Error('Mutation anchor is missing from the candidate.');
  const mutantPath = path.join(tempDir, path.basename(MIGRATION));
  writeFileSync(mutantPath, source.replace(needle, 'AND public.customer_document_path_has_metadata_for_actor(storage.objects.name)'), 'utf8');

  const mutant = runProof(mutantPath, 'mutant');
  expectRejected(mutant, 'POSTFLIGHT_POLICY', 'Candidate policy mutation');

  const priorPolicyAnchor = `    AND (\n      storage.objects.owner_id = (SELECT auth.uid()::text)`;
  const driftedPolicySmoke = writeSmokeMutation(
    'smoke-prior-policy-drift.sql',
    priorPolicyAnchor,
    `    AND true\n${priorPolicyAnchor}`,
  );
  expectRejected(
    runProof(MIGRATION, 'policy-drift', driftedPolicySmoke),
    'PREFLIGHT_POLICY',
    'Prior policy drift mutation',
  );

  const includeAnchor = 'RESET ROLE;\n\n\\i /tmp/20260908054649_revoke_deleted_customer_document_bytes.sql';
  const noUsingPolicySmoke = writeSmokeMutation(
    'smoke-prior-policy-no-using.sql',
    includeAnchor,
    `RESET ROLE;\n\nDROP POLICY customer_documents_objects_rep_select ON storage.objects;\nCREATE POLICY customer_documents_objects_rep_select ON storage.objects\n  FOR SELECT TO authenticated;\n\n\\i /tmp/20260908054649_revoke_deleted_customer_document_bytes.sql`,
  );
  expectRejected(
    runProof(MIGRATION, 'policy-no-using', noUsingPolicySmoke),
    'PREFLIGHT_POLICY',
    'NULL predecessor policy expression mutation',
  );

  const sameSignatureDriftSmoke = writeSmokeMutation(
    'smoke-helper-body-drift.sql',
    includeAnchor,
    `RESET ROLE;\n\nCREATE FUNCTION public.customer_document_path_has_metadata_for_actor(p_storage_path text)\nRETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp\nAS $$ SELECT false $$;\n\n\\i /tmp/20260908054649_revoke_deleted_customer_document_bytes.sql`,
  );
  expectRejected(
    runProof(MIGRATION, 'helper-drift', sameSignatureDriftSmoke),
    'PREFLIGHT_HELPER',
    'Same-signature helper drift mutation',
  );

  const overloadSmoke = writeSmokeMutation(
    'smoke-helper-overload.sql',
    includeAnchor,
    `RESET ROLE;\n\nCREATE FUNCTION public.customer_document_path_has_metadata_for_actor(p_storage_path uuid)\nRETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;\n\n\\i /tmp/20260908054649_revoke_deleted_customer_document_bytes.sql`,
  );
  expectRejected(
    runProof(MIGRATION, 'helper-overload', overloadSmoke),
    'PREFLIGHT_HELPER',
    'Helper overload mutation',
  );

  process.stdout.write('MUTATION_GUARD_PASS exact policy pre/postflight, NULL-expression, and helper drift/overload guards fired\n');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

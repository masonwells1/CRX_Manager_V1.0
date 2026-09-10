import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireMigrationProofLock, invalidateMigrationProofs, migrationProofLockPath, migrationProofPaths } from './migration-proof-file-state.mjs';

test('a new review attempt revokes both prior migration proof halves', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'crx-migration-proof-state-'));
  try {
    const proofPaths = migrationProofPaths(stateDir, '20260904185900_refuse_null_job_field_acres');
    writeFileSync(proofPaths.reviewerFile, '{"findings":"clean"}', 'utf8');
    writeFileSync(proofPaths.codexFile, '{"verdict":"clean"}', 'utf8');

    assert.deepEqual(invalidateMigrationProofs(stateDir, '20260904185900_refuse_null_job_field_acres'), proofPaths);
    assert.equal(existsSync(proofPaths.reviewerFile), false);
    assert.equal(existsSync(proofPaths.codexFile), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an exclusive migration lock prevents concurrent review attempts and is released by its owner', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'crx-migration-proof-lock-'));
  const name = '20260904185900_refuse_null_job_field_acres';
  try {
    const lock = acquireMigrationProofLock(stateDir, name);
    assert.equal(existsSync(migrationProofLockPath(stateDir, name)), true);
    assert.throws(() => acquireMigrationProofLock(stateDir, name), /already running/);
    lock.release();
    assert.equal(existsSync(migrationProofLockPath(stateDir, name)), false);
    acquireMigrationProofLock(stateDir, name).release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function migrationProofPaths(stateDir, safeMigrationName) {
  return {
    reviewerFile: path.join(stateDir, `migration-review-${safeMigrationName}.json`),
    codexFile: path.join(stateDir, `codex-review-mig-${safeMigrationName}.json`),
  };
}

// Starting a review attempt revokes any authorization it is intended to replace.
// A failed or blocked re-review must never leave an earlier clean pair available
// to the migration-apply guard.
export function invalidateMigrationProofs(stateDir, safeMigrationName) {
  const proofPaths = migrationProofPaths(stateDir, safeMigrationName);
  rmSync(proofPaths.reviewerFile, { force: true });
  rmSync(proofPaths.codexFile, { force: true });
  return proofPaths;
}

export function migrationProofLockPath(stateDir, safeMigrationName) {
  return path.join(stateDir, `migration-review-${safeMigrationName}.lock`);
}

// A proof attempt owns one migration from initial revocation through final
// writing. Exclusive creation prevents a second attempt from overlapping it.
export function acquireMigrationProofLock(stateDir, safeMigrationName) {
  mkdirSync(stateDir, { recursive: true });
  const lockPath = migrationProofLockPath(stateDir, safeMigrationName);
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`a migration proof review is already running for ${safeMigrationName}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return { lockPath, release() { rmSync(lockPath, { force: true }); } };
}

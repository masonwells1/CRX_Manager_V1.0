import { rmSync } from 'node:fs';
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

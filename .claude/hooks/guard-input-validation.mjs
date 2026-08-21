// Shared strict validation for migration-guard evidence identifiers.
// Keep these checks in one place so the producer and consumer cannot drift.

export const MIGRATION_STEM_RE = /^\d{8}(?:\d{6})?_[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/;
export const PROJECT_REF_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validMigrationStem(value) {
  return typeof value === "string" && MIGRATION_STEM_RE.test(value);
}

export function validProjectRef(value) {
  return typeof value === "string" && PROJECT_REF_RE.test(value);
}

export function validRegistryReason(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 2000 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function migrationTimestampPrefix(stem) {
  if (!validMigrationStem(stem)) return null;
  return /^(\d{14}|\d{8})_/.exec(stem)?.[1] || null;
}

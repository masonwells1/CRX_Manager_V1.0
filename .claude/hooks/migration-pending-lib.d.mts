/** Typed access to the canonical ledger/disk migration identity normalizer. */
export function migrationSlug(raw: string): string;
export function checkPendingMigrations(args: {
  name: string;
  sql: string;
  appliedNames: string[];
  trackedFiles: string[];
  baselineHighWater: string;
}): { ok: boolean; abstained?: boolean; abstainReason?: string; pending?: string[]; ambiguous?: string[] };

/**
 * Client half of the whole-record optimistic concurrency contract.
 * The server is authoritative: this only carries the value it returned or read.
 */
export function buildRowVersionPatch(isUpdate: boolean, rowVersion: number | null): Record<string, number | null> {
  return isUpdate ? { row_version_expected: rowVersion } : {};
}

export function readRowVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

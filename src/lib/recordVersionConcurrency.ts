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

export type DirectMutationRowVersionResult =
  | { kind: 'adopt'; rowVersion: number }
  | { kind: 'legacy'; rowVersion: null }
  | { kind: 'recovery'; rowVersion: null };

/**
 * A narrow direct write (for example a lifecycle or crop update) gets the
 * trigger-returned row token from the same statement. It is safe to install
 * only the exact next token. A later writer could otherwise commit between our
 * mutation and a refresh, and a stale whole-record save would overwrite it.
 *
 * Pre-rollout clients see neither token and remain compatible. Once either
 * side has a numeric token, uncertainty fails closed for the next full save.
 */
export function resolveDirectMutationRowVersion(
  previousRowVersion: number | null,
  returnedRowVersion: unknown,
): DirectMutationRowVersionResult {
  const nextRowVersion = readRowVersion(returnedRowVersion);
  if (previousRowVersion === null && nextRowVersion === null) {
    return { kind: 'legacy', rowVersion: null };
  }
  if (previousRowVersion !== null && nextRowVersion === previousRowVersion + 1) {
    return { kind: 'adopt', rowVersion: nextRowVersion };
  }
  return { kind: 'recovery', rowVersion: null };
}

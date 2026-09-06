/**
 * Client half of the whole-record optimistic concurrency contract.
 * The server is authoritative: this only carries the value it returned or read.
 */
export function buildRowVersionPatch(isUpdate: boolean, rowVersion: number | null): Record<string, number | null> {
  return isUpdate ? { row_version_expected: rowVersion } : {};
}

/**
 * Recorded origin of an open RecordVersionConflictDialog.
 *
 * A page opens that dialog from many operations, but only ONE of them — a
 * `save_customer` / `save_quote` payload conflict — leaves a rejected whole-record
 * save key outstanding. Only that origin may authorize the recovery reload to
 * release the save key. Every other opener (a direct lifecycle mutation, a crop
 * toggle, an email send, a version restore, a conversion, or a plain "reload
 * first" gate) records NON_SAVE_RECOVERY instead, so its reload leaves an
 * outstanding save receipt alone.
 *
 * A symbol, not a reserved string: a scope is a record id (or `'new'` / `''`),
 * and a symbol cannot collide with any of them by construction.
 */
export const NON_SAVE_RECOVERY: unique symbol = Symbol('non-save-recovery');

/** The originating save scope, the non-save marker, or nothing open. */
export type StaleSaveConflictOrigin = string | typeof NON_SAVE_RECOVERY | null;

/**
 * True when a whole-record save reply is a real receipt — it names the row it wrote.
 *
 * `assertRpcResult` only rejects a MISSING reply (`null` / `undefined`); an empty
 * object passes through it untouched. But an empty reply is ambiguous: the row may
 * already be committed, and the outstanding idempotency key is the only thing that
 * can still redeem the server's cached answer. So the emptiness test has to happen
 * BEFORE the key is retired — retiring first and discovering the emptiness after
 * sends the retry under a fresh key the server cannot replay, writing the record
 * twice.
 */
export function hasReceiptId(reply: unknown, idField: string): boolean {
  if (typeof reply !== 'object' || reply === null) return false;
  const value = (reply as Record<string, unknown>)[idField];
  return typeof value === 'string' && value.length > 0;
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

/**
 * A whole-record save returns the authoritative token from the same RPC.
 * New records can legitimately move from no token to their first token, while
 * an existing numeric token must advance by exactly one. During the
 * frontend-first rollout, legacy RPCs return no token at all; null -> null is
 * compatible until the migration lands.
 */
export function resolveAuthoritativeSaveRowVersion(
  previousRowVersion: number | null,
  returnedRowVersion: unknown,
): DirectMutationRowVersionResult {
  const nextRowVersion = readRowVersion(returnedRowVersion);
  if (previousRowVersion === null && nextRowVersion === null) {
    return { kind: 'legacy', rowVersion: null };
  }
  if (nextRowVersion !== null
    && (previousRowVersion === null || nextRowVersion === previousRowVersion + 1)) {
    return { kind: 'adopt', rowVersion: nextRowVersion };
  }
  return { kind: 'recovery', rowVersion: null };
}

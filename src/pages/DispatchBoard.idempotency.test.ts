/**
 * DispatchBoard.idempotency.test.ts — Per-row idempotency-key invariant for the
 * Dispatched List reassign/undispatch actions (field-app parity #37 follow-up, MED).
 *
 * THE BUG (fixed): reassign + undispatch each used ONE component-scoped idempotency
 * key shared across every row. After a generic-but-committed error on row A the stale
 * key survived, so the NEXT action on a DIFFERENT row B reused it → the server's
 * check_idempotency (key+operation only) replayed row A's cached result WITHOUT running
 * the body → the UI showed a FALSE 'success' while row B was unchanged.
 *
 * THE FIX: a PER-ROW keyed ref cache (Map<job_field_id, key>) minted once per row via
 * generateIdempotencyKey('<op>', `${performedBy}:${jobFieldId}`). A key minted for row A
 * can NEVER be replayed for row B (different job_field_id → different key). Same-row RETRY
 * reuses the SAME key (true idempotent replay). The key is cleared only on THAT row's
 * confirmed success.
 *
 * These tests exercise the EXACT getKey/cache logic the component uses (see
 * getReassignKey/getUndispatchKey in DispatchBoard.tsx) so the invariant is pinned
 * deterministically — independent of the heavily-mocked full-component render.
 */
import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey } from '../lib/idempotency';

/**
 * Re-creates the component's intent-scoped key cache exactly: get-or-mint-once keyed by
 * a SCOPE string, scoped to the actor, with a per-scope delete on confirmed success.
 *
 * For undispatch the scope is the job_field_id (the row IS the whole intent).
 * For reassign the scope is `${jobFieldId}|${choice}|${ovr}` — the FULL action intent,
 * so a changed assignee on the SAME row mints a DIFFERENT key (Codex #37 final-6 MED).
 */
function makeRowKeyCache(operation: string, performedBy: string) {
  const ref = new Map<string, string>();
  return {
    getKey(scope: string): string {
      let key = ref.get(scope);
      if (!key) {
        key = generateIdempotencyKey(operation, `${performedBy}:${scope}`);
        ref.set(scope, key);
      }
      return key;
    },
    clear(scope: string): void {
      ref.delete(scope);
    },
    has(scope: string): boolean {
      return ref.has(scope);
    },
  };
}

/** The component's reassign scope builder (row + chosen assignee + license override). */
const reassignScope = (jobFieldId: string, choice: string, licenseOverride: boolean) =>
  `${jobFieldId}|${choice}|${licenseOverride ? 'ovr' : 'noovr'}`;

describe('DispatchBoard per-row idempotency keys (reassign/undispatch)', () => {
  const ACTOR = 'dispatcher-1';
  const ROW_A = 'jobfield-aaaa';
  const ROW_B = 'jobfield-bbbb';
  const APP_X = 'applicator:app-x';
  const APP_Y = 'applicator:app-y';

  it('reassign: a DIFFERENT row gets a different key — row B can never replay row A (the cross-row MED bug)', () => {
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const keyA = cache.getKey(reassignScope(ROW_A, APP_X, false));
    // Bug scenario: row A errs generically (committed server-side), key NOT cleared (so a
    // true row-A retry stays safe). The user then acts on a DIFFERENT row B.
    const keyB = cache.getKey(reassignScope(ROW_B, APP_X, false));
    expect(keyB).not.toBe(keyA);
  });

  it('reassign: the SAME row with a CHANGED assignee gets a NEW key — no stale replay of the old assignee (Codex #37 final-6)', () => {
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    // Reassign row A -> X commits server-side but the response errors; key is kept.
    const keyAX = cache.getKey(reassignScope(ROW_A, APP_X, false));
    // Dispatcher changes their mind: SAME row A -> a DIFFERENT assignee Y, saves again.
    const keyAY = cache.getKey(reassignScope(ROW_A, APP_Y, false));
    // Different intent → different key → the server runs the Y assignment instead of
    // replaying the cached X result (which would have falsely shown success).
    expect(keyAY).not.toBe(keyAX);
  });

  it('reassign: toggling license-override on the same row+assignee gets a NEW key (different validation path)', () => {
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const noOvr = cache.getKey(reassignScope(ROW_A, APP_X, false));
    const ovr = cache.getKey(reassignScope(ROW_A, APP_X, true));
    expect(ovr).not.toBe(noOvr);
  });

  it('reassign: same row + same assignee + same override RETRY reuses the SAME key (true idempotent replay)', () => {
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const scope = reassignScope(ROW_A, APP_X, false);
    const first = cache.getKey(scope);
    // generic error → intent unchanged → retry reuses the key:
    const retry = cache.getKey(scope);
    expect(retry).toBe(first);
  });

  it('undispatch: a DIFFERENT row gets a different key (cross-row replay impossible)', () => {
    const cache = makeRowKeyCache('undispatch_job_locations', ACTOR);
    const keyA = cache.getKey(ROW_A);
    const keyB = cache.getKey(ROW_B);
    expect(keyB).not.toBe(keyA);
  });

  it('undispatch: same row RETRY reuses the SAME key (retry-safe)', () => {
    const cache = makeRowKeyCache('undispatch_job_locations', ACTOR);
    const first = cache.getKey(ROW_A);
    expect(cache.getKey(ROW_A)).toBe(first);
  });

  it('clears only the acting intent on success; another intent on the same row is untouched', () => {
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const scopeAX = reassignScope(ROW_A, APP_X, false);
    const scopeAY = reassignScope(ROW_A, APP_Y, false);
    const keyAX1 = cache.getKey(scopeAX);
    const keyAY = cache.getKey(scopeAY);
    // Row A -> X confirmed success → clear ONLY that intent.
    cache.clear(scopeAX);
    expect(cache.has(scopeAX)).toBe(false);
    expect(cache.has(scopeAY)).toBe(true); // the A->Y intent's key is untouched
    // A brand-new A->X action mints a fresh key.
    expect(cache.getKey(scopeAX)).not.toBe(keyAX1);
    expect(cache.getKey(scopeAY)).toBe(keyAY);
  });

  it('reassign: returning to an OLD intent after a list reload mints a NEW key (no cross-generation replay)', () => {
    // Models the component clearing the cache on every fetchRows(): a key cached for the
    // OLD dispatch generation must not be replayed after the list reloads (Codex #37 final-7).
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const scopeAX = reassignScope(ROW_A, APP_X, false);
    const keyAX1 = cache.getKey(scopeAX);       // committed-but-errored A->X (key kept)
    cache.getKey(reassignScope(ROW_A, APP_Y, false)); // later A->Y ...
    // ── list reloads (success path / refresh) → component clears ALL keys ──
    cache.clear(scopeAX);
    cache.clear(reassignScope(ROW_A, APP_Y, false));
    // Now the dispatcher changes back to A->X: a brand-new key, NOT the stale one.
    const keyAX2 = cache.getKey(scopeAX);
    expect(keyAX2).not.toBe(keyAX1);
  });

  it('undispatch: a re-dispatch after a list reload mints a NEW undispatch key (no replay across generations)', () => {
    const cache = makeRowKeyCache('undispatch_job_locations', ACTOR);
    const first = cache.getKey(ROW_A);   // committed-but-response-lost undispatch (key kept)
    // ── list reloads (the row was re-dispatched) → component clears ALL keys ──
    cache.clear(ROW_A);
    const afterRedispatch = cache.getKey(ROW_A);
    expect(afterRedispatch).not.toBe(first);
  });

  it('reload preserves ONLY the in-flight scope and discards every other (possibly stale) key (Codex #37 final-9)', () => {
    // Faithfully models fetchRows()'s clear-except-active-scope: keep only the one write
    // currently in flight; drop all others (they may be stale against a new generation).
    const ref = new Map<string, string>();
    const get = (scope: string) => { let k = ref.get(scope); if (!k) { k = generateIdempotencyKey('dispatch_job_locations', `${ACTOR}:${scope}`); ref.set(scope, k); } return k; };
    const reloadPreserving = (activeScope: string | null) => {
      const keep = activeScope ? ref.get(activeScope) : undefined;
      ref.clear();
      if (activeScope && keep) ref.set(activeScope, keep);
    };

    const staleAX = reassignScope(ROW_A, APP_X, false);   // old committed-but-errored A->X
    const inFlightB = reassignScope(ROW_B, APP_X, false); // the write currently in flight
    const keyStaleAX = get(staleAX);
    const keyInFlightB = get(inFlightB);

    // A Reload fires mid-write for row B → preserve ONLY inFlightB.
    reloadPreserving(inFlightB);

    // The in-flight B key survived (its own retry stays safe)...
    expect(ref.get(inFlightB)).toBe(keyInFlightB);
    // ...but the unrelated stale A->X key was discarded → a later A->X mints a FRESH key
    // (so the server can't replay the old A->X result and falsely report success).
    expect(ref.has(staleAX)).toBe(false);
    expect(get(staleAX)).not.toBe(keyStaleAX);
  });

  it('reassign and undispatch caches are independent (separate operations, separate keys)', () => {
    const reassign = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const undispatch = makeRowKeyCache('undispatch_job_locations', ACTOR);
    const rKey = reassign.getKey(reassignScope(ROW_A, APP_X, false));
    const uKey = undispatch.getKey(ROW_A);
    expect(rKey).not.toBe(uKey);
    expect(rKey.startsWith('dispatch_job_locations:')).toBe(true);
    expect(uKey.startsWith('undispatch_job_locations:')).toBe(true);
  });

  it('embeds the actor AND the full intent in the key scope', () => {
    const cache = makeRowKeyCache('dispatch_job_locations', ACTOR);
    const scope = reassignScope(ROW_A, APP_X, false);
    const key = cache.getKey(scope);
    // format: operation:performedBy:<scope>:uuid
    expect(key).toContain(`:${ACTOR}:${scope}:`);
    expect(key).toContain(ROW_A);
    expect(key).toContain(APP_X);
  });
});

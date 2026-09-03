import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { assertRpcResult } from '../lib/db';

/**
 * F1 — the idempotency key must outlive the result check.
 *
 * A mutating RPC's reply is only known-good once assertRpcResult has accepted it.
 * Retiring the key before that check means an AMBIGUOUS reply — a null or malformed
 * success payload after the server may already have committed — leaves the user's
 * retry travelling under a FRESH key, which the server cannot replay, so the work
 * is applied twice (a duplicate invoice, a double-allocated payment, a double credit).
 *
 * Part 1 proves the semantics on the real hook + the real assertRpcResult.
 * Part 2 is a repo-wide guard so the ordering cannot silently regress.
 */

// ---------------------------------------------------------------------------
// Part 1 — behavioral proof, modeling the corrected call-site sequence.
// ---------------------------------------------------------------------------

type RpcReply = { data: unknown; error: unknown };

/**
 * Mirrors the fixed call-site shape used across the money screens:
 *   key -> rpc -> throw on error -> assertRpcResult -> resetKey (only now)
 */
function runCorrectedHandler(
  idem: { getKey: () => string; resetKey: () => void },
  reply: RpcReply | (() => never),
): { keyUsed: string; outcome: 'ok' | 'failed' } {
  const keyUsed = idem.getKey();
  let data: unknown;
  try {
    if (typeof reply === 'function') reply(); // transport failure
    const { data: d, error } = reply as RpcReply;
    if (error) throw error; // failure envelope
    data = d;
    assertRpcResult(data, 'create_invoice_from_order'); // ambiguous reply throws here
  } catch {
    return { keyUsed, outcome: 'failed' }; // key deliberately NOT retired
  }
  idem.resetKey(); // confirmed success only
  return { keyUsed, outcome: 'ok' };
}

describe('F1 — the key survives until the reply is confirmed', () => {
  it('transport failure: the retry reuses the same key', () => {
    const { result } = renderHook(() => useIdempotencyKey('create_invoice_from_order', 'user-1'));
    let first = '';
    let retry = '';
    act(() => {
      first = runCorrectedHandler(result.current, () => { throw new Error('Network request failed'); }).keyUsed;
    });
    act(() => { retry = result.current.getKey(); });
    expect(retry).toBe(first);
  });

  it('failure envelope: the retry reuses the same key', () => {
    const { result } = renderHook(() => useIdempotencyKey('create_invoice_from_order', 'user-2'));
    let first = '';
    let retry = '';
    act(() => {
      const r = runCorrectedHandler(result.current, { data: null, error: { message: 'permission denied' } });
      first = r.keyUsed;
      expect(r.outcome).toBe('failed');
    });
    act(() => { retry = result.current.getKey(); });
    expect(retry).toBe(first);
  });

  it('LOST RESPONSE: a null success payload keeps the key so the server can replay', () => {
    // The regression this whole change exists to prevent. The server may already have
    // committed; assertRpcResult rejects the reply; the retry MUST carry the same key.
    const { result } = renderHook(() => useIdempotencyKey('create_invoice_from_order', 'user-3'));
    let first = '';
    let retry = '';
    act(() => {
      const r = runCorrectedHandler(result.current, { data: null, error: null });
      first = r.keyUsed;
      expect(r.outcome).toBe('failed'); // assertRpcResult threw
    });
    act(() => { retry = result.current.getKey(); });
    expect(retry).toBe(first);
  });

  it('success: the key is retired, so a genuinely new invoice is a new intent', () => {
    const { result } = renderHook(() => useIdempotencyKey('create_invoice_from_order', 'user-4'));
    let first = '';
    let next = '';
    act(() => {
      const r = runCorrectedHandler(result.current, { data: 'invoice-uuid-1', error: null });
      first = r.keyUsed;
      expect(r.outcome).toBe('ok');
    });
    act(() => { next = result.current.getKey(); });
    expect(next).not.toBe(first);
  });

  it('changed intent: a different scope mints a fresh key, and returning replays the original', () => {
    const { result } = renderHook(() => useIdempotencyKey('cancel_return', 'user-5'));
    let scopeA = '';
    let scopeB = '';
    let backToA = '';
    act(() => { scopeA = result.current.getKeyFor('return-1|damaged'); });
    act(() => { scopeB = result.current.getKeyFor('return-1|wrong item'); });
    act(() => { backToA = result.current.getKeyFor('return-1|damaged'); });
    expect(scopeB).not.toBe(scopeA);
    expect(backToA).toBe(scopeA); // unresolved intent replays under its original key
  });
});

// ---------------------------------------------------------------------------
// Part 2 — repo-wide ordering guard.
// ---------------------------------------------------------------------------

/**
 * Sites where retiring the key BEFORE assertRpcResult is correct and intended,
 * because the reset sits inside an `if (error)` recovery branch:
 *
 *  - getIdempotencyMismatchResult(...) returned a committed receipt: the server said
 *    "this key is already bound to a committed result, here it is". The outcome is
 *    KNOWN, so the key is properly retired and the app reopens the committed record
 *    instead of creating a duplicate.
 *  - isDefinitiveRpcRejection(error): the server definitively refused, nothing
 *    committed, so the key is safely retired.
 *
 * Verified by reading each site. "Fixing" these breaks duplicate recovery on quick
 * deliveries, invoice save and returns.
 */
const RECOVERY_BRANCH_ALLOWLIST = new Set([
  'src/components/deliveries/QuickDeliveryModal.tsx',
  'src/pages/InvoiceDetail.tsx',
  'src/pages/Returns.tsx',
]);

/**
 * JobDetail.tsx carries 4 sites of this same class. They are deliberately EXCLUDED
 * from the F1 change because a concurrent session owns that file; see the F1 entry in
 * docs/manual/KNOWN_ISSUES.md for the tracked follow-up. Listed here so the guard
 * reports honestly rather than pretending the file is clean.
 */
const KNOWN_UNFIXED = new Set(['src/pages/JobDetail.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const TOKEN = /resetKey\(\)|resetKeyFor\(|assertRpcResult|checkMutationResult|\.rpc\(|\.update\(|\.delete\(|functions\.invoke\(/;
const RESET = /resetKey\(\)|resetKeyFor\(/;
const ASSERT = /assertRpcResult|checkMutationResult/;

function findResetBeforeAssert(file: string): number[] {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const hits: number[] = [];
  let last: 'CALL' | 'ASSERT' | null = null;
  lines.forEach((line, i) => {
    if (!TOKEN.test(line)) return;
    if (RESET.test(line)) {
      if (last !== 'CALL') return;
      // An assert further down that belongs to THIS statement sequence.
      const ahead = lines.slice(i + 1, i + 21);
      const assertAt = ahead.findIndex((l) => ASSERT.test(l));
      if (assertAt >= 0) hits.push(i + 1);
      return;
    }
    last = ASSERT.test(line) ? 'ASSERT' : 'CALL';
  });
  return hits;
}

describe('F1 guard — no money screen retires its key before the reply is checked', () => {
  const files = walk('src').map((f) => f.replace(/\\/g, '/'));

  it('scans a meaningful number of source files', () => {
    // Guards that cannot fire are worse than no guard: prove the sweep found work.
    expect(files.length).toBeGreaterThan(100);
    const withResets = files.filter((f) => /resetKey/.test(readFileSync(f, 'utf8')));
    expect(withResets.length).toBeGreaterThan(30);
  });

  it('reports reset-before-assert ONLY at documented sites', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = findResetBeforeAssert(file);
      if (hits.length === 0) continue;
      if (RECOVERY_BRANCH_ALLOWLIST.has(file) || KNOWN_UNFIXED.has(file)) continue;
      offenders.push(`${file}:${hits.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlisted recovery sites really are inside an error branch', () => {
    // Mutation-proofing: the allowlist must not become a place to hide real bugs.
    for (const file of RECOVERY_BRANCH_ALLOWLIST) {
      const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
      for (const lineNo of findResetBeforeAssert(file)) {
        const above = lines.slice(Math.max(0, lineNo - 8), lineNo).join('\n');
        expect(
          /getIdempotencyMismatchResult|isDefinitiveRpcRejection|committed[A-Za-z]*(Id|Result)/.test(above),
          `${file}:${lineNo} is allowlisted but shows no recovery-branch marker above it`,
        ).toBe(true);
      }
    }
  });

  it('the create-invoice click path no longer mints a key per click', () => {
    const src = readFileSync('src/pages/OrderDetail.tsx', 'utf8').replace(/\r\n/g, '\n');
    const click = src.slice(src.indexOf('const onCreateInvoiceClick'));
    const body = click.slice(0, click.indexOf('\n  };'));
    expect(body).not.toMatch(/createInvoiceIdem\.resetKey\(\)/);
  });

  /**
   * Found by driving the real screen, not by the sweep: reordering the post-RPC reset
   * is not enough when a BUTTON retires the key before the RPC runs. Both RPCs below
   * take a payload that cannot vary between attempts — cancel_order takes only
   * (p_order_id, p_performed_by, p_idempotency_key) and create_invoice_from_order only
   * (p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key) — so reopening
   * either dialog is the SAME intent and must reuse the key.
   *
   * Deliberately NOT asserted here: voidOrderIdem (void_order takes a free-text
   * p_reason) and updateOrderIdem (update_order_items takes p_items). Those resets
   * encode real intent rotation; the correct fix is a scoped key, tracked separately.
   */
  it('no fixed-payload money action retires its key from a click handler', () => {
    const src = readFileSync('src/pages/OrderDetail.tsx', 'utf8').replace(/\r\n/g, '\n');
    for (const idem of ['cancelOrderIdem', 'createInvoiceIdem']) {
      for (const line of src.split('\n')) {
        if (!line.includes(`${idem}.resetKey()`)) continue;
        expect(
          /onClick=|onClick\s*:/.test(line),
          `${idem}.resetKey() must not run from a click handler: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});

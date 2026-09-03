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
 * Retiring the key before that check means an AMBIGUOUS reply — an empty (null)
 * success payload after the server may already have committed — leaves the user's
 * retry travelling under a FRESH key, which the server cannot replay, so the work
 * is applied twice (a duplicate invoice, a double-allocated payment, a double credit).
 *
 * Part 1 proves the semantics on the real hook + the real assertRpcResult.
 * Part 2 is a repo-wide guard so the ordering cannot silently regress.
 *
 * KNOWN LIMITS OF THIS FILE — stated rather than papered over, because a guard that
 * is trusted beyond its reach is worse than one whose blind spots are written down
 * (all three raised by the Codex gpt-5.6-sol review of this change, 2026-09-03):
 *
 *  1. `assertRpcResult` rejects only null/undefined — it does NOT validate shape, so
 *     "the reply is verified" means "not empty", not "well-formed". A path needing a
 *     real shape check must do it itself and retire the key after it (see
 *     MonthEndClose's Array.isArray check).
 *  2. Part 2 matches on LINE ORDER and cannot bind a call, its reset and its assert to
 *     the same control-flow branch. A reset in an `else` arm whose sibling arm asserts
 *     will pass. That exact shape was a live HIGH in InvoiceDetail's edit path, and it
 *     was caught by REVIEW, not by this guard — which is why the per-RPC shape pin in
 *     src/lib/idempotencyIntentBindingMigration.test.ts also exists.
 *  3. Part 1 models the corrected call-site sequence; it does not execute any
 *     production handler, so it cannot detect branch placement or click-level
 *     rotation. Those are covered by Part 2's source checks and by driving the real
 *     screen in a browser.
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
 * Every hit is classified by a reason that is VERIFIED FROM THE SOURCE, not merely
 * asserted in a list. Codex (LOW, 2026-09-03) noted the first version suppressed by
 * whole file, so any future bug added to an allowlisted file would have been hidden.
 * A file now only excuses the reasons it declares, and each hit must independently
 * exhibit that reason:
 *
 *  - `recovery`  — the reset sits in an `if (error)` recovery branch. Two intended
 *    flavors: `getIdempotencyMismatchResult` returned a COMMITTED receipt (the outcome
 *    is known, so the key is properly retired and the app reopens the committed record
 *    rather than duplicating it), or `isDefinitiveRpcRejection` (server definitively
 *    refused, nothing committed). "Fixing" these breaks duplicate recovery.
 *  - `throw-on-error` — the RPC RETURNS void and is called with `.throwOnError()`, so
 *    the promise rejects on any error and the reset is only reachable on success.
 *    There is no payload to assert.
 *  - `intent-rotation` — the reset runs from a JSX `onClick`/`onChange`, deliberately
 *    minting a new key because the payload genuinely varies with what the user typed.
 *  - `doc-comment` — the hook's own usage example, not executable code.
 */
type Reason = 'recovery' | 'throw-on-error' | 'intent-rotation' | 'doc-comment';

const ALLOWED_REASONS: Record<string, Reason[]> = {
  'src/hooks/useIdempotencyKey.ts': ['doc-comment'],
  'src/components/deliveries/QuickDeliveryModal.tsx': ['recovery'],
  'src/pages/Returns.tsx': ['recovery'],
  'src/pages/InvoiceDetail.tsx': ['recovery', 'throw-on-error'],
  'src/pages/CycleCounts.tsx': ['throw-on-error'],
  'src/pages/FieldApplicationInvoice.tsx': ['throw-on-error'],
  'src/pages/Fields.tsx': ['throw-on-error'],
  'src/pages/VendorBillDetail.tsx': ['throw-on-error'],
  'src/pages/SupplierPricing.tsx': ['intent-rotation'],
};

/**
 * Files that STILL CARRY the F1 defect and are deliberately not fixed here.
 *
 * This list is an admission, not an excuse: every entry is a live reset-before-assert
 * site. It exists so the guard reports the true state instead of pretending these
 * files are clean, and so a future session can find the work.
 *
 *  - JobDetail.tsx — 4 sites; a concurrent session owned the file during this change.
 *  - Everything else — reverted to main after the round-2 Codex review. Reordering the
 *    reset makes the client RETAIN the key, and on these pages the key is not bound to
 *    what the RPC actually targets (an in-page selection, a staged payload, component
 *    state, or a `/new` route with no id), so retaining it trades duplicate-on-retry
 *    for cross-record replay — demonstrably worse on PrepayWorkspacePanel, where
 *    batch B would receive batch A's receipt and clear B's allocations unapplied.
 *    Fixing them needs the key bound to the REQUEST PAYLOAD (the
 *    fingerprintIntentPayload approach), not to the URL. Tracked in
 *    docs/manual/KNOWN_ISSUES.md.
 *
 * Do NOT add a file here to make the suite pass. An entry means "known broken,
 * deliberately deferred, written down" — if that is not true, fix the site instead.
 */
const KNOWN_UNFIXED = new Set([
  'src/pages/JobDetail.tsx',
  'src/pages/QuoteBuilder.tsx',
  'src/pages/BlendTicketDetail.tsx',
  'src/components/prepay/PrepayWorkspacePanel.tsx',
  'src/components/invoices/FinanceChargePreviewModal.tsx',
  'src/components/deliveries/QuickDeliveryModal.tsx',
  'src/pages/Deliveries.tsx',
  'src/pages/DeliveryRemainders.tsx',
  'src/pages/Invoices.tsx',
  'src/pages/NewOrder.tsx',
  'src/pages/PaymentAllocation.tsx',
  'src/pages/Quotes.tsx',
  'src/pages/FieldSetup.tsx',
]);

/** Classify one hit from the surrounding source, or null if nothing excuses it. */
function classify(lines: string[], lineNo: number): Reason | null {
  const self = lines[lineNo - 1] ?? '';
  const above = lines.slice(Math.max(0, lineNo - 9), lineNo - 1).join('\n');
  const callWindow = lines.slice(Math.max(0, lineNo - 16), lineNo - 1).join('\n');
  const handlerWindow = lines.slice(Math.max(0, lineNo - 4), lineNo).join('\n');

  if (/^\s*(\*|\/\/)/.test(self)) return 'doc-comment';
  if (/getIdempotencyMismatchResult|isDefinitiveRpcRejection|committed[A-Za-z]*(Id|Result)/.test(above)) {
    return 'recovery';
  }
  if (/\.throwOnError\(\)/.test(callWindow)) return 'throw-on-error';
  if (/onClick=|onChange=/.test(handlerWindow)) return 'intent-rotation';
  return null;
}

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

/**
 * Reports every reset that follows a mutating call with NO assert in between.
 *
 * STRENGTHENED 2026-09-03 (Codex MEDIUM, F1). The first version only reported a reset
 * when it also found an assert within the following 20 lines — so a reset with **no
 * assert at all** passed silently, which is precisely the shape of the live HIGH this
 * review found in InvoiceDetail's edit arm. Requiring a trailing assert made the guard
 * blind to the worst case, so that condition is gone: a reset reached from a call
 * without an intervening assert is reported, full stop.
 */
function findResetBeforeAssert(file: string): number[] {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const hits: number[] = [];
  let last: 'CALL' | 'ASSERT' | null = null;
  lines.forEach((line, i) => {
    if (!TOKEN.test(line)) return;
    if (RESET.test(line)) {
      // A reset that is NOT preceded by a verified reply is a hit, whether or not an
      // assert happens to appear later.
      if (last === 'CALL') hits.push(i + 1);
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

  it('every reset that precedes its reply check has a VERIFIED reason', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (KNOWN_UNFIXED.has(file)) continue;
      const hits = findResetBeforeAssert(file);
      if (hits.length === 0) continue;
      const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
      const allowed = ALLOWED_REASONS[file] ?? [];
      for (const lineNo of hits) {
        const reason = classify(lines, lineNo);
        // Per-SITE verification: an allowlisted file only excuses the reasons it
        // declares, and only for hits that actually exhibit one of them.
        if (reason && allowed.includes(reason)) continue;
        offenders.push(
          `${file}:${lineNo} (${reason ?? 'no reason found'}${
            reason && !allowed.includes(reason) ? ` — not declared for this file` : ''
          }) :: ${(lines[lineNo - 1] ?? '').trim().slice(0, 90)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no allowlist entry is stale', () => {
    // An allowlist that no longer matches anything is dead weight that would silently
    // excuse a future bug in that file. Every declared file must still produce hits,
    // and every declared reason must still be exhibited by at least one of them.
    for (const [file, reasons] of Object.entries(ALLOWED_REASONS)) {
      const hits = findResetBeforeAssert(file);
      expect(hits.length, `${file} is allowlisted but has no reset-before-assert sites`).toBeGreaterThan(0);
      const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
      const seen = new Set(hits.map((n) => classify(lines, n)));
      for (const reason of reasons) {
        expect(seen.has(reason), `${file} declares '${reason}' but no site exhibits it`).toBe(true);
      }
    }
  });

  it('the create-invoice click path no longer mints a key per click', () => {
    // FAIL-CLOSED (Codex MEDIUM, F1): the first version sliced on unchecked indexOf
    // results, so renaming or deleting the handler produced an empty string that
    // trivially passed. Both offsets are now asserted to exist.
    const src = readFileSync('src/pages/OrderDetail.tsx', 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('const onCreateInvoiceClick');
    expect(start, 'onCreateInvoiceClick handler not found — did it get renamed?').toBeGreaterThan(-1);
    const rest = src.slice(start);
    const end = rest.indexOf('\n  };');
    expect(end, 'could not find the end of onCreateInvoiceClick').toBeGreaterThan(-1);
    expect(rest.slice(0, end)).not.toMatch(/createInvoiceIdem\.resetKey\(\)/);
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
  /**
   * Every reset of a fixed-payload key must sit directly after that RPC's verified
   * reply — which is a positive property, not the absence of an `onClick` on the same
   * line. STRENGTHENED 2026-09-03 (Codex MEDIUM, F1): matching `onClick` lexically on
   * the reset's own line let a multiline handler, or an onClick calling a helper that
   * resets, pass. Requiring a matching assert above each reset rejects all three, and
   * requiring at least one reset per key means deleting the call cannot pass either.
   */
  const FIXED_PAYLOAD_KEYS: Array<[string, string]> = [
    ['cancelOrderIdem', 'cancel_order'],
    ['createInvoiceIdem', 'create_invoice_from_order'],
    ['splitInvoiceIdem', 'create_split_invoices_from_order'],
  ];

  it('every fixed-payload key is retired only after its own RPC reply is verified', () => {
    const lines = readFileSync('src/pages/OrderDetail.tsx', 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (const [idem, rpc] of FIXED_PAYLOAD_KEYS) {
      const resets = lines
        .map((l, i) => [l, i] as const)
        .filter(([l]) => l.includes(`${idem}.resetKey()`));
      expect(resets.length, `${idem}.resetKey() not found — renamed or deleted?`).toBeGreaterThan(0);
      for (const [line, i] of resets) {
        const above = lines.slice(Math.max(0, i - 25), i).join('\n');
        expect(
          above.includes(`'${rpc}'`) && /assertRpcResult/.test(above),
          `${idem}.resetKey() at line ${i + 1} is not preceded by a verified ${rpc} reply: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Every key whose post-RPC reset this change moved, on a page that can navigate to a
   * DIFFERENT record of the same type while staying mounted, must be record-scoped.
   *
   * Retaining the key across an ambiguous reply is the point of F1 — but on a detail
   * page that does not remount when the route id changes (every `<x>/:id` route in
   * src/App.tsx is rendered without a `key` prop), an unscoped retained key can replay
   * record A's receipt against record B.
   *
   * SCOPE OF THIS PR, narrowed 2026-09-03 after the round-2 Codex review found the
   * generalisation unsafe. A key is only listed here when the route id it is scoped by
   * is the SAME value the RPC targets:
   *   - DeliveryDetail — cancel/void/complete/create_followup all send the route id.
   *   - InvoiceDetail — transfer_invoice_to_job sends the route id. saveIdem is absent
   *     because it is already record-scoped via its second argument.
   *   - FieldApplicationInvoice — delete_invoices sends [id] and
   *     transfer_invoice_to_job sends id, both the route id.
   *
   * Deliberately NOT here, because route-id scoping would NOT match what the RPC
   * targets and would give false assurance — these pages were reverted to main and are
   * tracked as follow-up: QuoteBuilder (RPCs target component state `quoteId`, and
   * `/quotes/new` has no id at all), BlendTicketDetail (RPCs target asynchronously
   * hydrated `ticket.id`), and every page whose intent lives in an in-page payload
   * rather than the route — PrepayWorkspacePanel, Deliveries batch cancel, Invoices
   * batch void/delete, PaymentAllocation, FinanceChargePreviewModal, Quotes,
   * DeliveryRemainders, NewOrder, QuickDeliveryModal, FieldSetup. Binding those needs
   * the request payload, not the URL — see docs/manual/KNOWN_ISSUES.md.
   */
  const RECORD_SCOPED_KEYS: Record<string, string[]> = {
    'src/pages/DeliveryDetail.tsx': ['cancelIdem', 'followupIdem', 'completeIdem', 'voidIdem'],
    'src/pages/InvoiceDetail.tsx': ['transferToSchedulingIdem'],
    'src/pages/FieldApplicationInvoice.tsx': ['deleteIdem', 'transferToSchedulingIdem'],
  };

  it('keys retained on a page that can switch records are bound to the route id', () => {
    for (const [file, keys] of Object.entries(RECORD_SCOPED_KEYS)) {
      const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      for (const key of keys) {
        const decl = src.match(new RegExp(`const ${key} = useIdempotencyKey\\([\\s\\S]{0,200}?\\);`));
        expect(decl, `${file}: ${key} declaration not found — renamed or removed?`).not.toBeNull();
        expect(
          /id\s*\?\?\s*''/.test(decl![0]),
          `${file}: ${key} retains its key across an ambiguous reply but is NOT scoped by the route id — record A's receipt could replay against record B. Declaration: ${decl![0].replace(/\s+/g, ' ')}`,
        ).toBe(true);
      }
    }
  });

  it('the order-scoped keys are bound to the route id, not just operation+user', () => {
    // Codex HIGH (F1): OrderDetail does NOT remount when the route id changes, so an
    // unscoped key could replay order A's receipt against order B once the per-click
    // reset was removed. The third argument is the hook's intentScope.
    const src = readFileSync('src/pages/OrderDetail.tsx', 'utf8').replace(/\r\n/g, '\n');
    for (const [idem] of FIXED_PAYLOAD_KEYS) {
      const decl = src.match(new RegExp(`const ${idem} = useIdempotencyKey\\([^)]*\\)`));
      expect(decl, `${idem} declaration not found`).not.toBeNull();
      expect(
        /id\s*\?\?\s*''/.test(decl![0]),
        `${idem} must be scoped by the route id: ${decl![0]}`,
      ).toBe(true);
    }
  });
});

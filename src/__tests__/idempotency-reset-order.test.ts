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
/**
 * IDENTITY-PINNED, not count-pinned and not file-exempted.
 *
 * Round 3 replaced whole-file exemptions with a per-file COUNT, because an exemption
 * cannot fail — a new defect in a listed file was absorbed silently while reading as
 * coverage. Round 4 showed the count is still too weak: cardinality alone lets a real
 * defect be SWAPPED IN as an existing one is removed, and the total never moves
 * (Codex round-4 MEDIUM). Each file is therefore pinned to the sorted list of the
 * RESET IDENTIFIERS the scanner finds in it. Adding, removing, or substituting a site
 * changes that list and fails the guard.
 *
 * RESIDUAL, stated rather than implied: the identifier is the key's own name, so two
 * distinct sites that call the SAME key's reset are not told apart, and a swap between
 * them would still pass. Narrowing that further needs an AST, not a line scan.
 */
const KNOWN_UNFIXED_SITES: Record<string, string[]> = {
  // JobDetail shows SIX, not the five round 3 pinned. The sixth was being dropped by
  // the old filter, which excused any classified hit even when the file declares no
  // allowed reason — exactly the hole round 4 found.
  'src/pages/JobDetail.tsx': [
    'assignIdem.resetKey',
    'completeJobIdem.resetKey',
    'completeJobIdem.resetKey',
    'saveJobIdem.resetKey',
    'saveRecipeIdem.resetKey',
    'transferJobIdem.resetKey',
  ],
  'src/pages/QuoteBuilder.tsx': [
    'closeAppliedIdem.resetKey',
    'closeShortIdem.resetKey',
    'drawDownIdem.resetKey',
    'fromTemplateIdem.resetKey',
    'resetSaveQuoteIdempotencyKey',
    'rolloverIdem.resetKey',
  ],
  'src/pages/BlendTicketDetail.tsx': [
    'approveIdem.resetKey',
    'createOrderIdem.resetKey',
    'linkIdem.resetKey',
    'linkIdem.resetKey',
    'rejectIdem.resetKey',
    'unlinkIdem.resetKey',
  ],
  'src/components/prepay/PrepayWorkspacePanel.tsx': ['batchApplyIdem.resetKey'],
  'src/components/invoices/FinanceChargePreviewModal.tsx': ['financeChargeIdem.resetKey'],
  // QuickDeliveryModal is ALSO allowlisted for 'recovery': its correct recovery reset
  // is excused per-site and only the defective one is pinned here.
  'src/components/deliveries/QuickDeliveryModal.tsx': ['quickDeliveryIdem.resetKey'],
  'src/pages/Deliveries.tsx': ['batchCancelIdem.resetKey'],
  'src/pages/DeliveryRemainders.tsx': ['followupIdem.resetKey'],
  'src/pages/Invoices.tsx': ['batchDeleteIdem.resetKey', 'batchVoidIdem.resetKey'],
  'src/pages/NewOrder.tsx': ['createOrderIdem.resetKey'],
  'src/pages/PaymentAllocation.tsx': ['allocatePaymentIdem.resetKey'],
  'src/pages/Quotes.tsx': ['duplicateQuoteIdem.resetKey'],
  'src/pages/FieldSetup.tsx': ['saveFieldIdem.resetKey'],
  // Reverted after round 3: FieldStop does NOT remount stop-to-stop (App.tsx:285 has
  // no key), so retaining an unscoped complete_delivery key could replay stop A's
  // receipt against stop B.
  'src/pages/FieldStop.tsx': ['completeIdem.resetKey'],
  // OrderDetail is mostly FIXED — this pins the ONE site deliberately left in main's
  // order: void_order sends order.id plus a free-text reason, so it needs payload
  // binding rather than route-id scoping.
  'src/pages/OrderDetail.tsx': ['voidOrderIdem.resetKey'],
  // DeliveryDetail is partly fixed: create_followup_delivery is route-bound and was
  // reordered; complete/cancel/void send mutable payload fields (signature, quantities,
  // issue notes, free-text reasons) that a route-id scope does not bind, so they stay
  // in main's order pending fingerprintIntentPayload (Codex round-4 HIGH/MEDIUM).
  'src/pages/DeliveryDetail.tsx': [
    'cancelIdem.resetKey',
    'completeIdem.resetKey',
    'voidIdem.resetKey',
  ],
  // ALIASED-RESET CLASS, invisible until this guard learned to resolve destructured
  // names. Both CustomerDetail sites are real: :782 releases the key on `!error`
  // alone, which does not rule out a null reply, and :796 is a plain
  // reset-before-assert on save_customer. Not a money path.
  'src/pages/CustomerDetail.tsx': [
    'resetSaveCustomerIdempotencyKey',
    'resetSaveCustomerIdempotencyKey',
  ],
  // SCANNER FALSE POSITIVES, pinned so the scan stays honest rather than being
  // silently filtered (Codex round-4 MEDIUM). Both are correct code:
  // BulkTicketUpload's reset lives in finishCommittedUpload(), reached only once the
  // ticket is committed — the scanner pairs it with the unrelated non-blocking
  // functions.invoke() above it. ManualTicketCreate's reset runs inside
  // `if (!lookup.data)`, i.e. after a lookup PROVED the row does not exist, which is
  // the same definitive-rejection shape already allowed for Returns.tsx. Listing a
  // file here means "the scanner flags it and this PR does not change it", NOT
  // "these are defects" — see the reasons above for which is which.
  'src/components/blendtickets/BulkTicketUpload.tsx': ['resetUploadKey'],
  'src/components/blendtickets/ManualTicketCreate.tsx': ['resetCreateKey'],
};
const KNOWN_UNFIXED = new Set(Object.keys(KNOWN_UNFIXED_SITES));

/** Classify one hit from the surrounding source, or null if nothing excuses it. */
function classify(lines: string[], lineNo: number): Reason | null {
  const self = lines[lineNo - 1] ?? '';
  const above = lines.slice(Math.max(0, lineNo - 9), lineNo - 1).join('\n');
  const callWindow = lines.slice(Math.max(0, lineNo - 16), lineNo - 1).join('\n');
  const handlerWindow = lines.slice(Math.max(0, lineNo - 4), lineNo).join('\n');

  if (/^\s*(\*|\/\/)/.test(self)) return 'doc-comment';

  // A recovery marker only excuses this reset if it is in the SAME branch. A
  // recovery branch always exits with `throw` or `return`, so any such exit between
  // the marker and the reset proves the reset is in a DIFFERENT branch and the marker
  // is merely nearby. Without this, the correct recovery reset in QuickDeliveryModal
  // laundered the buggy one ~11 lines below it (Codex round-3 MEDIUM).
  //
  // This is a TEXTUAL heuristic over fixed windows, not a parser (Codex round-4
  // MEDIUM). `exitsBranch` recognises only a line STARTING with `throw` or `return`:
  // it does not read braces, `else`, an inline exit later in a line, a `break`, a
  // `continue`, or a helper that throws on the caller's behalf. So it can still
  // launder across sibling branches, and it can refuse a genuinely safe reset that
  // happens to follow an early-exit error branch. It narrows the laundering hole; it
  // does not close it. A real fix is an AST walk.
  const lastIndexMatching = (arr: string[], re: RegExp): number => {
    for (let i = arr.length - 1; i >= 0; i -= 1) if (re.test(arr[i])) return i;
    return -1;
  };
  const exitsBranch = (arr: string[], from: number): boolean =>
    arr.slice(from + 1).some((l) => /^\s*(throw|return)\b/.test(l));

  const aboveLines = above.split('\n');
  const markerIdx = lastIndexMatching(
    aboveLines,
    /getIdempotencyMismatchResult|isDefinitiveRpcRejection|committed[A-Za-z]*(Id|Result)/,
  );
  if (markerIdx >= 0 && !exitsBranch(aboveLines, markerIdx)) return 'recovery';

  // Same rule for fire-and-forget: an exit between the call and the reset means they
  // are not the same statement sequence.
  const callLines = callWindow.split('\n');
  const throwIdx = lastIndexMatching(callLines, /\.throwOnError\(\)/);
  if (throwIdx >= 0 && !exitsBranch(callLines, throwIdx)) return 'throw-on-error';

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
/**
 * Resets reached through a DESTRUCTURED ALIAS, e.g.
 *   const { resetKey: resetSaveQuoteIdempotencyKey } = useIdempotencyKey(...)
 *   ...
 *   resetSaveQuoteIdempotencyKey();
 *
 * The literal `resetKey()` spelling is invisible to a plain scan, which is how a live
 * `save_customer` defect at CustomerDetail.tsx:796 escaped the original 249-site sweep
 * entirely (Codex round-3 HIGH). Aliases are resolved per file and matched as well.
 *
 * WHAT THIS DOES NOT CATCH (Codex round-4 MEDIUM — stated so the guard is not trusted
 * past its reach): only a DIRECT destructure in the same file, `{ resetKey: name }`.
 * A second rename of that name, a wrapper function that calls it, an alias imported
 * from another module, an optional call, computed member access, and a hook result
 * stored in a variable and passed elsewhere all remain invisible. Plain
 * `idem.resetKey()` member calls are caught by RESET regardless. Closing the rest
 * needs an AST and a resolver, not a line scan.
 */
function aliasNames(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/\bresetKeyFor\s*:\s*(\w+)|\bresetKey\s*:\s*(\w+)/g)]
      .map((m) => m[1] ?? m[2])
      .filter((n): n is string => Boolean(n)),
  )];
}

function aliasResetPattern(source: string): RegExp | null {
  const names = aliasNames(source);
  if (names.length === 0) return null;
  return new RegExp(`\\b(${names.join('|')})\\s*\\(`);
}

/**
 * Identity of one flagged site: the name of the key whose reset was matched.
 *
 * Pinning cardinality alone lets a new defect be swapped in as an old one is removed
 * (Codex round-4 MEDIUM). The identifier is stable under reformatting and line moves,
 * unlike a line number, and changes when a DIFFERENT key's reset appears.
 */
function siteIdentifier(line: string, names: string[]): string {
  const member = line.match(/([A-Za-z_$][\w$]*)\s*\.\s*(resetKeyFor|resetKey)\s*\(/);
  if (member) return `${member[1]}.${member[2]}`;
  for (const name of names) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(line)) return name;
  }
  return line.trim().slice(0, 60);
}

function findResetBeforeAssert(file: string): number[] {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const alias = aliasResetPattern(source);
  const isReset = (l: string) => RESET.test(l) || (alias !== null && alias.test(l));
  const hits: number[] = [];
  let last: 'CALL' | 'ASSERT' | null = null;
  lines.forEach((line, i) => {
    if (!TOKEN.test(line) && !(alias !== null && alias.test(line))) return;
    if (isReset(line)) {
      // A reset that is NOT preceded by a verified reply is a hit, whether or not an
      // assert happens to appear later.
      if (last === 'CALL') hits.push(i + 1);
      return;
    }
    last = ASSERT.test(line) ? 'ASSERT' : 'CALL';
  });
  return hits;
}

// TITLE SAYS WHAT IT PROVES (Codex round-4 MEDIUM). The earlier wording — "no money
// screen retires its key before the reply is checked" — claimed repo-wide coverage
// while the implementation skips every file in KNOWN_UNFIXED_SITES. Those files are
// not verified clean; they are pinned to the exact sites the scanner already finds.
describe('F1 guard — resets are verified outside the pinned files, and the pinned files cannot drift', () => {
  const files = walk('src').map((f) => f.replace(/\\/g, '/'));

  it('scans a meaningful number of source files', () => {
    // Guards that cannot fire are worse than no guard: prove the sweep found work.
    expect(files.length).toBeGreaterThan(100);
    const withResets = files.filter((f) => /resetKey/.test(readFileSync(f, 'utf8')));
    expect(withResets.length).toBeGreaterThan(30);
  });

  it('every reset OUTSIDE the pinned files that precedes its reply check has a VERIFIED reason', () => {
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

  it('every known-unfixed file flags EXACTLY its pinned sites', () => {
    // The point of the pin: a NEW reset-before-assert in one of these files must FAIL
    // rather than be absorbed by a whole-file exemption OR hidden by a swap that keeps
    // the count the same (Codex round-4 MEDIUM).
    const actual: Record<string, string[]> = {};
    for (const file of Object.keys(KNOWN_UNFIXED_SITES)) {
      const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const lines = source.split('\n');
      const names = aliasNames(source);
      const allowed = ALLOWED_REASONS[file] ?? [];
      // Exclude a site ONLY for a reason this file actually declares. Filtering on
      // "classify returned anything" let a new defect that merely sat near an
      // onClick=, a recovery marker or an unrelated .throwOnError() drop out of the
      // pin while the total held (Codex round-4 MEDIUM).
      actual[file] = findResetBeforeAssert(file)
        .filter((n) => {
          const reason = classify(lines, n);
          return !(reason && allowed.includes(reason));
        })
        .map((n) => siteIdentifier(lines[n - 1] ?? '', names))
        .sort();
    }
    expect(actual).toEqual(KNOWN_UNFIXED_SITES);
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

  // CLAIM LIMITED to what this actually proves (Codex round-3 MEDIUM): it checks that
  // the RPC name and an assertRpcResult BOTH appear in the 25 lines above each reset.
  // Those tokens could belong to separate calls or branches, so this is a LEXICAL
  // proximity check, not proof that the reset directly follows its own verified call.
  // It is still worth keeping — it catches a reset moved away from its call entirely,
  // and it fails closed when the key is renamed or deleted.
  it('every fixed-payload key has its RPC name and an assert in the lines above it', () => {
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
   * generalisation unsafe, and narrowed AGAIN after round 4. A key is only listed here
   * when the route id is the WHOLE of what a retry can vary — not merely the record
   * the RPC names. Round 4's HIGH: complete_delivery also sends the signature,
   * per-item quantities and issue notes, so a route-scoped retained key would replay
   * the FIRST payload while the screen reported the edited one. Route scope binds the
   * record; it does not bind the payload.
   *   - DeliveryDetail — create_followup_delivery ONLY. Its payload is exactly
   *     (p_original_delivery_id, p_performed_by, p_idempotency_key). cancel, void and
   *     complete send mutable free-text or quantity fields and stay in main's order.
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
    'src/pages/DeliveryDetail.tsx': ['followupIdem'],
    'src/pages/InvoiceDetail.tsx': ['transferToSchedulingIdem'],
    'src/pages/FieldApplicationInvoice.tsx': ['deleteIdem', 'transferToSchedulingIdem'],
  };

  // CLAIM LIMITED (Codex round-3 MEDIUM): this asserts the DECLARATION contains
  // `id ?? ''`. It does NOT verify that the RPC sends that same id, that the handler
  // uses this hook, or that no other mutable selector can become the target — those
  // are properties of the call site, checked by reading it, not by this test. The list
  // is also manually enumerated, so it cannot discover a page or key nobody added.
  // What it does buy: a scoped key silently losing its scope fails immediately.
  it('the enumerated record-scoped keys still declare a route-id scope', () => {
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

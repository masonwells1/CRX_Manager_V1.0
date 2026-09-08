import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUnresolvedIntent } from './useUnresolvedIntent';

/**
 * Behavioural coverage for the freeze itself, not for the strings that mention it.
 *
 * The rest of this PR pins `useUnresolvedIntent` through source-text guards on its call
 * sites, which prove the hook is WIRED but say nothing about what it does. A high-effort
 * review pointed out that the sequence the hook exists to stop — commit, lose the
 * response, edit, send again — was never exercised anywhere. These tests walk that
 * sequence.
 */
describe('useUnresolvedIntent', () => {
  it('never refuses a faithful retry of the same payload', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    act(() => result.current.mark('adjust:widget:10'));
    // Same scope = the identical request. Replaying it redeems the receipt instead of
    // repeating the work, so it is the SAFE move and must always be allowed through —
    // it is the only way forward that does not require a reload.
    expect(result.current.refuseEdited('adjust:widget:10')).toBe(false);
    expect(result.current.refuseEdited('adjust:widget:10')).toBe(false);
  });

  it('refuses an edited payload EVERY time, not once', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    act(() => result.current.mark('adjust:widget:10'));
    // The regression this test exists for, and it has bitten twice in opposite ways.
    //
    // Version 1 dropped the freeze on the first refusal, so acknowledging one edit
    // disarmed the guard and a third payload ran with no warning at all. Version 2
    // warned once per distinct edit, which still let the SECOND click on any edited
    // payload through — minting a fresh key and re-applying work that may already have
    // committed. `gpt-5.6-sol` and the Codex bot each flagged that independently.
    //
    // There is no click count that makes an edited payload safe while the outcome of
    // the original attempt is unknown. Only an authoritative reload settles it.
    expect(result.current.refuseEdited('adjust:widget:25')).toBe(true);
    expect(result.current.refuseEdited('adjust:widget:25')).toBe(true);
    expect(result.current.refuseEdited('adjust:widget:25')).toBe(true);
    // A different edit is refused too, and the freeze is still armed afterwards.
    expect(result.current.refuseEdited('adjust:widget:40')).toBe(true);
    expect(result.current.isFrozen).toBe(true);
    // The original payload remains the one safe way through.
    expect(result.current.refuseEdited('adjust:widget:10')).toBe(false);
  });

  it('lifts the freeze only when the outstanding attempt is settled', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    act(() => result.current.mark('adjust:widget:10'));
    expect(result.current.refuseEdited('adjust:widget:25')).toBe(true);

    act(() => result.current.clear('adjust:widget:10'));
    expect(result.current.isFrozen).toBe(false);
    // Nothing is unresolved, so nothing is refused.
    expect(result.current.refuseEdited('adjust:widget:99')).toBe(false);

    // A LATER unresolved attempt refuses again from scratch.
    act(() => result.current.mark('adjust:widget:10'));
    expect(result.current.refuseEdited('adjust:widget:25')).toBe(true);
  });

  it('freezes on an ambiguous failure but not on a definitive server refusal', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    // A network failure proves nothing about whether the transaction committed.
    act(() => result.current.markIfUncertain('hold:widget:5', new TypeError('Failed to fetch')));
    expect(result.current.isFrozen).toBe(true);

    act(() => result.current.clear('hold:widget:5'));

    // A PostgREST rejection with a real status DID answer: the work did not happen, so
    // the operator is free to edit and resend without a warning.
    act(() => result.current.markIfUncertain('hold:widget:5', {
      code: 'P0001',
      message: 'INSUFFICIENT_STOCK',
      details: null,
      hint: null,
    }));
    expect(result.current.isFrozen).toBe(false);
    expect(result.current.refuseEdited('hold:widget:9')).toBe(false);
  });

  it('refuses inside a single render window, before any state update lands', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    // Two clicks can land in one render window, so the guard reads a ref rather than
    // state. Marking and refusing inside ONE act() proves the refusal does not depend
    // on a re-render having happened first.
    act(() => {
      result.current.mark('adjust:widget:10');
      expect(result.current.refuseEdited('adjust:widget:25')).toBe(true);
    });
  });

  it('keeps one row frozen when a DIFFERENT row succeeds', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    // The failure CodeRabbit found on BlendRecipes. The in-flight guard on these
    // screens is keyed per row, so duplicating recipe B and recipe A overlap freely.
    // A finishes ambiguously and freezes; B then finishes successfully. Under the
    // previous single-slot design B's clear() wiped A's freeze, an edited retry of A
    // sailed through refuseEdited, minted a fresh key, and created a second copy of a
    // recipe that may already have been duplicated.
    act(() => result.current.markIfUncertain('duplicate:A:v1', new TypeError('Failed to fetch')));
    act(() => result.current.clear('duplicate:B:v1'));

    expect(result.current.isFrozen).toBe(true);
    // An edited retry of A is still refused, which is the whole point.
    expect(result.current.refuseEdited('duplicate:A:v2')).toBe(true);
    // A faithful retry of A is still allowed.
    expect(result.current.refuseEdited('duplicate:A:v1')).toBe(false);

    // Only settling A itself lifts A's freeze.
    act(() => result.current.clear('duplicate:A:v1'));
    expect(result.current.isFrozen).toBe(false);
    expect(result.current.refuseEdited('duplicate:A:v2')).toBe(false);
  });

  it('holds every concurrently unresolved scope, and settles them one at a time', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    // Two rows can both end up unresolved: they were both already in flight.
    act(() => {
      result.current.markIfUncertain('duplicate:A:v1', new TypeError('Failed to fetch'));
      result.current.markIfUncertain('duplicate:B:v1', new TypeError('Failed to fetch'));
    });

    // Each faithful retry is allowed; anything edited is refused.
    expect(result.current.refuseEdited('duplicate:A:v1')).toBe(false);
    expect(result.current.refuseEdited('duplicate:B:v1')).toBe(false);
    expect(result.current.refuseEdited('duplicate:A:v2')).toBe(true);

    act(() => result.current.clear('duplicate:A:v1'));
    // B is still outstanding, so the screen stays frozen for everything but B.
    expect(result.current.isFrozen).toBe(true);
    expect(result.current.refuseEdited('duplicate:A:v1')).toBe(true);
    expect(result.current.refuseEdited('duplicate:B:v1')).toBe(false);

    act(() => result.current.clear('duplicate:B:v1'));
    expect(result.current.isFrozen).toBe(false);
  });
});

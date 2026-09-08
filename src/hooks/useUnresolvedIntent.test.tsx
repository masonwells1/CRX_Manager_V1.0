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
    // repeating the work, so it is the SAFE move and must always be allowed through.
    expect(result.current.refuseOnce('adjust:widget:10')).toBe(false);
    expect(result.current.refuseOnce('adjust:widget:10')).toBe(false);
  });

  it('refuses an edited payload, then allows that same edit on the second click', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    act(() => result.current.mark('adjust:widget:10'));
    // First click on the edited values: refused, and the operator is told why.
    expect(result.current.refuseOnce('adjust:widget:25')).toBe(true);
    // Clicking again with those same edited values is a decision they have now made
    // deliberately, matching the over-allocation warning already on the page.
    expect(result.current.refuseOnce('adjust:widget:25')).toBe(false);
  });

  it('stays armed after an acknowledgement, so a DIFFERENT edit is refused too', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    act(() => result.current.mark('adjust:widget:10'));
    expect(result.current.refuseOnce('adjust:widget:25')).toBe(true);
    expect(result.current.refuseOnce('adjust:widget:25')).toBe(false);

    // The regression this test exists for. An earlier version cleared the unresolved
    // scope on the FIRST refusal, so acknowledging one edit disarmed the guard entirely
    // and a third, different payload executed with no warning at all while the original
    // attempt was still unresolved.
    expect(result.current.refuseOnce('adjust:widget:40')).toBe(true);
    // Still frozen: only clear() lifts it.
    expect(result.current.isFrozen).toBe(true);
  });

  it('lifts the freeze only on clear(), and forgets prior acknowledgements', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    act(() => result.current.mark('adjust:widget:10'));
    expect(result.current.refuseOnce('adjust:widget:25')).toBe(true);

    act(() => result.current.clear());
    expect(result.current.isFrozen).toBe(false);
    // Nothing is unresolved, so nothing is refused.
    expect(result.current.refuseOnce('adjust:widget:99')).toBe(false);

    // A LATER unresolved attempt must warn about the previously acknowledged payload
    // again: that acknowledgement was about a different outstanding request, and
    // carrying it forward would silently skip the warning on a fresh incident.
    act(() => result.current.mark('adjust:widget:10'));
    expect(result.current.refuseOnce('adjust:widget:25')).toBe(true);
  });

  it('freezes on an ambiguous failure but not on a definitive server refusal', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    // A network failure proves nothing about whether the transaction committed.
    act(() => result.current.markIfUncertain('hold:widget:5', new TypeError('Failed to fetch')));
    expect(result.current.isFrozen).toBe(true);

    act(() => result.current.clear());

    // A PostgREST rejection with a real status DID answer: the work did not happen, so
    // the operator is free to edit and resend without a warning.
    act(() => result.current.markIfUncertain('hold:widget:5', {
      code: 'P0001',
      message: 'INSUFFICIENT_STOCK',
      details: null,
      hint: null,
    }));
    expect(result.current.isFrozen).toBe(false);
    expect(result.current.refuseOnce('hold:widget:9')).toBe(false);
  });

  it('refuses inside a single render window, before any state update lands', () => {
    const { result } = renderHook(() => useUnresolvedIntent());

    // Two clicks can land in one render window, so the guard reads a ref rather than
    // state. Marking and refusing inside ONE act() proves the refusal does not depend
    // on a re-render having happened first.
    act(() => {
      result.current.mark('adjust:widget:10');
      expect(result.current.refuseOnce('adjust:widget:25')).toBe(true);
    });
  });
});

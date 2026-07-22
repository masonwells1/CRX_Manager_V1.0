import { describe, it, expect } from 'vitest';
import { buildCommissionSplitPatch, nextLoadedSplitSnapshot } from './commissionSplitConcurrency';

const split = { splits: [{ recipient: 'Alice', percentage: 100 }] };
const older = { splits: [{ recipient: 'Bob', percentage: 100 }] };
const enriched = { splits: [{ recipient: 'Alice', percentage: 100, recipient_user_id: 'u-1' }] };
const newerFromOtherTab = { splits: [{ recipient: 'Carol', percentage: 100 }] };

describe('buildCommissionSplitPatch', () => {
  it('insert always sends the split, never the expected key', () => {
    expect(
      buildCommissionSplitPatch({ isUpdate: false, touched: false, key: 'commission_split', value: split, loaded: null })
    ).toEqual({ commission_split: split });
    expect(
      buildCommissionSplitPatch({ isUpdate: false, touched: true, key: 'commission_split', value: split, loaded: older })
    ).toEqual({ commission_split: split });
  });

  it('update with untouched split omits BOTH keys so the RPC keeps the stored value', () => {
    const patch = buildCommissionSplitPatch({
      isUpdate: true, touched: false, key: 'commission_split', value: split, loaded: older,
    });
    expect(patch).toEqual({});
    expect('commission_split' in patch).toBe(false);
    expect('commission_split_expected' in patch).toBe(false);
  });

  it('update with edited split sends value + expected snapshot', () => {
    expect(
      buildCommissionSplitPatch({ isUpdate: true, touched: true, key: 'commission_split', value: split, loaded: older })
    ).toEqual({ commission_split: split, commission_split_expected: older });
  });

  it('edited split on a record that had none sends expected: null', () => {
    expect(
      buildCommissionSplitPatch({ isUpdate: true, touched: true, key: 'default_commission_split', value: split, loaded: null })
    ).toEqual({ default_commission_split: split, default_commission_split_expected: null });
    expect(
      buildCommissionSplitPatch({ isUpdate: true, touched: true, key: 'default_commission_split', value: split, loaded: undefined })
    ).toEqual({ default_commission_split: split, default_commission_split_expected: null });
  });

  it('uses the customer key names for default_commission_split', () => {
    const patch = buildCommissionSplitPatch({
      isUpdate: true, touched: true, key: 'default_commission_split', value: split, loaded: older,
    });
    expect(patch).toEqual({
      default_commission_split: split,
      default_commission_split_expected: older,
    });
  });
});

describe('nextLoadedSplitSnapshot', () => {
  it('touched save adopts the echoed (trigger-enriched) stored split', () => {
    expect(
      nextLoadedSplitSnapshot({ touched: true, prevLoaded: older, echoed: enriched, currentValue: split })
    ).toBe(enriched);
  });

  it('touched save falls back to the sent value when the server did not echo (pre-apply RPC)', () => {
    expect(
      nextLoadedSplitSnapshot({ touched: true, prevLoaded: older, echoed: undefined, currentValue: split })
    ).toBe(split);
  });

  it('touched save honors an explicitly echoed null (split cleared server-side)', () => {
    expect(
      nextLoadedSplitSnapshot<typeof split | null>({ touched: true, prevLoaded: older, echoed: null, currentValue: split })
    ).toBeNull();
  });

  it('untouched save KEEPS the old baseline even when the server echoes a newer split', () => {
    // The multi-tab hole: another tab moved the split to newerFromOtherTab and the RPC
    // echoes it, but this tab did not edit the split — advancing the snapshot here would
    // let a later edit-from-stale-display overwrite it. The baseline must stay put so the
    // next edit conflicts instead.
    expect(
      nextLoadedSplitSnapshot({ touched: false, prevLoaded: older, echoed: newerFromOtherTab, currentValue: split })
    ).toBe(older);
  });

  it('untouched save keeps the baseline when nothing was echoed', () => {
    expect(
      nextLoadedSplitSnapshot({ touched: false, prevLoaded: older, echoed: undefined, currentValue: split })
    ).toBe(older);
  });
});

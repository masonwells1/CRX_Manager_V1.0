// Client half of the commission-split lost-update guard
// (migration 20260722190000_commission_split_lost_update_guard.sql).
//
// Saves resend the whole record, so a stale tab could silently overwrite a
// newer split reassignment (last-write-wins). The contract with save_quote /
// save_customer is:
//   - update + split untouched  -> omit the split key entirely; the RPC keeps
//     the stored value (already live behavior).
//   - update + split edited     -> send the new value PLUS `<key>_expected`
//     (the value loaded when the page opened); the RPC rejects the save with
//     COMMISSION_SPLIT_CONFLICT if the stored value no longer matches.
//   - insert                    -> send the value as before; no expected check.

export type CommissionSplitKey = 'commission_split' | 'default_commission_split';

export function buildCommissionSplitPatch(opts: {
  isUpdate: boolean;
  touched: boolean;
  key: CommissionSplitKey;
  value: unknown;
  /** Split as originally loaded from the DB (null when the record had none). */
  loaded: unknown;
}): Record<string, unknown> {
  if (!opts.isUpdate) return { [opts.key]: opts.value };
  if (!opts.touched) return {};
  return {
    [opts.key]: opts.value,
    [`${opts.key}_expected`]: opts.loaded ?? null,
  };
}

// The baseline snapshot (what `loaded` compares against on the NEXT save) must always
// equal the split the editor currently DISPLAYS. It therefore advances only when this
// tab saved its OWN split edit — never from an untouched save's echoed value, which
// could hold a newer split from another tab that the editor isn't showing. Advancing
// on an untouched save would let a later edit-from-stale-display declare that unseen
// newer value as `expected` and silently overwrite it (the multi-tab hole Codex flagged).
export function nextLoadedSplitSnapshot<T>(opts: {
  touched: boolean;
  /** Baseline before this save — kept as-is on an untouched save. */
  prevLoaded: T;
  /** Split the RPC echoed back (trigger-enriched); `undefined` if the server didn't echo. */
  echoed: T | undefined;
  /** Split value this tab sent (fallback when the server didn't echo). */
  currentValue: T;
}): T {
  if (!opts.touched) return opts.prevLoaded;
  return opts.echoed !== undefined ? opts.echoed : opts.currentValue;
}

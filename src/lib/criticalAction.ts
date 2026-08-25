import { Sentry } from './sentry';
import { sanitizeError } from './errorSanitizer';
import { isBelowCostApprovalHandledError } from './belowCostApproval';

type ToastFn = (type: 'success' | 'error' | 'info' | 'warning', message: string) => void;

export interface CriticalActionOptions<T> {
  /** The async operation to run (mutations, RPC calls, etc.) */
  action: () => Promise<T>;
  /** Toast function from useToast() */
  toast: ToastFn;
  /** Message shown on success (omit to skip success toast) */
  successMessage?: string;
  /** Loading state setter — called with true/false around the action */
  setLoading?: (loading: boolean) => void;
  /** Called after a successful action, receives the return value */
  onSuccess?: (result: T) => void;
  /** Tag sent to Sentry for filtering (e.g. "save_recipe", "delete_order") */
  sentryTag?: string;
}

/**
 * Run a critical mutation action with standardised error handling.
 *
 * Centralises the repeated pattern found across 19+ pages:
 *   setSaving(true) → try { mutation } → checkMutationResult → toast
 *   → catch → toast error → finally setSaving(false)
 *
 * Adds two things no page had before:
 *  1. sanitizeError() on every user-facing message (strips PG internals)
 *  2. Sentry.captureException() on every mutation failure
 *
 * @returns The action's return value on success, or undefined on failure.
 */
export async function runCriticalAction<T = void>(
  opts: CriticalActionOptions<T>
): Promise<T | undefined> {
  const { action, toast, successMessage, setLoading, onSuccess, sentryTag } = opts;

  setLoading?.(true);
  try {
    const result = await action();
    if (successMessage) {
      toast('success', successMessage);
    }
    onSuccess?.(result);
    return result;
  } catch (err: unknown) {
    if (isBelowCostApprovalHandledError(err)) return undefined;
    toast('error', sanitizeError(err));
    Sentry.captureException(err, {
      tags: { source: 'critical_action', action: sentryTag ?? 'unknown' },
    });
    return undefined;
  } finally {
    setLoading?.(false);
  }
}

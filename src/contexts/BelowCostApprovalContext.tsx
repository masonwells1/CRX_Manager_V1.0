import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import BelowCostApprovalModal from '../components/ui/BelowCostApprovalModal';
import { useToast } from '../components/ui/Toast';
import {
  BelowCostApprovalHandledError,
  parseBelowCostApprovalError,
  type BelowCostApprovalRunner,
  type BelowCostApprovalDetail,
} from '../lib/belowCostApproval';

interface ContextValue {
  runWithBelowCostApproval: BelowCostApprovalRunner;
}

const BelowCostApprovalContext = createContext<ContextValue>({
  runWithBelowCostApproval: async (attempt) => attempt(null),
});

export function BelowCostApprovalProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<BelowCostApprovalDetail | null>(null);
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((reason: string | null) => void) | null>(null);

  const requestReason = useCallback((nextDetail: BelowCostApprovalDetail | null) => {
    resolverRef.current?.(null);
    setDetail(nextDetail);
    setOpen(true);
    return new Promise<string | null>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const finishPrompt = useCallback((reason: string | null) => {
    setOpen(false);
    resolverRef.current?.(reason);
    resolverRef.current = null;
  }, []);

  const runWithBelowCostApproval = useCallback(async <T,>(
    attempt: (reason: string | null) => PromiseLike<T>,
  ): Promise<T> => {
    let firstResult: T;
    try {
      firstResult = await attempt(null);
    } catch (error: unknown) {
      const parsed = parseBelowCostApprovalError(error);
      if (!parsed) throw error;
      firstResult = { error } as T;
    }

    const responseError = firstResult && typeof firstResult === 'object' && 'error' in firstResult
      ? (firstResult as { error?: unknown }).error
      : null;
    const parsed = parseBelowCostApprovalError(responseError);
    if (!parsed) return firstResult;

    const product = parsed.detail?.product_name || 'this product';
    if (parsed.kind === 'admin') {
      toast('error', `Below-cost price requires an admin. Ask an active admin to complete this save for ${product}.`);
      throw new BelowCostApprovalHandledError();
    }
    if (parsed.kind === 'context') {
      const operation = parsed.detail?.operation || 'unknown operation';
      toast('error', `Below-cost approval could not be started for ${product}. Database wiring is missing for ${operation}.`);
      throw new BelowCostApprovalHandledError();
    }
    const reason = await requestReason(parsed.detail);
    if (!reason) throw new BelowCostApprovalHandledError();
    return attempt(reason);
  }, [requestReason, toast]);

  const value = useMemo(() => ({ runWithBelowCostApproval }), [runWithBelowCostApproval]);
  return (
    <BelowCostApprovalContext.Provider value={value}>
      {children}
      <BelowCostApprovalModal
        open={open}
        detail={detail}
        onCancel={() => finishPrompt(null)}
        onConfirm={finishPrompt}
      />
    </BelowCostApprovalContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBelowCostApproval(): ContextValue {
  return useContext(BelowCostApprovalContext);
}

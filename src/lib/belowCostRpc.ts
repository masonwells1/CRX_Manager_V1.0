import type { BelowCostLine } from '../components/ui/BelowCostConfirmModal';
import { supabaseUntyped } from './db';

type RpcErrorShape = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

function errorText(error: unknown): string {
  const candidate = error as RpcErrorShape | null;
  if (typeof candidate?.message === 'string') return candidate.message;
  if (typeof candidate?.details === 'string') return candidate.details;
  return '';
}

function isMissingReasonSignature(error: unknown, functionName: string): boolean {
  const candidate = error as RpcErrorShape | null;
  return candidate?.code === 'PGRST202'
    && errorText(error).includes(`public.${functionName}`)
    && errorText(error).includes('p_below_cost_reason');
}

/**
 * Call a lifecycle RPC with the new approval parameter while remaining safe
 * during the brief frontend-first rollout window before its migration is live.
 * A PGRST202 means PostgreSQL never entered the function, so retrying the old
 * signature cannot duplicate a committed mutation.
 */
export async function callBelowCostAwareRpc(
  functionName: string,
  args: Record<string, unknown>,
  belowCostReason: string | null = null,
) {
  const currentArgs = {
    ...args,
    p_below_cost_reason: belowCostReason,
  };
  const current = await supabaseUntyped.rpc(functionName, currentArgs);
  if (!current.error || !isMissingReasonSignature(current.error, functionName)) {
    return current;
  }
  return supabaseUntyped.rpc(functionName, args);
}

/** Parse the database's locked live-price/cost detail for the approval modal. */
export function belowCostLinesFromRpcError(error: unknown): BelowCostLine[] | null {
  const text = errorText(error);
  const prefix = 'BELOW_COST_REASON_REQUIRED:';
  const start = text.indexOf(prefix);
  if (start < 0) return null;

  try {
    const detail = JSON.parse(text.slice(start + prefix.length)) as {
      product_name?: unknown;
      unit_price_cents?: unknown;
      locked_unit_cost_cents?: unknown;
    };
    const priceCents = Number(detail.unit_price_cents);
    const costCents = Number(detail.locked_unit_cost_cents);
    if (!Number.isFinite(priceCents) || !Number.isFinite(costCents)) return null;
    return [{
      productName: typeof detail.product_name === 'string' && detail.product_name.trim()
        ? detail.product_name
        : 'Unknown product',
      price: priceCents / 100,
      cost: costCents / 100,
    }];
  } catch {
    return null;
  }
}

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

type InvoiceCostCandidate = {
  isApplicationFee: boolean;
  unitPriceCents: number;
  extendedCents: number;
  costCents: number;
};

/**
 * Return the comparable sale/cost pair for an Invoice approval prompt.
 * Product and ordinary misc lines store per-unit cost; application fees store
 * exact line-total cost because their quantity is acres, not a COGS multiplier.
 */
export function invoiceBelowCostValues(
  line: InvoiceCostCandidate,
): { price: number; cost: number } | null {
  if (!Number.isFinite(line.costCents) || line.costCents <= 0) return null;
  const priceCents = line.isApplicationFee ? line.extendedCents : line.unitPriceCents;
  if (!Number.isFinite(priceCents) || priceCents >= line.costCents) return null;
  return { price: priceCents / 100, cost: line.costCents / 100 };
}

/**
 * Call a lifecycle RPC through the database-enforced approval boundary.
 * Missing-signature PGRST202 errors deliberately fail closed: retrying the old
 * overload would execute the mutation without the active-admin/reason wall.
 * The database migration must therefore land before this browser bundle.
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
  return supabaseUntyped.rpc(functionName, currentArgs);
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

type RpcResponse = {
  error: unknown;
};

/**
 * Retry one failed money RPC after PostgreSQL supplies its locked live cost.
 * The caller owns the idempotency key and closes over the same key for both
 * calls. A cancellation returns the original denial without making a second
 * request, so no mutation can slip through without an explicit reason.
 */
export async function retryBelowCostReasonRequired<T extends RpcResponse>(
  initialReason: string | null,
  call: (reason: string | null) => PromiseLike<T>,
  requestReason: (lines: BelowCostLine[]) => Promise<string | null>,
): Promise<{ response: T; reason: string | null; cancelled: boolean }> {
  let response = await call(initialReason);
  if (!response.error || initialReason !== null) {
    return { response, reason: initialReason, cancelled: false };
  }

  const lines = belowCostLinesFromRpcError(response.error);
  if (!lines) return { response, reason: initialReason, cancelled: false };

  const reason = await requestReason(lines);
  if (reason === null) return { response, reason: null, cancelled: true };

  response = await call(reason);
  return { response, reason, cancelled: false };
}

import { assertRpcResult, supabaseUntyped } from './db';
import { callBelowCostAwareRpc } from './belowCostRpc';

type RpcErrorShape = {
  code?: unknown;
  message?: unknown;
};

function isMissingLifecycleSignature(error: unknown, functionName: string): boolean {
  const candidate = error as RpcErrorShape | null;
  return candidate?.code === 'PGRST202'
    && typeof candidate.message === 'string'
    && candidate.message.includes(`public.${functionName}`);
}

export type CreateQuoteVersionResult = {
  status?: string;
  version_id?: string;
  version_number?: number;
  row_version?: number;
  message?: string;
};

export type ConvertQuoteToOrderResult = {
  status: string;
  order_id?: string;
  order_number?: string;
  warnings?: string[];
};

export type RestoreQuoteVersionResult = {
  status: string;
  restored_from_version?: number;
  quote_id?: string;
  row_version?: number;
  message?: string;
};

/**
 * Frontend-first rollout bridge for the quote row-version migration.
 *
 * Before the migration, PostgREST cannot resolve the new named argument, so a
 * PGRST202 for this exact function is safe to retry against the old signature:
 * the first call never entered PostgreSQL. After the migration, business,
 * network, auth, and stale-write errors are returned without any fallback.
 */
export async function createQuoteVersionWithRowVersion(args: {
  p_quote_id: string;
  p_performed_by: string;
  p_method: string;
  p_idempotency_key: string;
  p_expected_row_version: number | null;
}) {
  const { p_expected_row_version: _expectedRowVersion, ...legacyArgs } = args;
  const { data, error } = await supabaseUntyped.rpc('create_quote_version', args);
  if (!error) {
    return {
      data: assertRpcResult<CreateQuoteVersionResult>(data, 'create_quote_version'),
      error: null,
    };
  }
  if (!isMissingLifecycleSignature(error, 'create_quote_version')) {
    return { data: null, error };
  }

  const { data: legacyData, error: legacyError } = await supabaseUntyped.rpc(
    'create_quote_version',
    legacyArgs,
  );
  if (legacyError) return { data: null, error: legacyError };
  return {
    data: assertRpcResult<CreateQuoteVersionResult>(legacyData, 'create_quote_version'),
    error: null,
  };
}

export async function convertQuoteToOrderWithRowVersion(args: {
  p_quote_id: string;
  p_performed_by: string;
  p_idempotency_key: string;
  p_expected_row_version: number | null;
  p_below_cost_reason?: string | null;
}) {
  const { p_below_cost_reason = null, ...rowVersionArgs } = args;
  const { data, error } = await callBelowCostAwareRpc(
    'convert_quote_to_order', rowVersionArgs, p_below_cost_reason,
  );
  if (!error) {
    return {
      data: assertRpcResult<ConvertQuoteToOrderResult>(data, 'convert_quote_to_order'),
      error: null,
    };
  }
  // Conversion is money/security sensitive. A missing governed signature must
  // fail closed instead of retrying an overload without row-version and
  // below-cost approval arguments.
  return { data: null, error };
}

export async function restoreQuoteVersionWithRowVersion(args: {
  p_quote_id: string;
  p_version_id: string;
  p_performed_by: string;
  p_idempotency_key: string;
  p_expected_row_version: number | null;
  p_below_cost_reason?: string | null;
}) {
  const { p_below_cost_reason = null, ...rowVersionArgs } = args;
  const { data, error } = await callBelowCostAwareRpc(
    'restore_quote_version', rowVersionArgs, p_below_cost_reason,
  );
  if (!error) {
    return {
      data: assertRpcResult<RestoreQuoteVersionResult>(data, 'restore_quote_version'),
      error: null,
    };
  }
  // Restore can recreate money-bearing lines. Preserve the governed error and
  // never retry a legacy overload that omits the concurrency and approval wall.
  return { data: null, error };
}

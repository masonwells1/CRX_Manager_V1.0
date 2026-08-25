import { assertRpcResult, supabaseUntyped } from './db';

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
  p_below_cost_reason?: string;
}) {
  const {
    p_expected_row_version: _expectedRowVersion,
    p_below_cost_reason: belowCostReason,
    ...legacyArgs
  } = args;
  const { data, error } = await supabaseUntyped.rpc('convert_quote_to_order', args);
  if (!error) {
    return {
      data: assertRpcResult<ConvertQuoteToOrderResult>(data, 'convert_quote_to_order'),
      error: null,
    };
  }
  if (!isMissingLifecycleSignature(error, 'convert_quote_to_order')) {
    return { data: null, error };
  }
  if (belowCostReason) return { data: null, error };

  const { data: legacyData, error: legacyError } = await supabaseUntyped.rpc(
    'convert_quote_to_order',
    legacyArgs,
  );
  if (legacyError) return { data: null, error: legacyError };
  return {
    data: assertRpcResult<ConvertQuoteToOrderResult>(legacyData, 'convert_quote_to_order'),
    error: null,
  };
}

export async function restoreQuoteVersionWithRowVersion(args: {
  p_quote_id: string;
  p_version_id: string;
  p_performed_by: string;
  p_idempotency_key: string;
  p_expected_row_version: number | null;
  p_below_cost_reason?: string;
}) {
  const {
    p_expected_row_version: _expectedRowVersion,
    p_below_cost_reason: belowCostReason,
    ...legacyArgs
  } = args;
  const { data, error } = await supabaseUntyped.rpc('restore_quote_version', args);
  if (!error) {
    return {
      data: assertRpcResult<RestoreQuoteVersionResult>(data, 'restore_quote_version'),
      error: null,
    };
  }
  if (!isMissingLifecycleSignature(error, 'restore_quote_version')) {
    return { data: null, error };
  }
  if (belowCostReason) return { data: null, error };

  const { data: legacyData, error: legacyError } = await supabaseUntyped.rpc(
    'restore_quote_version',
    legacyArgs,
  );
  if (legacyError) return { data: null, error: legacyError };
  return {
    data: assertRpcResult<RestoreQuoteVersionResult>(legacyData, 'restore_quote_version'),
    error: null,
  };
}

import { hasRpcCode, RpcErrorCodes } from './db';

export const RETURN_POLICY_NO_RETURN_MESSAGE = 'This Product is marked no return.';

/** Converts the guarded RPC policy token into one stable user-facing error. */
export function mapReturnPolicyRpcError(error: unknown): unknown {
  return hasRpcCode(error, RpcErrorCodes.RETURN_POLICY_NO_RETURN)
    ? new Error(`${RpcErrorCodes.RETURN_POLICY_NO_RETURN}: ${RETURN_POLICY_NO_RETURN_MESSAGE}`)
    : error;
}

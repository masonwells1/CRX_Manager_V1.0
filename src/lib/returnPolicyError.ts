const RETURN_POLICY_NO_RETURN_CODE = 'RETURN_POLICY_NO_RETURN';
export const RETURN_POLICY_NO_RETURN_MESSAGE = 'This Product is marked no return.';

/** Converts the guarded RPC policy token into one stable user-facing error. */
export function mapReturnPolicyRpcError(error: unknown): unknown {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error ?? '');
  const isNoReturnRefusal = message === RETURN_POLICY_NO_RETURN_CODE
    || message.startsWith(`${RETURN_POLICY_NO_RETURN_CODE}:`)
    || message.startsWith(`${RETURN_POLICY_NO_RETURN_CODE} `);

  return isNoReturnRefusal
    ? new Error(`${RETURN_POLICY_NO_RETURN_CODE}: ${RETURN_POLICY_NO_RETURN_MESSAGE}`)
    : error;
}

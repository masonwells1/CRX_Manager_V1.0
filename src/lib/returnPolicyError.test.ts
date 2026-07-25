import { describe, expect, it } from 'vitest';
import { mapReturnPolicyRpcError, RETURN_POLICY_NO_RETURN_MESSAGE } from './returnPolicyError';

describe('mapReturnPolicyRpcError', () => {
  it('maps only the canonical leading no-return token to the stable message', () => {
    const mapped = mapReturnPolicyRpcError({ message: 'RETURN_POLICY_NO_RETURN: database authority refused the item' });
    expect(mapped).toEqual(new Error(`RETURN_POLICY_NO_RETURN: ${RETURN_POLICY_NO_RETURN_MESSAGE}`));
  });

  it('preserves non-policy errors and never substring-matches a note', () => {
    const other = { message: 'note: RETURN_POLICY_NO_RETURN appears in a user note' };
    expect(mapReturnPolicyRpcError(other)).toBe(other);
  });
});

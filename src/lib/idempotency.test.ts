import { describe, it, expect } from 'vitest';
import { fingerprintIntentPayload, generateIdempotencyKey, getIdempotencyBindingRejection, getIdempotencyMismatchResult, isDefinitiveRpcRejection, isMissingIntentBindingColumn, legacyIntentChanged } from './idempotency';

describe('generateIdempotencyKey', () => {
  it('returns a string with the correct format', () => {
    const key = generateIdempotencyKey('create_order', 'user-123');
    const parts = key.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('create_order');
    expect(parts[1]).toBe('user-123');
    // parts[2] = UUID (36 chars with hyphens)
    expect(parts[2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('generates unique keys on consecutive calls', () => {
    const key1 = generateIdempotencyKey('op', 'user-1');
    const key2 = generateIdempotencyKey('op', 'user-1');
    expect(key1).not.toBe(key2);
  });

  it('includes the operation name', () => {
    const key = generateIdempotencyKey('complete_delivery', 'driver-5');
    expect(key.startsWith('complete_delivery:')).toBe(true);
  });

  it('includes the user ID', () => {
    const key = generateIdempotencyKey('allocate_payment', 'abc-def');
    expect(key).toContain(':abc-def:');
  });

  it('handles empty operation gracefully', () => {
    const key = generateIdempotencyKey('', 'user-1');
    expect(key.startsWith(':user-1:')).toBe(true);
  });

  it('handles empty userId gracefully', () => {
    const key = generateIdempotencyKey('op', '');
    expect(key.startsWith('op::')).toBe(true);
  });

  it('uses cryptographically strong randomness (UUID format)', () => {
    const key = generateIdempotencyKey('test', 'user');
    const uuid = key.split(':')[2];
    // UUID v4 has specific version/variant bits
    expect(uuid[14]).toBe('4'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(uuid[19]); // variant nibble
  });
});

describe('getIdempotencyMismatchResult', () => {
  it('returns the committed receipt for the expected operation', () => {
    const result = getIdempotencyMismatchResult({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({
        operation: 'save_invoice',
        result: { invoice_id: 'invoice-1' },
      }),
    }, 'save_invoice');

    expect(result).toEqual({ invoice_id: 'invoice-1' });
  });

  it('fails closed for malformed details or another operation', () => {
    expect(getIdempotencyMismatchResult(null, 'save_invoice')).toBeNull();
    expect(getIdempotencyMismatchResult({
      message: 'OTHER', details: '{}',
    }, 'save_invoice')).toBeNull();
    expect(getIdempotencyMismatchResult({
      message: 'IDEMPOTENCY_INTENT_MISMATCH', details: { result: {} },
    }, 'save_invoice')).toBeNull();
    expect(getIdempotencyMismatchResult({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: '{not-json',
    }, 'save_invoice')).toBeNull();

    expect(getIdempotencyMismatchResult({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({
        operation: 'create_quick_delivery',
        result: { delivery_id: 'delivery-1' },
      }),
    }, 'save_invoice')).toBeNull();

    expect(getIdempotencyMismatchResult({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({ operation: 'save_invoice', result: [] }),
    }, 'save_invoice')).toBeNull();
    expect(getIdempotencyMismatchResult({
      message: 'IDEMPOTENCY_INTENT_MISMATCH',
      details: JSON.stringify({ operation: 'save_invoice' }),
    }, 'save_invoice')).toBeNull();
  });
});

describe('getIdempotencyBindingRejection', () => {
  it('classifies every refusal that retires the key, and nothing else', () => {
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_INTENT_MISMATCH' })).toBe('intent');
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_ACTOR_MISMATCH' })).toBe('actor');
    expect(getIdempotencyBindingRejection(new Error('IDEMPOTENCY_ACTOR_MISMATCH'))).toBe('actor');
    // Both unusable-receipt codes must classify. If either fell through, the UI
    // would leave the dead key in place and the admin could never retry.
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_RESULT_INVALID' })).toBe('receipt');
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_RECEIPT_MISSING' })).toBe('receipt');
    expect(getIdempotencyBindingRejection(new Error('IDEMPOTENCY_RECEIPT_MISSING'))).toBe('receipt');
  });

  it('fails closed for anything else, so real failures still surface as errors', () => {
    expect(getIdempotencyBindingRejection(null)).toBeNull();
    expect(getIdempotencyBindingRejection('IDEMPOTENCY_INTENT_MISMATCH')).toBeNull();
    // Cross-op reuse is deliberately NOT classified: the key belongs to a
    // different operation entirely, so resetting it here would hide a caller bug.
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_CROSS_OP_KEY_REUSE' })).toBeNull();
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_KEY_REQUIRED' })).toBeNull();
    expect(getIdempotencyBindingRejection({ message: 'Admin access required to post a commission payment' })).toBeNull();
    // A substring must not be enough — only the exact refusal codes count.
    expect(getIdempotencyBindingRejection({ message: 'wrapped: IDEMPOTENCY_INTENT_MISMATCH' })).toBeNull();
    expect(getIdempotencyBindingRejection({})).toBeNull();
  });
});

describe('isDefinitiveRpcRejection', () => {
  it('distinguishes server refusals from transport-uncertain failures', () => {
    expect(isDefinitiveRpcRejection({ code: 'P0001', message: 'AMOUNT_EXCEEDS_CREDIT' })).toBe(true);
    expect(isDefinitiveRpcRejection({ code: '42501', message: 'denied' })).toBe(true);
    expect(isDefinitiveRpcRejection({ code: 'PGRST116', message: 'not singular' })).toBe(true);
    expect(isDefinitiveRpcRejection({ code: 'ECONNRESET', message: 'socket closed after commit' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: 'ETIMEDOUT', message: 'response timed out after commit' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: 'ETIME', message: 'runtime timeout' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: 'P0001', message: 'IDEMPOTENCY_RESULT_INVALID' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: 'P0001', message: 'IDEMPOTENCY_RECEIPT_MISSING' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: '', message: 'TypeError: Failed to fetch' })).toBe(false);
    expect(isDefinitiveRpcRejection(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('treats connection-outcome-unknown codes as uncertain, not a definitive refusal', () => {
    // Class 08 (connection_exception): the link can drop after the server
    // already committed, so these must never retire the idempotency key.
    expect(isDefinitiveRpcRejection({ code: '08000', message: 'connection exception' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: '08006', message: 'connection failure' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: '08007', message: 'transaction resolution unknown' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: '08p01', message: 'protocol violation' })).toBe(false);
    // Individually ambiguous codes inside otherwise-definitive classes.
    expect(isDefinitiveRpcRejection({ code: '40003', message: 'statement completion unknown' })).toBe(false);
    expect(isDefinitiveRpcRejection({ code: '57P01', message: 'terminating connection' })).toBe(false);
    // PGRST0xx are connection/pool-level failures, not statement refusals.
    expect(isDefinitiveRpcRejection({ code: 'PGRST001', message: 'could not connect to database' })).toBe(false);
    // A same-class code NOT on the ambiguous list stays a definitive refusal.
    expect(isDefinitiveRpcRejection({ code: '40001', message: 'serialization failure' })).toBe(true);
    expect(isDefinitiveRpcRejection({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
  });
});

describe('isMissingIntentBindingColumn', () => {
  it('accepts only missing-column errors naming the fingerprint column', () => {
    expect(isMissingIntentBindingColumn({
      code: 'PGRST204',
      message: "Could not find the 'request_fingerprint' column",
    })).toBe(true);
    expect(isMissingIntentBindingColumn({
      code: '42703',
      message: 'column request_fingerprint does not exist',
    })).toBe(true);
    expect(isMissingIntentBindingColumn({ code: 'PGRST204', message: 'another column missing' })).toBe(false);
    expect(isMissingIntentBindingColumn({ code: '42501', message: 'request_fingerprint denied' })).toBe(false);
  });
});

describe('legacyIntentChanged', () => {
  it('reuses an unresolved key only for identical old-schema retries', () => {
    const first = { key: 'same-key', intent: '{"quantity":1}' };
    expect(legacyIntentChanged(first, { ...first })).toBe(false);
    expect(legacyIntentChanged(first, { key: 'same-key', intent: '{"quantity":2}' })).toBe(true);
    expect(legacyIntentChanged(first, { key: 'new-key', intent: '{"quantity":2}' })).toBe(false);
  });
});

describe('fingerprintIntentPayload', () => {
  const boundaryA = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] };
  const boundaryB = { type: 'Polygon', coordinates: [[[5, 5], [5, 6], [6, 6], [5, 5]]] };
  const row = { customer_id: 'cust-1', field_name: 'North 40', total_acres: 40 };

  it('is stable for the same payload so a true retry still replays', () => {
    expect(fingerprintIntentPayload([row, boundaryA, null]))
      .toBe(fingerprintIntentPayload([row, boundaryA, null]));
  });

  it('returns a fixed-width hex digest', () => {
    expect(fingerprintIntentPayload([row, boundaryA, null])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when the boundary geometry changes', () => {
    // The BulkFieldImport P1: same row index, customer and field name, but a
    // different boundary must NOT reuse the earlier key, or the retained
    // field_id replays and overwrites the existing field.
    expect(fingerprintIntentPayload([row, boundaryA, null]))
      .not.toBe(fingerprintIntentPayload([row, boundaryB, null]));
  });

  it('changes when the billable stated acreage changes', () => {
    expect(fingerprintIntentPayload([row, boundaryA, null]))
      .not.toBe(fingerprintIntentPayload([row, boundaryA, 38.5]));
  });

  it('changes when any field-payload attribute changes', () => {
    expect(fingerprintIntentPayload([row, boundaryA, null]))
      .not.toBe(fingerprintIntentPayload([{ ...row, field_name: 'South 40' }, boundaryA, null]));
  });

  it('does not throw on an unserializable payload', () => {
    expect(() => fingerprintIntentPayload(undefined)).not.toThrow();
    expect(fingerprintIntentPayload(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });
});

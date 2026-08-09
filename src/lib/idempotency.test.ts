import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey, getIdempotencyBindingRejection, getIdempotencyMismatchResult, isMissingIntentBindingColumn, legacyIntentChanged } from './idempotency';

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
  it('classifies the two intent-binding refusals and nothing else', () => {
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_INTENT_MISMATCH' })).toBe('intent');
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_ACTOR_MISMATCH' })).toBe('actor');
    expect(getIdempotencyBindingRejection(new Error('IDEMPOTENCY_ACTOR_MISMATCH'))).toBe('actor');
  });

  it('fails closed for anything else, so real failures still surface as errors', () => {
    expect(getIdempotencyBindingRejection(null)).toBeNull();
    expect(getIdempotencyBindingRejection('IDEMPOTENCY_INTENT_MISMATCH')).toBeNull();
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_CROSS_OP_KEY_REUSE' })).toBeNull();
    expect(getIdempotencyBindingRejection({ message: 'IDEMPOTENCY_RECEIPT_MISSING' })).toBeNull();
    expect(getIdempotencyBindingRejection({ message: 'Admin access required to post a commission payment' })).toBeNull();
    // A substring must not be enough — only the exact refusal codes count.
    expect(getIdempotencyBindingRejection({ message: 'wrapped: IDEMPOTENCY_INTENT_MISMATCH' })).toBeNull();
    expect(getIdempotencyBindingRejection({})).toBeNull();
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

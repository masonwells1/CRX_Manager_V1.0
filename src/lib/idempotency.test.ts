import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey } from './idempotency';

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

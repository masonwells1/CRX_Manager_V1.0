import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey } from './idempotency';

describe('generateIdempotencyKey', () => {
  it('returns a string with the correct format', () => {
    const key = generateIdempotencyKey('create_order', 'user-123');
    const parts = key.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('create_order');
    expect(parts[1]).toBe('user-123');
    // parts[2] = timestamp (numeric), parts[3] = random string
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(parts[3].length).toBeGreaterThan(0);
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
    const key = generateIdempotencyKey('record_payment', 'abc-def');
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
});

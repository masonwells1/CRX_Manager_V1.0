/**
 * paymentAllocation.test.ts — Unit tests for auto-allocate algorithm
 *
 * Sprint 16: Unified Payment Allocation
 */
import { describe, it, expect } from 'vitest';
import { autoAllocate } from '../pages/PaymentAllocation';

describe('autoAllocate', () => {
  const invoices = [
    { id: 'inv-1', balance_cents: 100_00 },  // $100
    { id: 'inv-2', balance_cents: 250_00 },  // $250
    { id: 'inv-3', balance_cents: 150_00 },  // $150
  ];

  it('exact match — check equals total of all invoices', () => {
    const result = autoAllocate(500_00, invoices);
    expect(result.get('inv-1')).toBe(100_00);
    expect(result.get('inv-2')).toBe(250_00);
    expect(result.get('inv-3')).toBe(150_00);
    const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
    expect(total).toBe(500_00);
  });

  it('partial payment — check less than total', () => {
    const result = autoAllocate(200_00, invoices);
    expect(result.get('inv-1')).toBe(100_00);  // fully paid
    expect(result.get('inv-2')).toBe(100_00);  // partially paid
    expect(result.has('inv-3')).toBe(false);    // nothing left
    const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
    expect(total).toBe(200_00);
  });

  it('overpayment — check exceeds total (remainder = prepay)', () => {
    const result = autoAllocate(600_00, invoices);
    expect(result.get('inv-1')).toBe(100_00);
    expect(result.get('inv-2')).toBe(250_00);
    expect(result.get('inv-3')).toBe(150_00);
    const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
    expect(total).toBe(500_00);  // only allocated up to balances
    expect(600_00 - total).toBe(100_00);  // $100 becomes prepay
  });

  it('empty invoice list', () => {
    const result = autoAllocate(500_00, []);
    expect(result.size).toBe(0);
  });

  it('zero check amount', () => {
    const result = autoAllocate(0, invoices);
    expect(result.size).toBe(0);
  });

  it('single invoice — exact pay', () => {
    const result = autoAllocate(100_00, [{ id: 'inv-1', balance_cents: 100_00 }]);
    expect(result.get('inv-1')).toBe(100_00);
    expect(result.size).toBe(1);
  });

  it('single invoice — partial pay', () => {
    const result = autoAllocate(50_00, [{ id: 'inv-1', balance_cents: 100_00 }]);
    expect(result.get('inv-1')).toBe(50_00);
  });

  it('allocates oldest first (order preserved)', () => {
    const ordered = [
      { id: 'oldest', balance_cents: 300_00 },
      { id: 'newer', balance_cents: 300_00 },
    ];
    const result = autoAllocate(400_00, ordered);
    expect(result.get('oldest')).toBe(300_00);   // fully paid
    expect(result.get('newer')).toBe(100_00);     // partial
  });

  it('very small amounts — penny precision', () => {
    const small = [
      { id: 'a', balance_cents: 1 },
      { id: 'b', balance_cents: 2 },
      { id: 'c', balance_cents: 3 },
    ];
    const result = autoAllocate(4, small);
    expect(result.get('a')).toBe(1);
    expect(result.get('b')).toBe(2);
    expect(result.get('c')).toBe(1);
    const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
    expect(total).toBe(4);
  });

  // --- Edge case guards (production hardening) ---

  it('NaN check amount — returns empty map', () => {
    const result = autoAllocate(NaN, invoices);
    expect(result.size).toBe(0);
  });

  it('negative check amount — returns empty map', () => {
    const result = autoAllocate(-500_00, invoices);
    expect(result.size).toBe(0);
  });

  it('Infinity check amount — returns empty map', () => {
    const result = autoAllocate(Infinity, invoices);
    expect(result.size).toBe(0);
  });

  it('skips invoices with NaN/negative balance', () => {
    const mixed = [
      { id: 'bad1', balance_cents: NaN },
      { id: 'good', balance_cents: 100_00 },
      { id: 'bad2', balance_cents: -50_00 },
      { id: 'good2', balance_cents: 200_00 },
    ];
    const result = autoAllocate(250_00, mixed);
    expect(result.has('bad1')).toBe(false);
    expect(result.has('bad2')).toBe(false);
    expect(result.get('good')).toBe(100_00);
    expect(result.get('good2')).toBe(150_00);
  });
});

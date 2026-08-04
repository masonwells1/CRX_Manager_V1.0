import { describe, it, expect } from 'vitest';
import { getStatementAccountPosition } from './statementBalance';
import type { DetailedStatementData } from '../types';

/**
 * getStatementAccountPosition is the fail-closed gate between a statement RPC
 * payload and a customer-facing document. A legacy payload missing the balance
 * disclosure fields must THROW rather than render a statement with a wrong or
 * absent account position — so the throw is the behavior under test, not an edge case.
 */
const base = {
  outstanding_balance_cents: 250_00,
  open_credit_cents: 50_00,
  net_account_position_cents: 200_00,
} as unknown as DetailedStatementData;

describe('getStatementAccountPosition', () => {
  it('returns the three authoritative figures from a complete payload', () => {
    expect(getStatementAccountPosition(base)).toEqual({
      grossOpenInvoiceCents: 250_00,
      openCreditCents: 50_00,
      netAccountPositionCents: 200_00,
    });
  });

  it('passes cents through untouched — no rounding, no division', () => {
    const odd = {
      outstanding_balance_cents: 1,
      open_credit_cents: 0,
      net_account_position_cents: 1,
    } as unknown as DetailedStatementData;
    expect(getStatementAccountPosition(odd)).toEqual({
      grossOpenInvoiceCents: 1,
      openCreditCents: 0,
      netAccountPositionCents: 1,
    });
  });

  it('accepts a zero balance (a paid-up customer is not a legacy payload)', () => {
    const zero = {
      outstanding_balance_cents: 0,
      open_credit_cents: 0,
      net_account_position_cents: 0,
    } as unknown as DetailedStatementData;
    expect(getStatementAccountPosition(zero).netAccountPositionCents).toBe(0);
  });

  it('accepts a negative net position (customer in credit)', () => {
    const credit = {
      outstanding_balance_cents: 0,
      open_credit_cents: 75_00,
      net_account_position_cents: -75_00,
    } as unknown as DetailedStatementData;
    expect(getStatementAccountPosition(credit).netAccountPositionCents).toBe(-75_00);
  });

  it.each([
    ['open_credit_cents missing', { outstanding_balance_cents: 1, net_account_position_cents: 1 }],
    ['net_account_position_cents missing', { outstanding_balance_cents: 1, open_credit_cents: 1 }],
    ['both missing', { outstanding_balance_cents: 1 }],
    [
      'open_credit_cents null',
      { outstanding_balance_cents: 1, open_credit_cents: null, net_account_position_cents: 1 },
    ],
    [
      'net_account_position_cents a string',
      { outstanding_balance_cents: 1, open_credit_cents: 1, net_account_position_cents: '1' },
    ],
  ])('throws when the balance disclosure is not ready: %s', (_label, payload) => {
    expect(() => getStatementAccountPosition(payload as unknown as DetailedStatementData)).toThrow(
      /balance disclosure is not ready/,
    );
  });

  it('fails closed rather than defaulting a missing figure to zero', () => {
    const legacy = {
      outstanding_balance_cents: 500_00,
    } as unknown as DetailedStatementData;
    // The dangerous alternative would be returning netAccountPositionCents: 0
    // on a customer who owes $500.
    expect(() => getStatementAccountPosition(legacy)).toThrow();
  });
});

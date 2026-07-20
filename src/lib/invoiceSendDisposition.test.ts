import { describe, expect, it } from 'vitest';
import { assertInvoiceSendDisposition } from './invoiceSendDisposition';

describe('assertInvoiceSendDisposition', () => {
  it('allows only the explicit server sendable value', () => {
    expect(() => assertInvoiceSendDisposition('sendable')).not.toThrow();
  });

  it('blocks suppressed zero-dollar split invoices', () => {
    expect(() => assertInvoiceSendDisposition('suppressed_zero_total')).toThrow(/must not be emailed/);
  });

  it.each([null, undefined, '', 'unknown'])('fails closed for %s', (value) => {
    expect(() => assertInvoiceSendDisposition(value)).toThrow(/unavailable/);
  });

  it.each(['voided', 'cancelled'])('blocks the terminal %s lifecycle even when sendable', (status) => {
    expect(() => assertInvoiceSendDisposition('sendable', status, null)).toThrow(/must not be emailed/);
  });

  it('blocks soft-deleted invoices even when sendable', () => {
    expect(() => assertInvoiceSendDisposition('sendable', 'draft', '2026-07-20T00:00:00Z')).toThrow(/must not be emailed/);
  });
});

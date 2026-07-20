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
});

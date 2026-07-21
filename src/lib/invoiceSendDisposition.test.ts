import { describe, expect, it } from 'vitest';
import { assertInvoiceLifecycle, assertInvoiceSendDisposition } from './invoiceSendDisposition';

describe('assertInvoiceSendDisposition', () => {
  it.each(['normal', 'sendable'])('allows the explicit server sendable value %s', (value) => {
    expect(() => assertInvoiceSendDisposition(value)).not.toThrow();
  });

  it('blocks suppressed zero-dollar split invoices', () => {
    expect(() => assertInvoiceSendDisposition('suppressed_zero_total')).toThrow(/must not be emailed/);
  });

  it.each([null, undefined, '', 'unknown'])('fails closed for %s', (value) => {
    expect(() => assertInvoiceSendDisposition(value)).toThrow(/unavailable/);
  });

  it.each(['voided', 'cancelled'])('blocks the terminal %s lifecycle even when sendable', (status) => {
    expect(() => assertInvoiceSendDisposition('normal', status, null)).toThrow(/must not be emailed/);
  });

  it('blocks soft-deleted invoices even when sendable', () => {
    expect(() => assertInvoiceSendDisposition('normal', 'draft', '2026-07-20T00:00:00Z')).toThrow(/must not be emailed/);
  });
});

describe('assertInvoiceLifecycle', () => {
  it('allows an active invoice regardless of its billing disposition', () => {
    expect(() => assertInvoiceLifecycle('posted', null)).not.toThrow();
  });

  it.each(['voided', 'cancelled'])('blocks the terminal %s lifecycle', (status) => {
    expect(() => assertInvoiceLifecycle(status, null)).toThrow(/must not be emailed/);
  });

  it('blocks a soft-deleted invoice', () => {
    expect(() => assertInvoiceLifecycle('posted', '2026-07-20T00:00:00Z')).toThrow(/must not be emailed/);
  });
});

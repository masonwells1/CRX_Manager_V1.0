import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Vitest transforms import.meta.url to a non-file Vite URL on Windows, so the
// repository-root working directory used by every package script is deliberate.
// CRLF-normalized so Windows checkouts (autocrlf) match the LF snippets below.
const source = readFileSync('supabase/functions/send-email/index.ts', 'utf8').replace(/\r\n/g, '\n');

describe('send-email invoice authority contracts', () => {
  it('does not hide terminal invoices before deriving the proof-notice gate', () => {
    const lookupStart = source.indexOf('const { data: jobInvoices');
    const lookupEnd = source.indexOf('const matchingInvoices', lookupStart);
    const lookup = source.slice(lookupStart, lookupEnd);
    const invoiceGateStart = source.indexOf('if (invoiceGateId) {', lookupEnd);
    const finalGateStart = source.indexOf('// 6. Driver per-resource auth', invoiceGateStart);
    const invoiceGate = source.slice(invoiceGateStart, finalGateStart);

    expect(lookupStart).toBeGreaterThan(-1);
    expect(lookupEnd).toBeGreaterThan(lookupStart);
    expect(invoiceGateStart).toBeGreaterThan(lookupEnd);
    expect(finalGateStart).toBeGreaterThan(invoiceGateStart);
    expect(lookup).toContain('.eq("job_id", notificationRow.job_id)');
    expect(lookup).toContain('.select("id, customer_id, status, deleted_at")');
    expect(lookup).not.toContain('.is("deleted_at", null)');
    expect(lookup).not.toContain('.not("status"');
    expect(invoiceGate).toContain('invoiceRow.deleted_at != null || invoiceRow.status === "voided" || invoiceRow.status === "cancelled"');
    expect(source).toContain('activeMatchingInvoices.length > 1');
    expect(source).toContain('matchingInvoices.length === 1 ? matchingInvoices[0] : null');
  });

  it('rechecks invoice lifecycle immediately before the outbound provider call', () => {
    const resendBodyStart = source.indexOf('const resendBody: Record<string, unknown>');
    const finalGateStart = source.indexOf('const finalGateLookup', resendBodyStart);
    const outboundSendStart = source.indexOf('await fetch("https://api.resend.com/emails"', finalGateStart);
    const finalGate = source.slice(finalGateStart, outboundSendStart);

    expect(resendBodyStart).toBeGreaterThan(-1);
    expect(finalGateStart).toBeGreaterThan(resendBodyStart);
    expect(outboundSendStart).toBeGreaterThan(finalGateStart);
    expect(finalGate).toContain('.select("id, customer_id, send_disposition, status, deleted_at")');
    expect(finalGate).toContain('finalInvoiceRow.deleted_at != null');
    expect(finalGate).toContain('finalInvoiceRow.status === "voided"');
    expect(finalGate).toContain('finalInvoiceRow.status === "cancelled"');
    expect(finalGate).toContain('finalInvoiceRow.customer_id !== invoiceGateCustomerId');
    expect(finalGate).toContain('finalInvoiceRow.send_disposition !== "normal"');
    expect(finalGate).toContain('const finalLogResult = await adminClient');
    expect(finalGate).toContain('if (finalLogResult.error || !finalLogResult.data)');
  });

  it('suppresses invoice mail but permits proof notices for active zero-share co-owners', () => {
    expect(source).toContain('email_type === "invoice" &&\n        invoiceRow.send_disposition != null');
    expect(source).toContain('email_type === "invoice" &&\n        finalInvoiceRow.send_disposition != null');
  });
});

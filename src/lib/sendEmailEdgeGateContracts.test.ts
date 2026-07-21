import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('supabase/functions/send-email/index.ts', 'utf8');

describe('send-email invoice authority contracts', () => {
  it('does not hide terminal invoices before deriving the proof-notice gate', () => {
    const lookupStart = source.indexOf('const { data: jobInvoices');
    const lookupEnd = source.indexOf('const matchingInvoices', lookupStart);
    const lookup = source.slice(lookupStart, lookupEnd);

    expect(lookupStart).toBeGreaterThan(-1);
    expect(lookupEnd).toBeGreaterThan(lookupStart);
    expect(lookup).toContain('.eq("job_id", notificationRow.job_id)');
    expect(lookup).not.toContain('.is("deleted_at", null)');
    expect(lookup).not.toContain('.not("status"');
    expect(source).toContain('invoiceRow.deleted_at != null || invoiceRow.status === "voided" || invoiceRow.status === "cancelled"');
    expect(source).toContain('matchingInvoices.length > 1');
  });
});

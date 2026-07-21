import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('per-line billing UI contracts', () => {
  it.each([
    ['src/pages/FieldApplicationInvoice.tsx', 2],
    ['src/pages/InvoiceDetail.tsx', 1],
    ['src/components/field-invoices/FieldInvoicesListPanel.tsx', 1],
    ['src/components/field-invoices/FieldInvoicesUnpostedPanel.tsx', 1],
    ['src/components/field-invoices/FieldInvoicesPostedPanel.tsx', 1],
  ])('server-gates every send in %s', (path, expected) => {
    const source = read(path);
    expect(source.match(/assertInvoiceSendable\(/g)?.length).toBe(expected);
    expect(source.match(/await sendEmail\(/g)?.length).toBe(expected);
  });

  it('invoice and detailed-statement renderers use stored cents', () => {
    const invoicePdf = read('src/lib/invoicePdf.ts');
    const statementPdf = read('src/lib/statementPdf.ts');
    const customerSummary = read('src/lib/customerInvoiceSummary.ts');
    expect(invoicePdf).toContain('fmt(item.extended_cents)');
    expect(statementPdf).toContain('fmt(item.total_cost_cents)');
    expect(invoicePdf).not.toMatch(/quantity\s*\*\s*item\.unit_price_cents/);
    expect(statementPdf).not.toMatch(/quantity\s*\*\s*item\.unit_price_cents/);
    expect(customerSummary).not.toMatch(/quantity\s*\*\s*.*unit_price_cents/);
  });

  it('routes preview and save through the per-line RPC only behind the server flag', () => {
    const source = read('src/pages/FieldApplicationInvoice.tsx');
    expect(source).toContain("supabase.rpc('save_field_app_invoice_per_line' as 'save_field_app_invoice'");
    expect(source).toContain("supabase.rpc('save_field_app_invoice', saveArgs)");
    expect(source).toContain('p_job_id: jobId as string, p_line_overrides: perLineOptions');
    expect(source).toContain('p_job_id: jobId as string, p_options: perLineOptions');
    expect(source).toContain('const recipientInvoiceId = customerToInvoiceId[r.customer_id]');
    expect(source).toContain('await assertInvoiceSendable(recipientInvoiceId)');
    expect(source).toContain("customerToInvoiceId[r.customer_id] ?? (!invoiceGroupId ? id : null)");
  });

  it('enforces send_disposition again inside the send-email server boundary', () => {
    const source = read('supabase/functions/send-email/index.ts');
    expect(source).toContain('.select("id, customer_id, send_disposition, status, deleted_at")');
    expect(source).toContain('invoiceRow.send_disposition !== "sendable"');
    expect(source).toContain('invoiceRow.status === "voided" || invoiceRow.status === "cancelled"');
    expect(source).toContain('.not("status", "in", \'("voided","cancelled")\')');
    expect(source).toContain('email_type === "post_application_notice"');
    expect(source).toContain('.from("job_notifications")');
    expect(source).toContain('resource_type === "invoice"');
    expect(source).toContain('invoiceGateId = derivedInvoice?.id ?? null');
  });
});

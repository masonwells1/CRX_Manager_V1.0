import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase before importing the module
const mockGetSession = vi.fn();
const mockFetch = vi.fn();

vi.mock('./db', () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
    },
  },
}));

vi.stubGlobal('fetch', mockFetch);

import { sendEmail, pdfToBase64, buildEmailHtml, buildInvoiceEmailPayload, isInvoiceEmailSuppressed } from './emailService';
import type { SendEmailParams, InvoiceEmailInput } from './emailService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isInvoiceEmailSuppressed', () => {
  it('refuses only the server disposition for zero-total split children', () => {
    expect(isInvoiceEmailSuppressed({ send_disposition: 'suppressed_zero_total' })).toBe(true);
    expect(isInvoiceEmailSuppressed({ send_disposition: 'sendable' })).toBe(false);
    expect(isInvoiceEmailSuppressed(null)).toBe(false);
  });
});

describe('pdfToBase64', () => {
  it('extracts base64 portion from jsPDF datauristring output', () => {
    const mockDoc = {
      output: (type: string) => {
        expect(type).toBe('datauristring');
        return 'data:application/pdf;filename=test.pdf;base64,SGVsbG9Xb3JsZA==';
      },
    };
    expect(pdfToBase64(mockDoc)).toBe('SGVsbG9Xb3JsZA==');
  });

  it('handles datauristring without filename segment', () => {
    const mockDoc = {
      output: () => 'data:application/pdf;base64,QUJD',
    };
    expect(pdfToBase64(mockDoc)).toBe('QUJD');
  });

  it('returns undefined if no base64 marker present', () => {
    const mockDoc = {
      output: () => 'no-base64-content',
    };
    expect(pdfToBase64(mockDoc)).toBeUndefined();
  });
});

describe('buildEmailHtml', () => {
  it('wraps body content in CRX-branded template', () => {
    const result = buildEmailHtml('<p>Hello customer</p>');
    expect(result).toContain('<p>Hello customer</p>');
    expect(result).toContain('Crop RX Solutions');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('</html>');
  });

  it('includes the automated message footer', () => {
    const result = buildEmailHtml('test');
    expect(result).toContain('This is an automated message');
    expect(result).toContain('croprxsolutions.app');
  });

  it('preserves HTML tags in body content', () => {
    const result = buildEmailHtml('<strong>Bold</strong> and <a href="#">link</a>');
    expect(result).toContain('<strong>Bold</strong>');
    expect(result).toContain('<a href="#">link</a>');
  });

  it('handles empty string body', () => {
    const result = buildEmailHtml('');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('Crop RX Solutions');
  });
});

describe('sendEmail', () => {
  const validParams: SendEmailParams = {
    to: 'test@example.com',
    subject: 'Test Invoice',
    html: '<p>Invoice attached</p>',
    email_type: 'invoice',
    customer_id: 'cust-123',
    idempotency_key: 'idem-abc',
  };

  const mockSession = {
    data: {
      session: {
        access_token: 'test-jwt-token',
      },
    },
    error: null,
  };

  it('throws when session has an error', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Refresh token expired' },
    });

    await expect(sendEmail(validParams)).rejects.toThrow('Auth session error: Refresh token expired');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when not authenticated (no session)', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    await expect(sendEmail(validParams)).rejects.toThrow('Not authenticated');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends correct request to edge function', async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        email_log_id: 'log-1',
        resend_message_id: 'msg-1',
      }),
    });

    const result = await sendEmail(validParams);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/functions/v1/send-email');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer test-jwt-token');
    expect(JSON.parse(options.body)).toEqual(validParams);
    expect(result.success).toBe(true);
    expect(result.email_log_id).toBe('log-1');
  });

  it('throws on non-ok HTTP response with error message', async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Invalid email address' }),
    });

    await expect(sendEmail(validParams)).rejects.toThrow('Invalid email address');
  });

  it('throws generic message when error field is missing', async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(sendEmail(validParams)).rejects.toThrow('Email send failed');
  });

  it('throws on invalid JSON response', async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    await expect(sendEmail(validParams)).rejects.toThrow('Email service returned invalid response (HTTP 200)');
  });

  it('includes attachments in the request body', async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const paramsWithAttachment: SendEmailParams = {
      ...validParams,
      attachments: [{ filename: 'invoice.pdf', content: 'base64data' }],
    };

    await sendEmail(paramsWithAttachment);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.attachments).toEqual([{ filename: 'invoice.pdf', content: 'base64data' }]);
  });
});

// #31: the field-app "Email invoice to customer" payload builder. These tests pin
// the recipient resolution + payload shape that every field-app screen (per-acre
// editor toolbar, combined list, unposted/posted lists) relies on, so a missing
// email never sends to a blank/wrong address and the attachment is the right one.
describe('buildInvoiceEmailPayload', () => {
  const base: InvoiceEmailInput = {
    customerEmail: 'farmer@example.com',
    customerId: 'cust-123',
    invoiceId: 'inv-456',
    invoiceNumber: 'FA-1001',
    invoiceDate: '2026-06-25',
    balanceCents: 125000, // $1,250.00
    attachmentBase64: 'QkFTRTY0UERG', // dummy base64
    nowMs: 1_700_000_000_000,
  };

  it('addresses the email to the resolved customer email', () => {
    const p = buildInvoiceEmailPayload(base);
    expect(p.to).toBe('farmer@example.com');
    expect(p.customer_id).toBe('cust-123');
  });

  it('throws an honest error (no send) when the customer has no email on file', () => {
    expect(() => buildInvoiceEmailPayload({ ...base, customerEmail: null }))
      .toThrow('Customer does not have an email address on file');
    expect(() => buildInvoiceEmailPayload({ ...base, customerEmail: undefined }))
      .toThrow('Customer does not have an email address on file');
    expect(() => buildInvoiceEmailPayload({ ...base, customerEmail: '' }))
      .toThrow('Customer does not have an email address on file');
    // whitespace-only must NOT be treated as a valid address
    expect(() => buildInvoiceEmailPayload({ ...base, customerEmail: '   ' }))
      .toThrow('Customer does not have an email address on file');
  });

  it('trims surrounding whitespace from the recipient', () => {
    const p = buildInvoiceEmailPayload({ ...base, customerEmail: '  farmer@example.com  ' });
    expect(p.to).toBe('farmer@example.com');
  });

  it('attaches the supplied PDF under an invoice-numbered filename', () => {
    const p = buildInvoiceEmailPayload(base);
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments![0].filename).toBe('Invoice-FA-1001.pdf');
    expect(p.attachments![0].content).toBe('QkFTRTY0UERG');
  });

  it('builds a deterministic, per-invoice idempotency key', () => {
    const p = buildInvoiceEmailPayload(base);
    expect(p.idempotency_key).toBe('invoice-email-inv-456-1700000000000');
  });

  it('marks the send as an invoice email about this invoice resource', () => {
    const p = buildInvoiceEmailPayload(base);
    expect(p.email_type).toBe('invoice');
    expect(p.resource_type).toBe('invoice');
    expect(p.resource_id).toBe('inv-456');
  });

  it('puts the invoice number, formatted balance, and date in the subject + body', () => {
    const p = buildInvoiceEmailPayload(base);
    expect(p.subject).toBe('Invoice FA-1001 from Crop RX Solutions');
    expect(p.html).toContain('Field Application Invoice FA-1001');
    expect(p.html).toContain('$1,250.00');
    expect(p.html).toContain('2026-06-25');
  });

  it('formats a zero balance correctly (paid invoice)', () => {
    const p = buildInvoiceEmailPayload({ ...base, balanceCents: 0 });
    expect(p.html).toContain('$0.00');
  });
});

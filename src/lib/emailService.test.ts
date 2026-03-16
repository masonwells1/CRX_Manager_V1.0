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

import { sendEmail, pdfToBase64, buildEmailHtml } from './emailService';
import type { SendEmailParams } from './emailService';

beforeEach(() => {
  vi.clearAllMocks();
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

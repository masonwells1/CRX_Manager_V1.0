import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock surface — supabase chainable client + sendEmail + Sentry
// ---------------------------------------------------------------------------

interface OrderRow {
  id: string;
  order_number: string;
  order_date: string;
  total_price: number;
  customer_id: string;
}

interface CustomerRow {
  email: string | null;
  contact_name: string | null;
}

interface OrderItemRow {
  product_name: string;
  total_units_needed: number;
  price_per_unit: number;
}

const mockOrder: OrderRow = {
  id: 'order-1',
  order_number: 'ORD-2026-0001',
  order_date: '2026-05-06',
  total_price: 1234.56,
  customer_id: 'cust-1',
};

const mockCustomer: CustomerRow = {
  email: 'farmer@example.com',
  contact_name: 'Pat',
};

const mockItems: OrderItemRow[] = [
  { product_name: 'Roundup', total_units_needed: 10, price_per_unit: 50 },
  { product_name: 'Atrazine', total_units_needed: 5, price_per_unit: 80 },
];

let orderResp: { data: OrderRow | null; error: { message: string } | null } = { data: mockOrder, error: null };
let customerResp: { data: CustomerRow | null; error: null } = { data: mockCustomer, error: null };
let itemsResp: { data: OrderItemRow[] | null; error: null } = { data: mockItems, error: null };

const fromSpy = vi.fn((table: string) => {
  const queryShape = (resp: unknown) => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve(resp),
      }),
    }),
  });
  const itemsShape = (resp: unknown) => ({
    select: () => ({
      eq: () => Promise.resolve(resp),
    }),
  });
  if (table === 'orders') return queryShape(orderResp);
  if (table === 'customers') return queryShape(customerResp);
  if (table === 'order_items') return itemsShape(itemsResp);
  throw new Error(`Unexpected table in test: ${table}`);
});

vi.mock('./db', () => ({
  supabase: { from: (t: string) => fromSpy(t) },
}));

const sendEmailMock = vi.fn<(params: Record<string, unknown>) => Promise<{ success: boolean }>>(() =>
  Promise.resolve({ success: true })
);
vi.mock('./emailService', () => ({
  sendEmail: (params: Record<string, unknown>) => sendEmailMock(params),
  buildEmailHtml: (body: string) => `<html>${body}</html>`,
}));

const sentryCaptureMock =
  vi.fn<(err: unknown, opts?: { level?: string; extra?: Record<string, unknown> }) => void>();
vi.mock('./sentry', () => ({
  Sentry: {
    captureException: (err: unknown, opts?: { level?: string; extra?: Record<string, unknown> }) =>
      sentryCaptureMock(err, opts),
  },
}));

// Import AFTER mocks are registered
import { sendOrderConfirmedEmail } from './orderConfirmedEmail';

beforeEach(() => {
  vi.clearAllMocks();
  orderResp = { data: mockOrder, error: null };
  customerResp = { data: mockCustomer, error: null };
  itemsResp = { data: mockItems, error: null };
});

describe('sendOrderConfirmedEmail', () => {
  it('sends an email with the right shape when customer has an email', async () => {
    await sendOrderConfirmedEmail('order-1');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.to).toBe('farmer@example.com');
    expect(args.email_type).toBe('order_confirmed');
    expect(args.customer_id).toBe('cust-1');
    expect(args.resource_type).toBe('order');
    expect(args.resource_id).toBe('order-1');
    expect(args.subject).toContain('ORD-2026-0001');
  });

  it('uses a stable idempotency key (no Date.now()) so retries dedupe', async () => {
    await sendOrderConfirmedEmail('order-1');
    const args = sendEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.idempotency_key).toBe('order-confirmed-order-1');
  });

  it('includes the contact name in the greeting when present', async () => {
    await sendOrderConfirmedEmail('order-1');
    const args = sendEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(String(args.html)).toContain('Hi Pat');
  });

  it('omits the contact name in the greeting when null', async () => {
    customerResp = { data: { ...mockCustomer, contact_name: null }, error: null };
    await sendOrderConfirmedEmail('order-1');
    const args = sendEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(String(args.html)).toContain('Hi,');
  });

  it('skips silently (no Sentry, no email) when customer has no email', async () => {
    customerResp = { data: { ...mockCustomer, email: null }, error: null };
    await sendOrderConfirmedEmail('order-1');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('logs to Sentry at warning level when the order lookup fails', async () => {
    orderResp = { data: null, error: { message: 'Order not found' } };
    await sendOrderConfirmedEmail('missing-order');
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const opts = sentryCaptureMock.mock.calls[0][1] as { level?: string; extra?: Record<string, unknown> };
    expect(opts.level).toBe('warning');
    expect(opts.extra?.orderId).toBe('missing-order');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('logs to Sentry and never throws when sendEmail rejects', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('Edge Function timeout'));
    await expect(sendOrderConfirmedEmail('order-1')).resolves.toBeUndefined();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const opts = sentryCaptureMock.mock.calls[0][1] as { level?: string; extra?: Record<string, unknown> };
    expect(opts.level).toBe('warning');
    expect(opts.extra?.context).toBe('order_confirmed_email_send');
  });

  it('truncates the items list at 10 in the email body', async () => {
    itemsResp = {
      data: Array.from({ length: 12 }, (_, i) => ({
        product_name: `Product ${i}`,
        total_units_needed: 1,
        price_per_unit: 10,
      })),
      error: null,
    };
    await sendOrderConfirmedEmail('order-1');
    const args = sendEmailMock.mock.calls[0][0] as Record<string, unknown>;
    const html = String(args.html);
    expect(html).toContain('Product 9');
    expect(html).not.toContain('Product 10');
    expect(html).toContain('and 2 more item(s)');
  });
});

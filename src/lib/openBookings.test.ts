import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCaptureException, mockEq, mockFrom, mockIn, mockIs, mockOrder } = vi.hoisted(() => {
  const mockOrder = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockIs = vi.fn();
  const mockIn = vi.fn();
  const mockEq = vi.fn();
  const chain = { eq: mockEq, in: mockIn, is: mockIs, order: mockOrder };
  mockEq.mockReturnValue(chain);
  mockIn.mockReturnValue(chain);
  mockIs.mockReturnValue(chain);

  const mockFrom = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) });
  const mockCaptureException = vi.fn();
  return { mockCaptureException, mockEq, mockFrom, mockIn, mockIs, mockOrder };
});

vi.mock('./db', () => ({ supabase: { from: mockFrom } }));
vi.mock('./sentry', () => ({ Sentry: { captureException: mockCaptureException } }));

import { fetchOpenBookings } from './openBookings';

describe('fetchOpenBookings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrder.mockResolvedValue({ data: [], error: null });
  });

  it('returns sent and revised booking rows', async () => {
    const bookings = [
      { id: 'quote-1', quote_number: 'Q-1001', status: 'sent' },
      { id: 'quote-2', quote_number: 'Q-1002', status: 'revised' },
    ];
    mockOrder.mockResolvedValueOnce({ data: bookings, error: null });

    await expect(fetchOpenBookings('customer-1')).resolves.toEqual(bookings);
    expect(mockFrom).toHaveBeenCalledWith('quotes');
    expect(mockEq).toHaveBeenCalledWith('customer_id', 'customer-1');
    expect(mockIn).toHaveBeenCalledWith('status', ['sent', 'revised']);
    expect(mockIs).toHaveBeenCalledWith('deleted_at', null);
    expect(mockOrder).toHaveBeenCalledWith('quote_number');
  });

  it('returns an empty list and reports an error', async () => {
    const error = new Error('Unable to load quotes');
    mockOrder.mockResolvedValueOnce({ data: null, error });

    await expect(fetchOpenBookings('customer-1')).resolves.toEqual([]);
    expect(mockCaptureException).toHaveBeenCalledWith(error, expect.any(Object));
  });
});

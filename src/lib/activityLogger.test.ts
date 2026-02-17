import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase before importing the module
const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });

vi.mock('./db', () => ({
  supabase: { from: (...args: any[]) => mockFrom(...args) },
}));

import { logActivity, createNotification, notifyAdmins } from './activityLogger';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logActivity', () => {
  it('inserts into activity_feed with required fields', async () => {
    await logActivity('quote_created', 'Quote Q-001 created', 'user-1');

    expect(mockFrom).toHaveBeenCalledWith('activity_feed');
    expect(mockInsert).toHaveBeenCalledWith({
      event_type: 'quote_created',
      description: 'Quote Q-001 created',
      performed_by: 'user-1',
      related_entity_type: null,
      related_entity_id: null,
      customer_id: null,
    });
  });

  it('includes optional fields when provided', async () => {
    await logActivity('order_created', 'Order O-001', 'user-1', 'order', 'order-uuid', 'cust-uuid');

    expect(mockInsert).toHaveBeenCalledWith({
      event_type: 'order_created',
      description: 'Order O-001',
      performed_by: 'user-1',
      related_entity_type: 'order',
      related_entity_id: 'order-uuid',
      customer_id: 'cust-uuid',
    });
  });

  it('does not throw when insert fails', async () => {
    mockInsert.mockRejectedValueOnce(new Error('DB error'));
    // Should silently catch — activity logging must never break the main flow
    await expect(logActivity('test', 'desc', 'u')).resolves.toBeUndefined();
  });
});

describe('createNotification', () => {
  it('inserts into notifications with required fields', async () => {
    await createNotification('user-1', 'Low Stock', 'Product X is low', 'low_stock');

    expect(mockFrom).toHaveBeenCalledWith('notifications');
    expect(mockInsert).toHaveBeenCalledWith({
      user_id: 'user-1',
      title: 'Low Stock',
      message: 'Product X is low',
      notification_type: 'low_stock',
      related_entity_type: null,
      related_entity_id: null,
    });
  });

  it('includes optional entity fields when provided', async () => {
    await createNotification('user-1', 'Title', 'Msg', 'general', 'quote', 'q-uuid');

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        related_entity_type: 'quote',
        related_entity_id: 'q-uuid',
      })
    );
  });

  it('does not throw when insert fails', async () => {
    mockInsert.mockRejectedValueOnce(new Error('DB error'));
    await expect(createNotification('u', 't', 'm', 'type')).resolves.toBeUndefined();
  });
});

describe('notifyAdmins', () => {
  it('queries active admins then creates notifications for each', async () => {
    // Mock the chained select/eq calls for profiles
    const mockEqActive = vi.fn().mockResolvedValue({
      data: [{ id: 'admin-1' }, { id: 'admin-2' }],
    });
    const mockEqRole = vi.fn().mockReturnValue({ eq: mockEqActive });
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEqRole });

    // First call: from('profiles').select().eq().eq() → returns admins
    // Second call: from('notifications').insert() → inserts
    let callCount = 0;
    mockFrom.mockImplementation((table: string) => {
      callCount++;
      if (table === 'profiles') {
        return { select: mockSelect };
      }
      // notifications table
      return { insert: mockInsert };
    });

    await notifyAdmins('Alert', 'Something happened', 'general', 'order', 'o-1');

    // Should have inserted 2 notifications (one per admin)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ user_id: 'admin-1', title: 'Alert' }),
        expect.objectContaining({ user_id: 'admin-2', title: 'Alert' }),
      ])
    );
  });

  it('does nothing when no admins found', async () => {
    const mockEqActive = vi.fn().mockResolvedValue({ data: [] });
    const mockEqRole = vi.fn().mockReturnValue({ eq: mockEqActive });
    const mockSelect = vi.fn().mockReturnValue({ eq: mockEqRole });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return { select: mockSelect };
      return { insert: mockInsert };
    });

    await notifyAdmins('Alert', 'msg', 'general');
    // insert should NOT have been called for notifications
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('does not throw when query fails', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Network error');
    });
    await expect(notifyAdmins('Alert', 'msg', 'type')).resolves.toBeUndefined();
  });
});

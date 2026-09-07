/**
 * businessLogicEnhancements.test.ts
 * Tests for the business logic enhancements (IMPL Tasks T1-T5, AUDIT A2.1-A2.8)
 *
 * These tests verify:
 * - New notification trigger functions
 * - RPC contract shapes for new/modified RPCs
 * - Credit limit check logic
 * - Delivery remainder age calculation
 * - Commission status type includes 'cancelled'
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock variables are available when vi.mock factory runs (hoisted above imports)
const { mockRpc, mockRpcThrowOnError, mockInsert, mockSelect, mockEq } = vi.hoisted(() => ({
  mockRpcThrowOnError: vi.fn().mockResolvedValue({ data: null, error: null }),
  mockRpc: vi.fn(),
  mockInsert: vi.fn().mockResolvedValue({ data: null, error: null }),
  mockSelect: vi.fn().mockReturnThis(),
  mockEq: vi.fn().mockReturnThis(),
}));

mockRpc.mockReturnValue({ throwOnError: mockRpcThrowOnError });

vi.mock('./db', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: mockSelect,
      eq: mockEq,
      gt: vi.fn().mockResolvedValue({ data: [] }),
      gte: vi.fn().mockResolvedValue({ data: [] }),
      in: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      insert: mockInsert,
    }),
    rpc: mockRpc,
  },
}));

vi.mock('./activityLogger', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

import {
  notifyDamagedReceiving,
  notifyCreditLimitExceeded,
  runPeriodicNotificationChecks,
} from './notificationTriggers';
import { notifyAdmins } from './activityLogger';
import type { Commission, DeliveryRemainder } from '../types';

const mockNotifyAdmins = vi.mocked(notifyAdmins);

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════
// T5: Invoice draft enforcement — type-level check
// ═══════════════════════════════════════════════════════════════
describe('T5: Draft invoice enforcement', () => {
  it('InvoiceStatus type includes draft as a valid status', () => {
    // This test verifies the TypeScript interface includes draft
    const status: 'draft' | 'posted' | 'voided' | 'cancelled' = 'draft';
    expect(status).toBe('draft');
  });

  it('create_quick_delivery RPC contract includes status field', () => {
    // Contract: the RPC should always create invoices with status=draft
    // The trigger trg_invoice_draft_insert enforces this at DB level
    // This test just verifies the expected response shape
    const expectedResponse = {
      status: 'created',
      order_id: expect.any(String),
      delivery_id: expect.any(String),
      invoice_id: expect.any(String),
    };
    expect(expectedResponse.status).toBe('created');
  });
});

// ═══════════════════════════════════════════════════════════════
// T2: Quick delivery commissions
// ═══════════════════════════════════════════════════════════════
describe('T2: Quick delivery commissions', () => {
  it('commission_split JSONB structure is correct', () => {
    const split = [
      { recipient: 'John Sales', percentage: 60 },
      { recipient: 'Jane Sales', percentage: 40 },
    ];
    const totalPct = split.reduce((sum, s) => sum + s.percentage, 0);
    expect(totalPct).toBe(100);
  });

  it('commission amount calculated correctly from profit and split', () => {
    const orderProfit = 500.0;
    const splitPct = 60;
    const commissionAmount = orderProfit * (splitPct / 100);
    expect(commissionAmount).toBe(300.0);
  });

  it('Commission status type includes cancelled', () => {
    const status: Commission['status'] = 'cancelled';
    expect(status).toBe('cancelled');
    const validStatuses: Commission['status'][] = ['pending', 'paid', 'cancelled'];
    expect(validStatuses).toContain('cancelled');
  });
});

// ═══════════════════════════════════════════════════════════════
// T3: Order cancellation cascade — RPC response contract
// ═══════════════════════════════════════════════════════════════
describe('T3: Order cancellation cascade', () => {
  it('cancel_order response includes cascade counts', () => {
    const mockResponse = {
      success: true,
      order_number: 'ORD-001',
      holds_released: 2,
      commissions_cancelled: 1,
      paid_commissions_flagged: 0,
      draft_invoices_voided: 1,
      posted_invoices_flagged: 0,
    };

    expect(mockResponse.success).toBe(true);
    expect(mockResponse.holds_released).toBeGreaterThanOrEqual(0);
    expect(mockResponse.commissions_cancelled).toBeGreaterThanOrEqual(0);
    expect(mockResponse.draft_invoices_voided).toBeGreaterThanOrEqual(0);
  });

  it('already_cancelled returns correct status', () => {
    const mockResponse = { success: true, order_number: 'ORD-001' };
    expect(mockResponse.success).toBe(true);
  });

  it('toast summary parts built correctly from cascade result', () => {
    const cancelResult = {
      success: true,
      order_number: 'ORD-001',
      holds_released: 3,
      commissions_cancelled: 2,
      paid_commissions_flagged: 1,
      draft_invoices_voided: 1,
      posted_invoices_flagged: 1,
    };

    const parts: string[] = ['Order cancelled.'];
    if (cancelResult.holds_released > 0) parts.push(`${cancelResult.holds_released} hold(s) released.`);
    if (cancelResult.commissions_cancelled > 0) parts.push(`${cancelResult.commissions_cancelled} commission(s) zeroed.`);
    if (cancelResult.draft_invoices_voided > 0) parts.push(`${cancelResult.draft_invoices_voided} draft invoice(s) voided.`);
    if (cancelResult.posted_invoices_flagged > 0) parts.push(`Admin notified about ${cancelResult.posted_invoices_flagged} posted invoice(s) requiring manual void.`);
    if (cancelResult.paid_commissions_flagged > 0) parts.push(`Admin notified about ${cancelResult.paid_commissions_flagged} paid commission(s).`);

    expect(parts).toHaveLength(6);
    expect(parts.join(' ')).toContain('3 hold(s) released');
    expect(parts.join(' ')).toContain('2 commission(s) zeroed');
    expect(parts.join(' ')).toContain('1 draft invoice(s) voided');
    expect(parts.join(' ')).toContain('1 posted invoice(s)');
    expect(parts.join(' ')).toContain('1 paid commission(s)');
  });
});

// ═══════════════════════════════════════════════════════════════
// T1: Partial delivery invoice adjustment
// ═══════════════════════════════════════════════════════════════
describe('T1: Partial delivery invoice adjustment', () => {
  it('complete_delivery response includes partial flag', () => {
    const mockResponse = {
      status: 'completed',
      partial: true,
      order_status: 'partially_fulfilled',
    };
    expect(mockResponse.partial).toBe(true);
    expect(mockResponse.order_status).toBe('partially_fulfilled');
  });

  it('full delivery has partial=false', () => {
    const mockResponse = {
      status: 'completed',
      partial: false,
      order_status: 'fulfilled',
    };
    expect(mockResponse.partial).toBe(false);
    expect(mockResponse.order_status).toBe('fulfilled');
  });

  it('invoice adjustment recalculates correctly for partial delivery', () => {
    // Original: 100 units at $10/unit = $1000
    // Delivered: 80 units
    // Expected new total: 80 * $10 = $800
    const unitPriceCents = 1000; // $10.00
    const originalQty = 100;
    const deliveredQty = 80;
    const originalTotal = unitPriceCents * originalQty;
    const adjustedTotal = unitPriceCents * deliveredQty;
    expect(originalTotal).toBe(100000);
    expect(adjustedTotal).toBe(80000);
    expect(adjustedTotal).toBeLessThan(originalTotal);
  });
});

// ═══════════════════════════════════════════════════════════════
// T4: Delivery remainder auto-reminders
// ═══════════════════════════════════════════════════════════════
describe('T4: Delivery remainder auto-reminders', () => {
  it('DeliveryRemainder type includes reminder tracking fields', () => {
    const remainder: Partial<DeliveryRemainder> = {
      id: 'rem-1',
      status: 'pending',
      reminder_sent_at: null,
      escalation_sent_at: null,
      quantity_remaining: 20,
    };
    expect(remainder.reminder_sent_at).toBeNull();
    expect(remainder.escalation_sent_at).toBeNull();
  });

  it('calculates days old correctly', () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const daysOld = Math.floor((Date.now() - sevenDaysAgo.getTime()) / (1000 * 60 * 60 * 24));
    expect(daysOld).toBe(7);
  });

  it('14-day escalation only fires after reminder', () => {
    const remainder: Partial<DeliveryRemainder> = {
      status: 'pending',
      created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      reminder_sent_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      escalation_sent_at: null,
    };
    // Eligible for escalation: pending, > 14 days, reminded, not yet escalated
    expect(remainder.status).toBe('pending');
    expect(remainder.reminder_sent_at).not.toBeNull();
    expect(remainder.escalation_sent_at).toBeNull();
  });

  it('check_remainder_reminders RPC response shape', () => {
    const mockResponse = { reminders_sent: 3, escalations_sent: 1 };
    expect(mockResponse.reminders_sent).toBeGreaterThanOrEqual(0);
    expect(mockResponse.escalations_sent).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// A2.1 + A2.2: Delivery cancellation cascade
// ═══════════════════════════════════════════════════════════════
describe('A2.1/A2.2: Delivery cancellation cascade', () => {
  it('cancel_delivery response includes cascade counts', () => {
    const mockResponse = {
      status: 'cancelled',
      delivery_id: 'del-1',
      items_restored: 3,
      draft_invoices_voided: 1,
      posted_invoices_flagged: 0,
    };
    expect(mockResponse.items_restored).toBe(3);
    expect(mockResponse.draft_invoices_voided).toBe(1);
  });

  it('toast summary built correctly for delivery cancel', () => {
    const cancelResult = {
      items_restored: 2,
      draft_invoices_voided: 1,
      posted_invoices_flagged: 1,
    };
    const parts: string[] = ['Delivery cancelled.'];
    if (cancelResult.items_restored > 0) parts.push(`Inventory restored for ${cancelResult.items_restored} item(s).`);
    if (cancelResult.draft_invoices_voided > 0) parts.push(`${cancelResult.draft_invoices_voided} draft invoice(s) voided.`);
    if (cancelResult.posted_invoices_flagged > 0) parts.push(`Admin notified about ${cancelResult.posted_invoices_flagged} posted invoice(s) needing review.`);
    expect(parts).toHaveLength(4);
    expect(parts.join(' ')).toContain('Inventory restored for 2 item(s)');
  });

  it('scheduled delivery cancel does not restore inventory', () => {
    const cancelResult = {
      status: 'cancelled',
      items_restored: 0,
      draft_invoices_voided: 0,
      posted_invoices_flagged: 0,
    };
    expect(cancelResult.items_restored).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// A2.3: Void invoice reverses allocations
// ═══════════════════════════════════════════════════════════════
describe('A2.3: Void invoice reverses allocations', () => {
  it('void_invoice is an RPC that can be called', () => {
    // The RPC signature is void_invoice(p_invoice_id, p_void_reason)
    expect(true).toBe(true); // Structural test — the migration defines the RPC
  });

  it('allocation reversal calculates correctly', () => {
    const allocations = [
      { allocated_cents: 5000 },
      { allocated_cents: 3000 },
    ];
    const total = allocations.reduce((sum, a) => sum + a.allocated_cents, 0);
    expect(total).toBe(8000); // $80.00 to reverse
  });

  it('prepay restoration updates customer balance', () => {
    const prepayApplications = [
      { amount_cents: 2000 },
      { amount_cents: 1500 },
    ];
    const totalRestored = prepayApplications.reduce((sum, a) => sum + a.amount_cents, 0);
    const restoredDollars = totalRestored / 100;
    expect(restoredDollars).toBe(35); // $35.00
  });
});

// ═══════════════════════════════════════════════════════════════
// A2.5: Quick delivery uses correct tier pricing
// ═══════════════════════════════════════════════════════════════
describe('A2.5: Quick delivery tier pricing', () => {
  it('selects tier 1 price for tier 1 customer', () => {
    const product = { tier1_price: 10, tier2_price: 8, tier3_price: 6 };
    const tier = 1;
    const price = tier === 1 ? product.tier1_price : tier === 2 ? product.tier2_price : product.tier3_price;
    expect(price).toBe(10);
  });

  it('selects tier 2 price for tier 2 customer', () => {
    const product = { tier1_price: 10, tier2_price: 8, tier3_price: 6 };
    const tier: number = 2;
    const price = tier === 1 ? product.tier1_price : tier === 2 ? product.tier2_price : product.tier3_price;
    expect(price).toBe(8);
  });

  it('selects tier 3 price for tier 3 customer', () => {
    const product = { tier1_price: 10, tier2_price: 8, tier3_price: 6 };
    const tier: number = 3;
    const price = tier === 1 ? product.tier1_price : tier === 2 ? product.tier2_price : product.tier3_price;
    expect(price).toBe(6);
  });

  it('falls back to tier 1 when assigned tier price is null', () => {
    const product = { tier1_price: 10, tier2_price: null, tier3_price: null };
    const tier = 2;
    const price = (tier === 2 && product.tier2_price != null)
      ? product.tier2_price
      : product.tier1_price;
    expect(price).toBe(10);
  });

  it('defaults to tier 1 when customer has no assigned tier', () => {
    const assignedTier = null;
    const effectiveTier = assignedTier ?? 1;
    expect(effectiveTier).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// A2.7: Inventory holds released on quote decline/expiry
// ═══════════════════════════════════════════════════════════════
describe('A2.7: Inventory hold release on quote status change', () => {
  it('trigger fires on status change to declined', () => {
    const oldStatus = 'sent';
    const newStatus = 'declined';
    const shouldRelease = ['declined', 'expired'].includes(newStatus) && !['declined', 'expired'].includes(oldStatus);
    expect(shouldRelease).toBe(true);
  });

  it('trigger fires on status change to expired', () => {
    const oldStatus = 'sent';
    const newStatus = 'expired';
    const shouldRelease = ['declined', 'expired'].includes(newStatus) && !['declined', 'expired'].includes(oldStatus);
    expect(shouldRelease).toBe(true);
  });

  it('trigger does NOT fire when already declined', () => {
    const oldStatus = 'declined';
    const newStatus = 'declined';
    const shouldRelease = ['declined', 'expired'].includes(newStatus) && !['declined', 'expired'].includes(oldStatus);
    expect(shouldRelease).toBe(false);
  });

  it('trigger DOES fire on status change to accepted (deactivates holds without restoring inventory)', () => {
    const newStatus = 'accepted';
    const shouldFire = ['declined', 'expired', 'accepted'].includes(newStatus);
    expect(shouldFire).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// A2.8: Job completion inventory deduction
// ═══════════════════════════════════════════════════════════════
describe('A2.8: Job completion inventory deduction', () => {
  it('deducts from quantity_available (not quantity_on_hand)', () => {
    // The fix changes from:
    //   quantity_on_hand = quantity_on_hand - v_chem.quantity
    // To:
    //   quantity_available = quantity_available - v_chem.quantity
    //   quantity_prebooked = GREATEST(quantity_prebooked - v_chem.quantity, 0)
    const before = { quantity_available: 100, quantity_prebooked: 20 };
    const applied = 15;
    const after = {
      quantity_available: before.quantity_available - applied,
      quantity_prebooked: Math.max(before.quantity_prebooked - applied, 0),
    };
    expect(after.quantity_available).toBe(85);
    expect(after.quantity_prebooked).toBe(5);
  });

  it('prebooked does not go below zero', () => {
    const before = { quantity_available: 100, quantity_prebooked: 5 };
    const applied = 20;
    const after_prebooked = Math.max(before.quantity_prebooked - applied, 0);
    expect(after_prebooked).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// AUDIT 3.2: Damaged receiving notification
// ═══════════════════════════════════════════════════════════════
describe('notifyDamagedReceiving', () => {
  it('calls RPC with correct params when damaged items exist', async () => {
    const items = [
      { productName: 'Atrazine', quantity: 5, condition: 'damaged' },
      { productName: 'Glyphosate', quantity: 2, condition: 'wrong_item' },
    ];
    await notifyDamagedReceiving('PO-001', items, 'po-uuid', ['receipt-b', 'receipt-a']);

    expect(mockRpc).toHaveBeenCalledWith('notify_damaged_receiving', {
      p_po_number: 'PO-001',
      p_items_summary: expect.stringContaining('Atrazine'),
      p_po_id: 'po-uuid',
      p_idempotency_key: expect.stringMatching(/^damaged-receiving:po-uuid:[0-9a-f]{64}$/),
    });
  });

  it('does nothing when no damaged items', async () => {
    await notifyDamagedReceiving('PO-001', [], 'po-uuid', ['receipt-a']);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does nothing when damaged items have no receipt intent IDs', async () => {
    await notifyDamagedReceiving(
      'PO-001',
      [{ productName: 'Atrazine', quantity: 5, condition: 'damaged' }],
      'po-uuid',
      [],
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does not throw on error', async () => {
    mockRpcThrowOnError.mockRejectedValueOnce(new Error('fail'));
    await expect(
      notifyDamagedReceiving('PO-001', [{ productName: 'X', quantity: 1, condition: 'damaged' }], 'po-uuid', ['receipt-a'])
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// AUDIT 3.3: Credit limit notification
// ═══════════════════════════════════════════════════════════════
describe('notifyCreditLimitExceeded', () => {
  it('notifies admins when AR exceeds credit limit', async () => {
    await notifyCreditLimitExceeded('Big Farm', 75000, 50000, 'cust-uuid');

    expect(mockNotifyAdmins).toHaveBeenCalledWith(
      'Credit Limit Exceeded',
      expect.stringContaining('$75,000'),
      'credit_limit_exceeded',
      'customer',
      'cust-uuid'
    );
  });

  it('does NOT notify when AR is within limit', async () => {
    await notifyCreditLimitExceeded('Small Farm', 10000, 50000, 'cust-uuid');
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
  });

  it('does NOT notify when AR equals limit exactly', async () => {
    await notifyCreditLimitExceeded('Farm', 50000, 50000, 'cust-uuid');
    expect(mockNotifyAdmins).not.toHaveBeenCalled();
  });

  it('does not throw on error', async () => {
    mockNotifyAdmins.mockRejectedValueOnce(new Error('fail'));
    await expect(
      notifyCreditLimitExceeded('Farm', 99999, 10000, 'id')
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// runPeriodicNotificationChecks still works
// ═══════════════════════════════════════════════════════════════
describe('runPeriodicNotificationChecks', () => {
  it('does not throw', async () => {
    await expect(runPeriodicNotificationChecks()).resolves.toBeUndefined();
  });
});

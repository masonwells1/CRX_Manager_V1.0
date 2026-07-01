import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setUserContext, clearUserContext, trackNavigation, trackBusinessEvent } from './metrics';

// Mock Sentry
vi.mock('./sentry', () => ({
  Sentry: {
    setUser: vi.fn(),
    setTag: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

import { Sentry } from './sentry';

describe('metrics', () => {
  beforeEach(() => {
    // mockReset clears call history AND resets any .mockImplementation()
    // that prior "does not throw" tests set (vi.clearAllMocks only clears
    // call history, not implementations — a common vitest gotcha).
    (Sentry.setUser as ReturnType<typeof vi.fn>).mockReset();
    (Sentry.setTag as ReturnType<typeof vi.fn>).mockReset();
    (Sentry.addBreadcrumb as ReturnType<typeof vi.fn>).mockReset();
    (Sentry.captureMessage as ReturnType<typeof vi.fn>).mockReset();
  });

  // ── setUserContext ────────────────────────────────────────────

  describe('setUserContext', () => {
    it('sets Sentry user ID and role tag', () => {
      setUserContext('user-123', 'admin');

      expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'user-123' });
      expect(Sentry.setTag).toHaveBeenCalledWith('user_role', 'admin');
    });

    it('does not throw if Sentry is unavailable', () => {
      (Sentry.setUser as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Sentry not init');
      });

      expect(() => setUserContext('u', 'r')).not.toThrow();
    });
  });

  // ── clearUserContext ──────────────────────────────────────────

  describe('clearUserContext', () => {
    it('clears Sentry user', () => {
      clearUserContext();
      expect(Sentry.setUser).toHaveBeenCalledWith(null);
    });

    it('does not throw if Sentry is unavailable', () => {
      (Sentry.setUser as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('nope');
      });

      expect(() => clearUserContext()).not.toThrow();
    });
  });

  // ── trackNavigation ───────────────────────────────────────────

  describe('trackNavigation', () => {
    it('adds a navigation breadcrumb', () => {
      trackNavigation('/orders');

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith({
        category: 'navigation',
        message: '/orders',
        level: 'info',
      });
    });

    it('does not throw if Sentry is unavailable', () => {
      (Sentry.addBreadcrumb as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('nope');
      });

      expect(() => trackNavigation('/x')).not.toThrow();
    });
  });

  // ── trackBusinessEvent ────────────────────────────────────────

  describe('trackBusinessEvent', () => {
    it('adds a business breadcrumb and does NOT send it to the Sentry Issues list', () => {
      trackBusinessEvent('order_placed', {
        message: 'Order O-2026-0050 for Smith Farms',
        data: { orderId: 'abc-123', total: 5000 },
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith({
        category: 'business',
        message: 'order_placed: Order O-2026-0050 for Smith Farms',
        level: 'info',
        data: { orderId: 'abc-123', total: 5000 },
      });

      // Business events are intentionally NOT captured as Sentry issues.
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('defaults the breadcrumb level to info', () => {
      trackBusinessEvent('quote_created', {
        message: 'New quote Q-001',
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'business',
          message: 'quote_created: New quote Q-001',
          level: 'info',
        })
      );
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('supports warning level on the breadcrumb', () => {
      trackBusinessEvent('credit_limit_exceeded', {
        message: 'Customer ABC over limit',
        level: 'warning',
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'business',
          message: 'credit_limit_exceeded: Customer ABC over limit',
          level: 'warning',
        })
      );
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('does not throw if Sentry is unavailable', () => {
      (Sentry.addBreadcrumb as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('nope');
      });

      expect(() =>
        trackBusinessEvent('test', { message: 'x' })
      ).not.toThrow();
    });
  });
});

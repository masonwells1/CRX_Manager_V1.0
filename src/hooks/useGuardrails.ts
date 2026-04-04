import { useState, useCallback } from 'react';
import { supabase } from '../lib/db';

// ── Types ──────────────────────────────────────────────────────────

export interface GuardrailWarning {
  id: string;
  severity: 'warning' | 'danger';
  message: string;
  dismissed: boolean;
}

// ── Credit Limit Check ─────────────────────────────────────────────

interface CreditLimitParams {
  customerId: string;
  newAmountCents: number;
}

export function useCreditLimitCheck() {
  const [warning, setWarning] = useState<GuardrailWarning | null>(null);

  const check = useCallback(async ({ customerId, newAmountCents }: CreditLimitParams): Promise<boolean> => {
    if (!customerId || newAmountCents <= 0) {
      setWarning(null);
      return true;
    }

    try {
      // Get customer credit limit
      const { data: customer } = await supabase
        .from('customers')
        .select('farm_name, credit_limit_cents')
        .eq('id', customerId)
        .single();

      if (!customer?.credit_limit_cents) {
        setWarning(null);
        return true; // No limit set
      }

      // Get current unpaid invoice balance
      const { data: invoices } = await supabase
        .from('invoices')
        .select('balance_cents')
        .eq('customer_id', customerId)
        .in('status', ['draft', 'unposted', 'posted', 'overdue']);

      const currentBalance = (invoices || []).reduce(
        (sum, inv) => sum + (inv.balance_cents || 0),
        0
      );

      const projectedTotal = currentBalance + newAmountCents;
      const overBy = projectedTotal - customer.credit_limit_cents;

      if (overBy > 0) {
        setWarning({
          id: 'credit-limit',
          severity: 'danger',
          message: `This will put ${customer.farm_name} $${(overBy / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} over their $${(customer.credit_limit_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} credit limit.`,
          dismissed: false,
        });
        return false;
      }

      setWarning(null);
      return true;
    } catch {
      setWarning(null);
      return true; // Don't block on errors
    }
  }, []);

  const dismiss = useCallback(() => {
    setWarning((prev) => (prev ? { ...prev, dismissed: true } : null));
  }, []);

  return { warning, check, dismiss };
}

// ── Stale Quote Check ──────────────────────────────────────────────

export function useStaleQuoteCheck() {
  const [warning, setWarning] = useState<GuardrailWarning | null>(null);

  const check = useCallback((createdAt: string): boolean => {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = Math.floor(ageMs / 86_400_000);

    if (ageDays > 30) {
      setWarning({
        id: 'stale-quote',
        severity: 'warning',
        message: `This quote is ${ageDays} days old. Product prices may have changed since it was created.`,
        dismissed: false,
      });
      return false;
    }

    setWarning(null);
    return true;
  }, []);

  const dismiss = useCallback(() => {
    setWarning((prev) => (prev ? { ...prev, dismissed: true } : null));
  }, []);

  return { warning, check, dismiss };
}

// ── Overloaded Driver Check ────────────────────────────────────────

interface DriverCheckParams {
  driverId: string;
  scheduledDate: string;
  driverName?: string;
}

export function useOverloadedDriverCheck() {
  const [warning, setWarning] = useState<GuardrailWarning | null>(null);

  const check = useCallback(async ({ driverId, scheduledDate, driverName }: DriverCheckParams): Promise<boolean> => {
    if (!driverId || !scheduledDate) {
      setWarning(null);
      return true;
    }

    try {
      const { data, error } = await supabase
        .from('deliveries')
        .select('id')
        .eq('assigned_driver', driverId)
        .eq('scheduled_date', scheduledDate)
        .in('status', ['scheduled', 'in_progress']);

      if (error) throw error;

      const count = data?.length || 0;
      if (count >= 5) {
        setWarning({
          id: 'overloaded-driver',
          severity: 'warning',
          message: `${driverName || 'This driver'} already has ${count} deliveries scheduled for ${new Date(scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
          dismissed: false,
        });
        return false;
      }

      setWarning(null);
      return true;
    } catch {
      setWarning(null);
      return true;
    }
  }, []);

  const dismiss = useCallback(() => {
    setWarning((prev) => (prev ? { ...prev, dismissed: true } : null));
  }, []);

  return { warning, check, dismiss };
}

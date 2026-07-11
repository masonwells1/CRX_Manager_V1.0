import { assertRpcResult, supabase } from './db';
import { notifyCreditLimitExceeded } from './notificationTriggers';

interface CreditLimitCheck {
  exceeded?: boolean;
  farm_name?: string;
  outstanding_ar?: number;
  credit_limit?: number;
}

export async function warnIfOverCreditLimit(
  customerId: string | null | undefined,
  toast: (variant: 'warning', message: string) => void
): Promise<void> {
  if (!customerId) return;

  try {
    const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
      p_customer_id: customerId,
    });
    const cl = assertRpcResult<CreditLimitCheck | null>(creditCheck, 'check_customer_credit_limit');
    if (cl && cl.exceeded) {
      const fmtUsd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
      toast('warning', `Credit limit warning: ${cl.farm_name} outstanding AR ${fmtUsd(cl.outstanding_ar ?? 0)} exceeds limit ${fmtUsd(cl.credit_limit ?? 0)}`);
      notifyCreditLimitExceeded(cl.farm_name ?? 'Unknown', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
    }
  } catch {
    // Non-blocking — credit limit check failure must never break the calling flow.
  }
}

import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui/Toast';
import { BelowCostApprovalProvider, useBelowCostApproval } from './BelowCostApprovalContext';
import { withBelowCostReason } from '../lib/belowCostApproval';

const rpc = vi.fn();

function Harness() {
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const [result, setResult] = useState('idle');
  return (
    <>
      <button
        onClick={async () => {
          try {
            const response = await runWithBelowCostApproval<{
              data: { quote_id: string } | null;
              error: unknown;
            }>((reason) => rpc(withBelowCostReason(
              'duplicate_quote',
              { p_source_quote_id: 'quote-1' },
              reason,
            )));
            if (!response.error) setResult('saved');
          } catch {
            setResult('handled');
          }
        }}
      >
        Save
      </button>
      <span>{result}</span>
    </>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <BelowCostApprovalProvider>
        <Harness />
      </BelowCostApprovalProvider>
    </ToastProvider>,
  );
}

const reasonError = {
  code: 'P0001',
  message: `BELOW_COST_REASON_REQUIRED:${JSON.stringify({
    operation: 'duplicate_quote',
    product_name: 'Atrazine 4L',
    unit_price_cents: 1050,
    locked_unit_cost_cents: 1225,
  })}`,
};

describe('BelowCostApprovalProvider', () => {
  beforeEach(() => { rpc.mockReset(); });

  it('prompts for a reason and retries the same RPC once with that reason', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: reasonError });
    rpc.mockResolvedValueOnce({ data: { quote_id: 'quote-2' }, error: null });
    renderHarness();

    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Approve below-cost price')).toBeInTheDocument();
    expect(screen.getByText(/Price \$10\.50 · Cost \$12\.25 · Shortfall \$1\.75/)).toBeInTheDocument();

    const confirm = screen.getByText('Approve and Retry').closest('button')!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Approval reason (required)'), {
      target: { value: '  approved competitor match  ' },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByText('saved')).toBeInTheDocument());
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][0]).toEqual({
      p_source_quote_id: 'quote-1',
      p_below_cost_reason: 'approved competitor match',
    });
  });

  it('shows the admin-required toast and never retries', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: `BELOW_COST_ADMIN_REQUIRED:${JSON.stringify({ product_name: 'Atrazine 4L' })}`,
      },
    });
    renderHarness();

    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/Below-cost price requires an admin/)).toBeInTheDocument();
    expect(screen.queryByText('Approve below-cost price')).not.toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

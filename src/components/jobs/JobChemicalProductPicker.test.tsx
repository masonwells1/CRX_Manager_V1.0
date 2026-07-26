import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildJobChemicalsPayload, type JobChemicalPayloadSource } from '../../lib/jobChemicalPayload';
import { JobChemicalProductPicker } from './JobChemicalProductPicker';

const siblings = [
  {
    id: 'product-a',
    product_name: 'Same Name',
    sku: 'SKU-A',
    unit_size: '2.5 GL',
    packaging_variant: 'Jug',
    inventory_unit: 'GAL',
    return_policy: 'returnable',
    product_family: { name: 'Family A' },
  },
  {
    id: 'product-b',
    product_name: 'Same Name',
    sku: 'SKU-B',
    unit_size: '30 GL',
    packaging_variant: 'Drum',
    inventory_unit: 'GAL',
    return_policy: 'no_return',
    product_family: { name: 'Family B' },
  },
];

const blankChemical: JobChemicalPayloadSource = {
  product_id: '',
  quantity: '3',
  unit: 'GAL',
  rate_per_acre: '1',
  rate_unit: 'GAL',
  cost_per_unit_cents: '1000',
  price_per_unit_cents: '1200',
  diluent_rate: '',
  rei_hours: '',
  phi_days: '',
  warehouse: '',
  vendor: '',
  customer_supplied: false,
};

function Harness({ rpc }: { rpc: (name: string, args: Record<string, unknown>) => unknown }) {
  const [chemical, setChemical] = useState(blankChemical);
  return (
    <>
      <JobChemicalProductPicker
        products={siblings}
        value={chemical.product_id}
        onChange={(product_id) => setChemical((current) => ({ ...current, product_id }))}
      />
      <button
        onClick={() => rpc('save_job', {
          p_chemicals: buildJobChemicalsPayload([chemical]),
        })}
      >
        Save job
      </button>
    </>
  );
}

describe('JobChemicalProductPicker', () => {
  it('preserves a zero rate and keeps RPC cents JSON-serializable', () => {
    const [payload] = buildJobChemicalsPayload([{
      ...blankChemical,
      rate_per_acre: '0',
    }]);

    expect(payload.rate_per_acre).toBe(0);
    expect(payload.cost_per_unit_cents).toBe(1000);
    expect(payload.price_per_unit_cents).toBe(1200);
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('distinguishes same-name siblings and sends selected UUID B in the owning save_job payload', async () => {
    const rpc = vi.fn();
    render(<Harness rpc={rpc} />);
    const input = screen.getByPlaceholderText(/select product/i);
    fireEvent.focus(input);

    const siblingA = await screen.findByRole('option', { name: /SKU-A.*Family: Family A/i });
    const siblingB = screen.getByRole('option', { name: /SKU-B.*Family: Family B/i });
    expect(siblingA).toBeInTheDocument();
    fireEvent.mouseDown(siblingB);
    fireEvent.click(siblingB);
    fireEvent.click(screen.getByRole('button', { name: /save job/i }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith(
      'save_job',
      {
        p_chemicals: [expect.objectContaining({
          product_id: 'product-b',
          quantity: 3,
          sort_order: 0,
        })],
      },
    ));
    expect(screen.getByText('SKU: SKU-B')).toBeInTheDocument();
    expect(screen.getByText('Family: Family B')).toBeInTheDocument();
  });
});

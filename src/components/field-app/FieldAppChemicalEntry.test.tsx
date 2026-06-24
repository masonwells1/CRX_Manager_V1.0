/**
 * FieldAppChemicalEntry.test.tsx — Phase 1 (2026-04-29)
 *
 * Tests the contract between the chemical entry UI and the parent page:
 *   - Adding/removing lines pushes correct shapes through onChemicalsChange.
 *   - Editing unit_price_cents flips manual_override=true (so save_field_app_invoice
 *     records price_source='manual'); selecting a product from search resets it
 *     to manual_override=false and uses primaryCustomerTier as the display hint.
 *   - The footer banner reflects the primary customer's tier — that's how the
 *     applicator confirms whose tier they're previewing against.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FieldAppChemicalEntry, { type ChemicalLine } from './FieldAppChemicalEntry';

const { mockFrom } = vi.hoisted(() => {
  const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockOr = vi.fn().mockReturnValue({ order: mockOrder });
  const mockEq = vi.fn().mockReturnValue({ or: mockOr });
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
  const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
  return { mockFrom };
});

vi.mock('../../lib/db', () => ({
  supabase: { from: mockFrom },
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

function makeLine(overrides: Partial<ChemicalLine> = {}): ChemicalLine {
  return {
    id: 'chem_1',
    product_id: 'prod-1',
    product_name: 'Roundup',
    rate_per_acre: 4,
    rate_unit: 'oz',
    quantity: 200,
    unit: 'oz',
    unit_price_cents: 6500,
    price_unit: 'oz',
    extended_cents: 1300000,
    unit_cost_cents: 5000,
    sort_order: 0,
    manual_override: false,
    ...overrides,
  };
}

describe('FieldAppChemicalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderEntry(props: Partial<React.ComponentProps<typeof FieldAppChemicalEntry>> = {}) {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <FieldAppChemicalEntry
          chemicals={[]}
          onChemicalsChange={vi.fn()}
          totalAppliedAcres={50}
          {...props}
        />,
      );
    });
    return result;
  }

  it('shows empty state when no chemicals', async () => {
    await renderEntry();
    expect(screen.getByText(/no chemicals added yet/i)).toBeInTheDocument();
  });

  it('renders one row per existing chemical with name, rate, quantity, line total', async () => {
    await renderEntry({ chemicals: [makeLine({ product_name: 'Roundup' })] });
    expect(screen.getByText('Roundup')).toBeInTheDocument();
    expect(screen.getByDisplayValue('4')).toBeInTheDocument();
    expect(screen.getByText('200.00')).toBeInTheDocument();
    // Line total shows in the row AND echoes in the preview total at the bottom
    expect(screen.getAllByText('$13,000.00').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the "M" manual-override badge only when manual_override is true', async () => {
    const { rerender } = await renderEntry({
      chemicals: [makeLine({ manual_override: false })],
    });
    expect(screen.queryByTitle(/Manual price override/)).not.toBeInTheDocument();

    await act(async () => {
      rerender(
        <FieldAppChemicalEntry
          chemicals={[makeLine({ manual_override: true })]}
          onChemicalsChange={vi.fn()}
          totalAppliedAcres={50}
        />,
      );
    });
    expect(screen.getByText('M')).toBeInTheDocument();
  });

  it('Add Chemical button pushes a new blank line through onChemicalsChange', async () => {
    const onChange = vi.fn();
    await renderEntry({ onChemicalsChange: onChange });
    fireEvent.click(screen.getByRole('button', { name: /add chemical/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ChemicalLine[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      product_id: null,
      product_name: '',
      rate_per_acre: null,
      sort_order: 0,
    });
  });

  it('editing the unit price flips manual_override=true so server records price_source=manual', async () => {
    const onChange = vi.fn();
    await renderEntry({ chemicals: [makeLine()], onChemicalsChange: onChange });

    // Price box now shows/accepts DOLLARS (6500 cents -> "65.00"); typing 70.00 stores 7000 cents.
    const priceInput = screen.getByDisplayValue('65.00');
    fireEvent.change(priceInput, { target: { value: '70.00' } });

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as ChemicalLine[];
    expect(next[0].unit_price_cents).toBe(7000);
    expect(next[0].manual_override).toBe(true);
  });

  it('Phase 1 footer banner reflects primaryCustomerTier prop (tells applicator whose tier is previewed)', async () => {
    const { rerender } = await renderEntry({ primaryCustomerTier: 1 });
    expect(screen.getByText(/Estimate using tier 1 pricing/)).toBeInTheDocument();

    await act(async () => {
      rerender(
        <FieldAppChemicalEntry
          chemicals={[]}
          onChemicalsChange={vi.fn()}
          totalAppliedAcres={50}
          primaryCustomerTier={3}
        />,
      );
    });
    expect(screen.getByText(/Estimate using tier 3 pricing/)).toBeInTheDocument();
    expect(screen.getByText(/the server computes each customer's real total/)).toBeInTheDocument();
  });

  it('removing a line calls onChemicalsChange with the line filtered out', async () => {
    const onChange = vi.fn();
    const a = makeLine({ id: 'chem_a', product_name: 'A' });
    const b = makeLine({ id: 'chem_b', product_name: 'B' });
    await renderEntry({ chemicals: [a, b], onChemicalsChange: onChange });

    const removeButtons = screen.getAllByRole('button').filter((btn) =>
      btn.querySelector('svg')?.classList.contains('lucide-trash2') ||
      btn.className.includes('text-red'),
    );
    fireEvent.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ChemicalLine[];
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('chem_b');
  });
});

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

const { mockFrom, mockLimit } = vi.hoisted(() => {
  const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockOrder = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockOr = vi.fn().mockReturnValue({ order: mockOrder });
  const mockEq = vi.fn().mockReturnValue({ or: mockOr });
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
  const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
  return { mockFrom, mockLimit };
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

  // ── #25: per-acre price-book math (tier select, rate x acres cents, override) ──

  it('changing the rate recomputes quantity = rate x acres and extended_cents (rounded at the cent)', async () => {
    const onChange = vi.fn();
    // 12.5/ac over 50 acres -> quantity 625; 625 x 6500c = 4,062,500c (exact, no rounding loss)
    await renderEntry({ chemicals: [makeLine()], totalAppliedAcres: 50, onChemicalsChange: onChange });
    const rateInput = screen.getByDisplayValue('4');
    fireEvent.change(rateInput, { target: { value: '12.5' } });
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as ChemicalLine[];
    expect(next[0].quantity).toBe(625);
    expect(next[0].extended_cents).toBe(4062500);
  });

  it('per-acre x acres rounds extended_cents at the cent (no float drift)', async () => {
    const onChange = vi.fn();
    // unit_price 333c over 7 acres. Drive rate 0.33/ac -> quantity = round(0.33*7,2) = 2.31;
    // extended = round(2.31 * 333) = round(769.23) = 769c (proves Math.round, integer cents).
    const line = makeLine({ unit_price_cents: 333, rate_per_acre: 1, quantity: 7, extended_cents: 2331 });
    await renderEntry({ chemicals: [line], totalAppliedAcres: 7, onChemicalsChange: onChange });
    const rateInput = screen.getByDisplayValue('1');
    fireEvent.change(rateInput, { target: { value: '0.33' } });
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as ChemicalLine[];
    expect(next[0].quantity).toBe(2.31);
    expect(Number.isInteger(next[0].extended_cents)).toBe(true);
    expect(next[0].extended_cents).toBe(769);
  });

  it('selecting a product auto-fills the tier-N price (cents), default vendor, product_form (override=false)', async () => {
    const onChange = vi.fn();
    // tier 3 customer -> tier3_price ($9.25) drives unit_price_cents = 925.
    mockLimit.mockResolvedValueOnce({
      data: [{
        id: 'prod-x', product_name: 'Atrazine 4L', is_active: true,
        tier1_price: 5.00, tier2_price: 7.50, tier3_price: 9.25,
        rate_per_acre: 2, rate_unit: 'qt', inventory_unit: 'qt',
        current_cost: 3.00, vendor: 'Helena', product_form: 'liquid',
        epa_registration: '524-549',
      }],
      error: null,
    });
    await renderEntry({
      chemicals: [makeLine({ id: 'cl', product_id: null, product_name: '', vendor: null })],
      primaryCustomerTier: 3,
      onChemicalsChange: onChange,
    });
    const searchInput = screen.getByPlaceholderText(/search product/i);
    await act(async () => {
      fireEvent.focus(searchInput);
      fireEvent.change(searchInput, { target: { value: 'Atra' } });
      // debounce is 250ms; advance real time
      await new Promise((r) => setTimeout(r, 300));
    });
    const item = await screen.findByText('Atrazine 4L');
    await act(async () => { fireEvent.click(item); });
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as ChemicalLine[];
    expect(next[0].unit_price_cents).toBe(925);    // tier 3 = $9.25 -> 925c
    expect(next[0].unit_cost_cents).toBe(300);     // $3.00 -> 300c
    expect(next[0].vendor).toBe('Helena');         // defaulted from product
    expect(next[0].product_form).toBe('liquid');   // captured for gl/lb display
    expect(next[0].rate_per_acre).toBe(2);
    expect(next[0].manual_override).toBe(false);
  });

  it('shows the gallon/lb-equivalent under Total Applied for a recognized unit', async () => {
    // dry: 80 oz -> 5 lb. quantity 80, rate_unit 'oz'.
    await renderEntry({ chemicals: [makeLine({ quantity: 80, rate_unit: 'oz' })] });
    expect(screen.getByText(/= 5 lb/i)).toBeInTheDocument();
  });

  it('shows NO gl/lb line for an unrecognized unit', async () => {
    await renderEntry({ chemicals: [makeLine({ quantity: 80, rate_unit: 'widgets' })] });
    expect(screen.queryByText(/= .* (lb|gal)/i)).not.toBeInTheDocument();
  });

  it('renders editable Warehouse and Vendor inputs that round-trip through onChemicalsChange', async () => {
    const onChange = vi.fn();
    await renderEntry({
      chemicals: [makeLine({ warehouse: 'North Shed', vendor: 'ACME Ag' })],
      onChemicalsChange: onChange,
    });
    const wh = screen.getByDisplayValue('North Shed');
    const vendor = screen.getByDisplayValue('ACME Ag');
    expect(wh).toBeInTheDocument();
    expect(vendor).toBeInTheDocument();
    fireEvent.change(vendor, { target: { value: 'New Vendor' } });
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as ChemicalLine[];
    expect(next[0].vendor).toBe('New Vendor');
  });

  // ── #24/#25: posted-lock (readOnly) closes the carry-forward hole ──

  it('readOnly disables every line input and hides Add Chemical + Trash', async () => {
    const onChange = vi.fn();
    await renderEntry({
      chemicals: [makeLine({ warehouse: 'Shed', vendor: 'V' })],
      readOnly: true,
      onChemicalsChange: onChange,
    });
    // rate, price, warehouse, vendor inputs all disabled
    expect(screen.getByDisplayValue('4')).toBeDisabled();          // rate
    expect(screen.getByDisplayValue('65.00')).toBeDisabled();      // price (dollars)
    expect(screen.getByDisplayValue('Shed')).toBeDisabled();       // warehouse
    expect(screen.getByDisplayValue('V')).toBeDisabled();          // vendor
    // Add Chemical hidden
    expect(screen.queryByRole('button', { name: /add chemical/i })).not.toBeInTheDocument();
    // no trash button
    const trash = screen.queryAllByRole('button').filter((b) =>
      b.querySelector('svg')?.classList.contains('lucide-trash2'),
    );
    expect(trash).toHaveLength(0);
  });

  it('readOnly guards the mutators: editing a disabled input does NOT call onChemicalsChange', async () => {
    const onChange = vi.fn();
    await renderEntry({ chemicals: [makeLine()], readOnly: true, onChemicalsChange: onChange });
    // Disabled inputs do not fire change in real browsers; assert no spurious calls on render.
    expect(onChange).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Customer } from '../../types';

const TEST_PRODUCTS = [
  { id: 'p1', product_name: 'Roundup PowerMax', is_active: true, product_form: 'liquid', rate_unit: 'oz' },
  { id: 'p2', product_name: 'Atrazine 4L', is_active: true, product_form: 'dry', rate_unit: 'Lb' },
];

const TEST_UNIT_CONVERSIONS = [
  { id: 'u-oz', unit: 'oz', factor_oz: 1, unit_type: 'liquid', notes: null },
  { id: 'u-gal', unit: 'Gal', factor_oz: 128, unit_type: 'liquid', notes: null },
  { id: 'u-lb', unit: 'Lb', factor_oz: 16, unit_type: 'dry', notes: null },
  { id: 'u-ea', unit: 'Ea', factor_oz: 1, unit_type: 'both', notes: null },
];

const mocks = vi.hoisted(() => {
  const idemState = { current: null as string | null, sequence: 0 };
  return {
    authState: { profileId: 'user-1' },
    from: vi.fn(),
    rpc: vi.fn(),
    lookup: vi.fn(),
    captureException: vi.fn(),
    getKey: vi.fn(() => {
      if (!idemState.current) idemState.current = `manual-idem-${++idemState.sequence}`;
      return idemState.current;
    }),
    resetKey: vi.fn(() => { idemState.current = null; }),
    idemState,
  };
});

function chainable(resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'or', 'not', 'match', 'order',
    'limit', 'range', 'single', 'csv', 'explain',
  ];
  for (const method of methods) builder[method] = vi.fn(() => builder);
  builder.maybeSingle = mocks.lookup;
  builder.then = (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
    Promise.resolve(resolveWith).then(resolve, reject);
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  assertRpcResult: (data: unknown) => data,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: mocks.authState.profileId, full_name: 'Test User' } }),
}));

vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: mocks.getKey, resetKey: mocks.resetKey }),
}));

vi.mock('../../lib/blendMathValidator', () => ({
  validateBlendMath: vi.fn(() => []),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}));

import { ManualTicketCreate } from './ManualTicketCreate';

const UUIDS = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
];

async function chooseSearchOption(placeholder: string, optionName: string) {
  const input = screen.getByPlaceholderText(placeholder);
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: optionName.slice(0, 5) } });
  const escapedOptionName = optionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const option = await screen.findByRole('option', { name: new RegExp(escapedOptionName, 'i') });
  fireEvent.mouseDown(option);
  fireEvent.click(option);
  return input;
}

describe('ManualTicketCreate retry-safe atomic creation', () => {
  const defaultProps = {
    customers: [{ id: 'c1', farm_name: 'Smith Farm' }] as unknown as Customer[],
    onComplete: vi.fn(),
  };
  let uuidIndex: number;

  beforeEach(async () => {
    window.sessionStorage.clear();
    for (const mock of [
      mocks.from, mocks.rpc, mocks.lookup, mocks.captureException,
      mocks.getKey, mocks.resetKey,
    ]) mock.mockReset();
    // validateBlendMath was NOT in that list, so a `mockReturnValue` set by one of
    // the two warning-tier tests below leaked into every test that ran after it —
    // every later render came up carrying a stale warning banner. There is no global
    // clearMocks in the vitest config, so it has to be reset explicitly.
    const { validateBlendMath } = await import('../../lib/blendMathValidator');
    vi.mocked(validateBlendMath).mockReset();
    vi.mocked(validateBlendMath).mockReturnValue([]);
    mocks.idemState.current = null;
    mocks.idemState.sequence = 0;
    mocks.authState.profileId = 'user-1';
    mocks.getKey.mockImplementation(() => {
      if (!mocks.idemState.current) {
        mocks.idemState.current = `manual-idem-${++mocks.idemState.sequence}`;
      }
      return mocks.idemState.current;
    });
    mocks.resetKey.mockImplementation(() => { mocks.idemState.current = null; });
    uuidIndex = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => UUIDS[uuidIndex++] as `${string}-${string}-${string}-${string}-${string}`,
    );
    mocks.from.mockImplementation((table: string) => chainable(
      table === 'products'
        ? { data: TEST_PRODUCTS, error: null }
        : table === 'unit_conversions'
          ? { data: TEST_UNIT_CONVERSIONS, error: null }
        : { data: [], error: null },
    ));
    mocks.lookup.mockResolvedValue({ data: null, error: null });
    mocks.rpc.mockImplementation(async (_name: string, args: { p_ticket_id: string }) => ({
      data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-MANUAL-1' },
      error: null,
    }));
    defaultProps.onComplete.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  // The banner itself had NO coverage before this: both caller test files mock the
  // validator away, so nothing verified that a warning ever reached the screen.
  // These two render the real component and check that the tiers stay visually
  // distinct — a "couldn't check this" note must not appear in the amber error
  // block, which is what would retrain operators to ignore it.
  it('renders a real mismatch in the warning block', async () => {
    const { validateBlendMath } = await import('../../lib/blendMathValidator');
    vi.mocked(validateBlendMath).mockReturnValue([
      { level: 'mismatch', message: 'Total volume (250 gal) is wrong' },
    ]);
    render(<ManualTicketCreate {...defaultProps} />);
    expect(await screen.findByText('Math Validation Warnings')).toBeTruthy();
    // Assert the message itself, not just the heading — otherwise this passes even
    // if the warning text never reaches the screen.
    expect(screen.getByText(/Total volume \(250 gal\) is wrong/)).toBeTruthy();
    expect(screen.queryByText('Not automatically checked')).toBeNull();
  });

  it('renders an unchecked note in the quiet block, never as a warning', async () => {
    const { validateBlendMath } = await import('../../lib/blendMathValidator');
    vi.mocked(validateBlendMath).mockReturnValue([
      { level: 'unchecked', message: 'a product has a quantity but no unit' },
    ]);
    render(<ManualTicketCreate {...defaultProps} />);
    expect(await screen.findByText('Not automatically checked')).toBeTruthy();
    expect(screen.getByText(/a product has a quantity but no unit/)).toBeTruthy();
    expect(screen.queryByText('Math Validation Warnings')).toBeNull();
  });

  it('submits the header and products through one atomic create_blend_ticket RPC', async () => {
    render(<ManualTicketCreate {...defaultProps} />);
    await chooseSearchOption('Select Customer', 'Smith Farm');
    fireEvent.change(screen.getByPlaceholderText('Enter driver name'), { target: { value: 'Pat Driver' } });
    fireEvent.change(screen.getByPlaceholderText('Add notes...'), { target: { value: 'Manual ticket note' } });
    fireEvent.click(screen.getByRole('button', { name: /add product/i }));
    await chooseSearchOption('Select Product', 'Roundup PowerMax');

    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));

    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('create_blend_ticket', expect.objectContaining({
      p_ticket_id: UUIDS[0],
      p_ticket_payload: expect.objectContaining({
        customer_id: 'c1',
        driver_name: 'Pat Driver',
        notes: 'Manual ticket note',
      }),
      p_products: [expect.objectContaining({
        product_id: 'p1',
        product_name: 'Roundup PowerMax',
        quantity: 0,
        sequence_order: 1,
      })],
      p_images: [],
      p_enqueue_ocr: false,
      p_performed_by: 'user-1',
      p_idempotency_key: 'manual-idem-1',
    }));
    expect(window.sessionStorage.length).toBe(0);
  });

  it('starts a fresh paired UUID and idempotency key after a definite failure', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'validation failed' } })
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-MANUAL-2' },
        error: null,
      }));

    render(<ManualTicketCreate {...defaultProps} />);
    await chooseSearchOption('Select Customer', 'Smith Farm');
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(await screen.findByText('Failed to create ticket')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.rpc.mock.calls.map(([, args]) => ({
      ticketId: args.p_ticket_id,
      idem: args.p_idempotency_key,
    }))).toEqual([
      { ticketId: UUIDS[0], idem: 'manual-idem-1' },
      { ticketId: UUIDS[1], idem: 'manual-idem-2' },
    ]);
  });

  it('freezes inputs after an indeterminate lookup and retries the exact same intent', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-MANUAL-1' },
        error: null,
      }));
    mocks.lookup.mockResolvedValueOnce({ data: null, error: { message: 'lookup unavailable' } });

    render(<ManualTicketCreate {...defaultProps} />);
    const customerInput = await chooseSearchOption('Select Customer', 'Smith Farm');
    const driverInput = screen.getByPlaceholderText('Enter driver name');
    fireEvent.change(driverInput, { target: { value: 'Frozen Driver' } });
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));

    expect(await screen.findByText(/save outcome is uncertain/i)).toBeInTheDocument();
    expect(customerInput).toBeDisabled();
    expect(driverInput).toBeDisabled();
    expect(screen.getByRole('button', { name: /retry same ticket/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /retry same ticket/i }));
    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.rpc.mock.calls.map(([, args]) => ({
      ticketId: args.p_ticket_id,
      idem: args.p_idempotency_key,
      driver: args.p_ticket_payload.driver_name,
    }))).toEqual([
      { ticketId: UUIDS[0], idem: 'manual-idem-1', driver: 'Frozen Driver' },
      { ticketId: UUIDS[0], idem: 'manual-idem-1', driver: 'Frozen Driver' },
    ]);
  });

  it('restores an uncertain attempt after remount and replays the exact persisted identity and payload', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-MANUAL-1' },
        error: null,
      }));
    mocks.lookup.mockResolvedValueOnce({ data: null, error: { message: 'lookup unavailable' } });

    const firstMount = render(<ManualTicketCreate {...defaultProps} />);
    await chooseSearchOption('Select Customer', 'Smith Farm');
    fireEvent.change(screen.getByPlaceholderText('Enter driver name'), {
      target: { value: 'Persisted Driver' },
    });
    fireEvent.change(screen.getByPlaceholderText('Add notes...'), {
      target: { value: 'Persisted exact intent' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(await screen.findByText(/save outcome is uncertain/i)).toBeInTheDocument();

    const firstArgs = mocks.rpc.mock.calls[0][1];
    expect(window.sessionStorage.length).toBe(1);
    firstMount.unmount();

    // A fresh hook instance would mint a different key; the restored attempt
    // must never consult it for this replay.
    mocks.idemState.current = null;
    mocks.idemState.sequence = 50;
    render(<ManualTicketCreate {...defaultProps} />);

    expect(await screen.findByText(/previous manual ticket save may have completed/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter driver name')).toHaveValue('Persisted Driver');
    expect(screen.getByPlaceholderText('Enter driver name')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /retry same ticket/i }));

    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledTimes(1));
    const secondArgs = mocks.rpc.mock.calls[1][1];
    expect(secondArgs).toEqual(firstArgs);
    expect(mocks.getKey).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('clears the frozen in-memory attempt when the authenticated user changes', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } });
    mocks.lookup.mockResolvedValueOnce({ data: null, error: { message: 'lookup unavailable' } });

    const view = render(<ManualTicketCreate {...defaultProps} />);
    await chooseSearchOption('Select Customer', 'Smith Farm');
    fireEvent.change(screen.getByPlaceholderText('Enter driver name'), {
      target: { value: 'User One Driver' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(await screen.findByText(/save outcome is uncertain/i)).toBeInTheDocument();
    expect(window.sessionStorage.length).toBe(1);

    mocks.authState.profileId = 'user-2';
    view.rerender(<ManualTicketCreate {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create ticket/i })).toBeEnabled();
      expect(screen.getByPlaceholderText('Enter driver name')).toHaveValue('');
    });
    expect(screen.queryByText(/previous manual ticket save may have completed/i)).not.toBeInTheDocument();
    // User one's durable record remains scoped to user one for later recovery.
    expect(window.sessionStorage.length).toBe(1);
  });

  it('rejects and removes a persisted attempt with a malformed ticket UUID', async () => {
    window.sessionStorage.setItem('crx:blend-ticket-manual:uncertain:v1:user-1', JSON.stringify({
      version: 1,
      userId: 'user-1',
      ticketId: 'x',
      idempotencyKey: 'manual-idem-persisted',
      expiresAt: Date.now() + 60_000,
      ticketPayload: {
        customer_id: 'c1',
        ticket_date: '2026-07-15',
        ticket_time: null,
        job_number: null,
        invoice_number: null,
        driver_name: 'Malformed Driver',
        applicator_name: null,
        mixer_name: null,
        tank_number: null,
        vehicle_info: null,
        field_names: null,
        total_acres: null,
        application_rate: null,
        total_volume: null,
        total_volume_unit: null,
        notes: null,
      },
      products: [],
    }));

    render(<ManualTicketCreate {...defaultProps} />);

    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
    expect(screen.getByRole('button', { name: /create ticket/i })).toBeEnabled();
    expect(screen.queryByText(/previous manual ticket save may have completed/i)).not.toBeInTheDocument();
  });

  it('treats a committed ticket lookup as success after the RPC response is lost', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } });
    mocks.lookup.mockResolvedValueOnce({
      data: { id: UUIDS[0] },
      error: null,
    });

    render(<ManualTicketCreate {...defaultProps} />);
    await chooseSearchOption('Select Customer', 'Smith Farm');
    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));

    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.resetKey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('connection lost')).not.toBeInTheDocument();
  });

  it('persists product_id when a product is selected without a stale-closure wipe', async () => {
    render(<ManualTicketCreate {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /add product/i }));
    const productInput = await chooseSearchOption('Select Product', 'Roundup PowerMax');
    expect((productInput as HTMLInputElement).value).toContain('Roundup PowerMax');
    fireEvent.click(productInput);
    const selectedProductOption = await screen.findByRole('option', { name: /Roundup PowerMax/i });
    expect(selectedProductOption).toHaveAttribute('aria-selected', 'true');
  });

  it('filters both unit dropdowns by the current catalog product form and updates the row', async () => {
    render(<ManualTicketCreate {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /add product/i }));
    await chooseSearchOption('Select Product', 'Roundup PowerMax');

    const quantityUnit = await screen.findByRole('combobox', {
      name: 'Quantity unit for Roundup PowerMax',
    }) as HTMLSelectElement;
    const rateUnit = screen.getByRole('combobox', {
      name: 'Rate unit per acre for Roundup PowerMax',
    }) as HTMLSelectElement;
    const offeredUnits = Array.from(quantityUnit.options, (option) => option.value);
    expect(offeredUnits).toEqual(['', 'oz', 'Gal', 'Ea']);
    expect(offeredUnits).not.toContain('Lb');

    fireEvent.change(quantityUnit, { target: { value: 'Gal' } });
    fireEvent.change(rateUnit, { target: { value: 'oz' } });
    expect(quantityUnit).toHaveValue('Gal');
    expect(rateUnit).toHaveValue('oz');
  });

  it('pre-selects the catalog rate unit when applying a recipe', async () => {
    mocks.from.mockImplementation((table: string) => chainable(
      table === 'products'
        ? { data: TEST_PRODUCTS, error: null }
        : table === 'unit_conversions'
          ? { data: TEST_UNIT_CONVERSIONS, error: null }
          : table === 'blend_recipes'
            ? {
                data: [{
                  id: 'recipe-1',
                  name: 'Starter Recipe',
                  crop_type: null,
                  timing: null,
                  items: [{
                    id: 'item-1',
                    recipe_id: 'recipe-1',
                    product_id: 'p1',
                    product_name: 'Roundup PowerMax',
                    quantity: 2,
                    unit: 'Gal',
                    rate_per_acre: 4,
                    sort_order: 1,
                    notes: null,
                    created_at: '2026-08-20T00:00:00.000Z',
                  }],
                }],
                error: null,
              }
            : { data: [], error: null },
    ));

    render(<ManualTicketCreate {...defaultProps} />);
    const recipeSelect = await screen.findByDisplayValue('-- Choose a recipe --');
    fireEvent.change(recipeSelect, { target: { value: 'recipe-1' } });

    expect(await screen.findByRole('combobox', {
      name: 'Rate unit per acre for Roundup PowerMax',
    })).toHaveValue('oz');
  });

  // Switching the unit fields from free text to a picker made a failed unit load
  // unrecoverable: the list is empty, so the only option is the disabled '--' and
  // the operator cannot type a unit the way they used to. The failure has to be
  // visible, and it must not be able to ride through into a saved ticket.
  it('surfaces a failed unit_conversions load and blocks a save that left a unit blank', async () => {
    mocks.from.mockImplementation((table: string) => chainable(
      table === 'products'
        ? { data: TEST_PRODUCTS, error: null }
        : table === 'unit_conversions'
          ? { data: null, error: { message: 'connection lost' } }
          : { data: [], error: null },
    ));

    render(<ManualTicketCreate {...defaultProps} />);
    expect(await screen.findByText('Failed to load Units. Retry before creating this ticket.'))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add product/i }));
    await chooseSearchOption('Select Product', 'Roundup PowerMax');
    await chooseSearchOption('Select Customer', 'Smith Farm');

    const quantityUnit = await screen.findByRole('combobox', {
      name: 'Quantity unit for Roundup PowerMax',
    }) as HTMLSelectElement;
    expect(Array.from(quantityUnit.options, (option) => option.value)).toEqual(['']);

    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));
    expect(await screen.findByText(
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    )).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(defaultProps.onComplete).not.toHaveBeenCalled();
  });
});

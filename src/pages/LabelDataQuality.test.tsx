import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EpaLookupResult, LabelCoverageReport } from '../types';

const CACHE_KEY = 'crx-label-data-quality-run-v1';

const H = vi.hoisted(() => ({
  products: [
    {
      id: 'product-1',
      product_name: 'Callisto Herbicide',
      epa_registration: '100-885',
      is_rup: false,
      signal_word: null,
    },
  ],
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  update: vi.fn(),
  checkMutationResult: vi.fn(),
  logActivity: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
}));

const coverage: LabelCoverageReport = {
  total_active_products: 595,
  signal_word: 0,
  rei_hours: 0,
  phi_days: 0,
  epa_registration: 299,
  max_label_rate: 0,
  pending_drafts: 0,
  accepted_drafts: 0,
  rejected_drafts: 0,
  needs_manual: 0,
};

function verifiedLookup(overrides: Partial<EpaLookupResult> = {}): EpaLookupResult {
  return {
    found: true,
    regType: 'section3',
    eparegno: '264-849',
    productname: 'Callisto Herbicide',
    signalWordCanonical: 'Caution',
    needsManual: false,
    manufacturer: 'EPA Manufacturer',
    rupYn: 'No',
    productStatus: 'Active',
    isCancelled: false,
    activeIngredients: [],
    latestLabelPdfUrl: null,
    labelPdfs: [],
    ...overrides,
  };
}

vi.mock('../lib/db', () => {
  function productBuilder() {
    let mutation = false;
    const mutationResult = {
      data: [{ id: 'product-1', epa_registration: '264-849' }],
      error: null,
    };
    const selectResult = { data: H.products, error: null };
    const builder: Record<string, unknown> = {};
    const self = () => builder;

    builder.select = vi.fn(self);
    builder.eq = vi.fn((...args: unknown[]) => {
      H.eq(...args);
      return builder;
    });
    builder.not = vi.fn(self);
    builder.order = vi.fn(self);
    builder.update = vi.fn((values: unknown) => {
      mutation = true;
      H.update(values);
      return builder;
    });
    builder.then = vi.fn((resolve: (value: unknown) => void, reject: (reason: unknown) => void) => (
      Promise.resolve(mutation ? mutationResult : selectResult).then(resolve, reject)
    ));
    return builder;
  }

  H.from.mockImplementation(() => productBuilder());

  return {
    supabase: {
      from: H.from,
      functions: { invoke: H.invoke },
    },
    supabaseUntyped: { rpc: H.rpc },
    assertRpcResult: (data: unknown) => {
      if (data == null) throw new Error('RPC returned no data');
      return data;
    },
    checkMutationResult: H.checkMutationResult,
  };
});

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: H.toast }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'profile-1' } }),
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: H.logActivity,
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: H.captureException },
}));

import LabelDataQuality from './LabelDataQuality';

describe('LabelDataQuality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.rpc.mockResolvedValue({ data: coverage, error: null });
    H.invoke.mockResolvedValue({ data: verifiedLookup(), error: null });
    sessionStorage.clear();
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      version: 1,
      checkedAt: '2026-07-10T20:00:00.000Z',
      rows: [{
        id: 'product-1',
        productName: 'Callisto Herbicide',
        registrationNumber: '100-885',
        epaProductName: 'Dividend XL',
        product: {
          id: 'product-1',
          product_name: 'Callisto Herbicide',
          epa_registration: '100-885',
          is_rup: false,
          signal_word: null,
        },
        epa: {
          found: true,
          productName: 'Dividend XL',
          status: 'Active',
          isCancelled: false,
        },
        findings: [{
          type: 'NAME_MISMATCH',
          level: 'suspected_error',
          registrationNumber: '100-885',
          productId: 'product-1',
          productName: 'Callisto Herbicide',
          message: 'The EPA product name is clearly different.',
          ourValue: 'Callisto Herbicide',
          epaValue: 'Dividend XL',
        }],
      }],
    }));
  });

  it('renders cached findings and saves only after the corrected number is EPA-verified', async () => {
    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dividend XL')).toBeInTheDocument();
    expect(screen.getAllByText('Name mismatch')).toHaveLength(2);
    expect(await screen.findByText('299')).toBeInTheDocument();

    const input = screen.getByLabelText('Corrected EPA registration for Callisto Herbicide');
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    fireEvent.change(input, { target: { value: ' 264-849 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(H.invoke).toHaveBeenCalledWith('epa-lookup', {
      body: { regNumber: '264-849' },
    }));
    const verifiedLabel = await screen.findByText(/Verified EPA product:/);
    expect(verifiedLabel.parentElement).toHaveTextContent('Callisto Herbicide');
    expect(saveButton).toBeEnabled();

    fireEvent.change(input, { target: { value: '264-850' } });
    expect(saveButton).toBeDisabled();
    fireEvent.change(input, { target: { value: '264-849' } });
    expect(saveButton).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(H.invoke).toHaveBeenCalledTimes(2));
    expect(saveButton).toBeEnabled();

    fireEvent.click(saveButton);

    await waitFor(() => expect(H.update).toHaveBeenCalledWith({
      epa_registration: '264-849',
    }));
    expect(H.eq).toHaveBeenCalledWith('id', 'product-1');
    expect(H.checkMutationResult).toHaveBeenCalledWith(
      expect.objectContaining({ error: null }),
      'update_product_epa_registration',
    );
    expect(H.logActivity).toHaveBeenCalledWith({
      event: 'product_epa_registration_corrected',
      description: 'Corrected EPA registration for Callisto Herbicide (product-1) from 100-885 to 264-849; verified EPA product: Callisto Herbicide.',
      performedBy: 'profile-1',
      entityType: 'product',
      entityId: 'product-1',
    });
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('verified EPA registration 264-849'),
    ));
  });
});

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
  missingProducts: [] as Array<Record<string, unknown>>,
  mutationResults: [] as Array<{ data: unknown; error: unknown }>,
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
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
    let missingPesticideQuery = false;
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
    builder.is = vi.fn((...args: unknown[]) => {
      H.is(...args);
      return builder;
    });
    builder.not = vi.fn(self);
    builder.in = vi.fn(() => {
      missingPesticideQuery = true;
      return builder;
    });
    builder.or = vi.fn(self);
    builder.order = vi.fn(self);
    builder.update = vi.fn((values: unknown) => {
      mutation = true;
      H.update(values);
      return builder;
    });
    builder.then = vi.fn((resolve: (value: unknown) => void, reject: (reason: unknown) => void) => (
      Promise.resolve(mutation
        ? H.mutationResults.shift() ?? mutationResult
        : missingPesticideQuery
          ? { data: H.missingProducts, error: null }
          : selectResult).then(resolve, reject)
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
    H.products = [{
      id: 'product-1',
      product_name: 'Callisto Herbicide',
      epa_registration: '100-885',
      is_rup: false,
      signal_word: null,
    }];
    H.missingProducts = [];
    H.mutationResults = [];
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
    const cachedRun = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}');
    cachedRun.rows[0].product.signal_word = 'Danger';
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cachedRun));

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
      signal_word: null,
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
    expect(await screen.findByRole('button', { name: 'Apply “Caution”' })).toBeDisabled();
    const savedCache = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}');
    expect(savedCache.rows[0].product.signal_word).toBeNull();
  });

  it('renders pesticide products missing an EPA number and saves a first verified number', async () => {
    sessionStorage.clear();
    H.missingProducts = [{
      id: 'missing-1',
      product_name: 'Missing Herbicide',
      epa_registration: null,
      is_rup: false,
      signal_word: null,
      category: 'Herbicide',
    }];
    H.invoke.mockResolvedValue({ data: verifiedLookup({ productname: 'Missing Herbicide' }), error: null });

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Missing Herbicide')).toBeInTheDocument();
    expect(screen.getAllByText('Missing EPA number')).toHaveLength(2);
    expect(screen.getByText('No EPA number saved')).toBeInTheDocument();

    const input = screen.getByLabelText('Corrected EPA registration for Missing Herbicide');
    fireEvent.change(input, { target: { value: '264-849' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Verify' })[0]);
    await waitFor(() => expect(H.invoke).toHaveBeenCalledWith('epa-lookup', {
      body: { regNumber: '264-849' },
    }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(H.update).toHaveBeenCalledWith({
      epa_registration: '264-849',
      signal_word: null,
    }));
    expect(H.eq).toHaveBeenCalledWith('id', 'missing-1');
    expect(H.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      event: 'product_epa_registration_set',
      description: expect.stringContaining('Set EPA registration for Missing Herbicide'),
    }));
  });

  it('blocks cached signal-word applies until a fresh EPA scan completes', async () => {
    H.products = [{
      id: 'trusted-1',
      product_name: 'Trusted Product',
      epa_registration: '264-849',
      is_rup: false,
      signal_word: null,
    }];
    H.invoke.mockResolvedValue({
      data: verifiedLookup({ productname: 'Trusted Product', signalWordCanonical: 'Warning' }),
      error: null,
    });
    sessionStorage.clear();
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      version: 1,
      checkedAt: '2026-07-10T20:00:00.000Z',
      rows: [
        cachedSignalRow('trusted-1', 'Trusted Product', [{ type: 'SIGNAL_WORD_AVAILABLE', epaValue: 'Warning' }]),
      ],
    }));

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    const batchButton = await screen.findByRole('button', { name: 'Apply all 1 EPA signal word' });
    const rowButton = screen.getByRole('button', { name: 'Apply “Warning”' });
    expect(batchButton).toBeDisabled();
    expect(rowButton).toBeDisabled();
    expect(screen.getByText('Re-run the EPA check to apply signal words.')).toBeInTheDocument();
    fireEvent.click(batchButton);
    fireEvent.click(rowButton);
    expect(H.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Run EPA check/ }));
    await waitFor(() => expect(H.invoke).toHaveBeenCalledWith('epa-lookup', {
      body: { regNumber: '264-849' },
    }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Apply all 1 EPA signal word' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Apply “Warning”' })).toBeEnabled();
    });
  });

  it('skips an individual signal-word apply when the product changed after the EPA check', async () => {
    H.products = [{
      id: 'trusted-1',
      product_name: 'Trusted Product',
      epa_registration: '264-849',
      is_rup: false,
      signal_word: null,
    }];
    H.invoke.mockResolvedValue({
      data: verifiedLookup({ productname: 'Trusted Product', signalWordCanonical: 'Warning' }),
      error: null,
    });
    sessionStorage.clear();
    H.mutationResults = [{ data: [], error: null }];

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Run EPA check' }));
    await waitFor(() => expect(H.invoke).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply “Warning”' }));

    await waitFor(() => expect(H.update).toHaveBeenCalledTimes(1));
    expect(H.eq).toHaveBeenCalledWith('epa_registration', '264-849');
    expect(H.is).toHaveBeenCalledWith('signal_word', null);
    expect(H.logActivity).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'product_signal_word_applied',
    }));
    expect(H.toast).toHaveBeenCalledWith('info', expect.stringContaining('changed since the last EPA check'));
    expect(screen.getByRole('button', { name: 'Apply “Warning”' })).toBeInTheDocument();
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}');
    expect(cached.rows[0].product.signal_word).toBeNull();
    expect(cached.rows[0].findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'SIGNAL_WORD_AVAILABLE' }),
    ]));
  });

  it('applies an individual signal word when the unchanged database registration has whitespace', async () => {
    H.products = [{
      id: 'whitespace-1',
      product_name: 'Whitespace Product',
      epa_registration: ' 264-849 ',
      is_rup: false,
      signal_word: null,
    }];
    H.invoke.mockResolvedValue({
      data: verifiedLookup({ productname: 'Whitespace Product', signalWordCanonical: 'Warning' }),
      error: null,
    });
    sessionStorage.clear();
    H.mutationResults = [{ data: [{ id: 'whitespace-1' }], error: null }];

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Run EPA check' }));
    await waitFor(() => expect(H.invoke).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply “Warning”' }));

    await waitFor(() => expect(H.update).toHaveBeenCalledTimes(1));
    expect(H.eq).toHaveBeenCalledWith('epa_registration', ' 264-849 ');
    expect(H.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      event: 'product_signal_word_applied',
      entityId: 'whitespace-1',
    }));
    expect(H.toast).toHaveBeenCalledWith('success', expect.stringContaining('Whitespace Product'));
  });

  it('reports applied, skipped, and failed signal-word batch writes separately', async () => {
    H.products = [
      { id: 'applied-1', product_name: 'Signal Word Product', epa_registration: '264-849', is_rup: false, signal_word: null },
      { id: 'skipped-1', product_name: 'Signal Word Product', epa_registration: '264-850', is_rup: false, signal_word: null },
      { id: 'failed-1', product_name: 'Signal Word Product', epa_registration: '264-851', is_rup: false, signal_word: null },
    ];
    H.invoke.mockResolvedValue({
      data: verifiedLookup({ productname: 'Signal Word Product', signalWordCanonical: 'Warning' }),
      error: null,
    });
    sessionStorage.clear();
    H.mutationResults = [
      { data: [{ id: 'applied-1' }], error: null },
      { data: [], error: null },
      { data: null, error: { message: 'database write rejected' } },
    ];

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Run EPA check' }));
    await waitFor(() => expect(H.invoke).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply all 3 EPA signal words' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 3 products' }));

    await waitFor(() => expect(H.update).toHaveBeenCalledTimes(3));
    expect(H.logActivity).toHaveBeenCalledTimes(1);
    expect(H.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      event: 'product_signal_word_applied',
      entityId: 'applied-1',
    }));
    expect(await screen.findByText('Signal-word batch details')).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith(
      'warning',
      'Applied signal word to 1 product · 1 skipped (changed since the last check — re-run) · 1 failed — see details.',
    );
  });

  it('reports an all-skipped signal-word batch as informational', async () => {
    H.products = [
      { id: 'skipped-1', product_name: 'Signal Word Product', epa_registration: '264-849', is_rup: false, signal_word: null },
      { id: 'skipped-2', product_name: 'Signal Word Product', epa_registration: '264-850', is_rup: false, signal_word: null },
    ];
    H.invoke.mockResolvedValue({
      data: verifiedLookup({ productname: 'Signal Word Product', signalWordCanonical: 'Warning' }),
      error: null,
    });
    sessionStorage.clear();
    H.mutationResults = [
      { data: [], error: null },
      { data: [], error: null },
    ];

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Run EPA check' }));
    await waitFor(() => expect(H.invoke).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply all 2 EPA signal words' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 products' }));

    await waitFor(() => expect(H.update).toHaveBeenCalledTimes(2));
    expect(H.toast).toHaveBeenCalledWith(
      'info',
      'Applied signal word to 0 products · 2 skipped (changed since the last check — re-run).',
    );
  });

  it('discards a cached run with internally inconsistent EPA-derived findings', async () => {
    H.products = [];
    sessionStorage.clear();
    const inconsistentRow = cachedSignalRow(
      'inconsistent-1',
      'Inconsistent Product',
      [{ type: 'SIGNAL_WORD_AVAILABLE', epaValue: 'Warning' }],
      false,
    );
    inconsistentRow.findings[0].registrationNumber = 'changed-registration';
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      version: 1,
      checkedAt: '2026-07-10T20:00:00.000Z',
      rows: [inconsistentRow],
    }));

    render(
      <MemoryRouter initialEntries={['/label-data-quality']}>
        <LabelDataQuality />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No EPA check results yet')).toBeInTheDocument();
    expect(screen.queryByText('Inconsistent Product')).not.toBeInTheDocument();
  });
});

function cachedSignalRow(
  id: string,
  productName: string,
  findings: Array<{ type: string; epaValue?: string }>,
  found = true,
  epaRegistrationDb?: string,
) {
  return {
    id,
    productName,
    registrationNumber: '264-849',
    epaProductName: found ? productName : '',
    product: {
      id,
      product_name: productName,
      epa_registration: '264-849',
      ...(epaRegistrationDb === undefined ? {} : { epaRegistrationDb }),
      is_rup: false,
      signal_word: null,
    },
    epa: found ? {
      found: true,
      productName,
      status: 'Active',
      isCancelled: false,
    } : {
      found: false,
      productName: null,
      status: null,
      isCancelled: false,
    },
    findings: findings.map((finding) => ({
      type: finding.type,
      level: finding.type === 'SIGNAL_WORD_AVAILABLE' ? 'informational' : 'action',
      registrationNumber: '264-849',
      productId: id,
      productName,
      message: finding.type,
      epaValue: finding.epaValue,
    })),
  };
}

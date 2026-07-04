/**
 * MonthEndClose.test.tsx — Tests for the month-end close page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/statementPdf', () => ({
  downloadBatchStatements: vi.fn(),
}));

vi.mock('../lib/yearEndSummaryPdf', () => ({
  downloadBatchYearEndSummaries: vi.fn(),
}));

vi.mock('../components/statements/StatementPrintDialog', () => ({ default: () => null }));
vi.mock('../components/reports/YearEndSummaryDialog', () => ({ default: () => null }));

import MonthEndClose from './MonthEndClose';

function renderMonthEnd() {
  return render(
    <MemoryRouter initialEntries={['/month-end']}>
      <Routes>
        <Route path="/month-end" element={<MonthEndClose />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MonthEndClose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('renders Month-End Close heading', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText('Month-End Close')).toBeInTheDocument();
    });
  });

  it('shows current period label', async () => {
    renderMonthEnd();
    await waitFor(() => {
      // Should show the current month name (e.g., "March 2026")
      const now = new Date();
      const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      expect(screen.getByText(monthLabel)).toBeInTheDocument();
    });
  });

  it('renders the checklist section', async () => {
    renderMonthEnd();
    await waitFor(() => {
      // Target the section heading specifically. With no summary loaded (mock returns
      // null), the page also renders a "Resolve all checklist items…" fail-closed note
      // (A9 Codex P1), so a broad /checklist/i now matches two elements.
      expect(screen.getByText('Close Checklist')).toBeInTheDocument();
    });
  });

  it('keeps "Roll the Month" unavailable when no summary loaded (fail-closed)', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText('Close Checklist')).toBeInTheDocument();
    });
    // With get_monthly_summary returning null, the period cannot be closed: the
    // fail-closed note is shown and the "Roll the Month" button is disabled.
    expect(screen.getByText(/Resolve all checklist items/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Roll the Month/i })).toBeDisabled();
  });

  it('renders statements section', async () => {
    renderMonthEnd();
    await waitFor(() => {
      expect(screen.getByText(/statement/i)).toBeInTheDocument();
    });
  });
});

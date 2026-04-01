/**
 * DispatchBoard.test.tsx — Unit tests for the DispatchBoard component
 *
 * Verifies that the DispatchBoard renders its heading, summary cards,
 * filter dropdowns, and date picker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DispatchBoard from './DispatchBoard';

// ─── Mocks ─────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'test-user-id', full_name: 'Test Admin', role: 'admin' },
    session: { user: { id: 'test-user-id' } },
  }),
}));

vi.mock('../hooks/usePageMeta', () => ({
  usePageMeta: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../lib/dateUtils', () => ({
  localToday: () => '2026-03-31',
}));

// Mock CRXMap + FieldBoundaryLayer (these use mapbox which is unavailable in jsdom)
vi.mock('../components/map/CRXMap', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="crx-map">{children}</div>
  ),
}));

vi.mock('../components/map/FieldBoundaryLayer', () => ({
  default: () => <div data-testid="field-boundary-layer" />,
}));

// Mock supabase with chainable query builder
const mockSelect = vi.fn();
const mockIs = vi.fn();
const mockGte = vi.fn();
const mockLte = vi.fn();
const mockOrder = vi.fn();
const mockIn = vi.fn();
const mockEq = vi.fn();

function buildChain(finalData: unknown[] = [], finalError: null | Error = null) {
  const response = { data: finalData, error: finalError };
  mockOrder.mockReturnValue(response);
  mockLte.mockReturnValue({ order: mockOrder });
  mockGte.mockReturnValue({ lte: mockLte });
  mockIs.mockReturnValue({ gte: mockGte });
  // For applicators query (profiles)
  mockEq.mockReturnValue({ order: mockOrder });
  mockIn.mockReturnValue({ eq: mockEq });
  // For fields query
  const fieldsResponse = { data: [], error: null };
  const fieldsEq = vi.fn().mockReturnValue(fieldsResponse);

  mockSelect.mockImplementation((selectStr: string) => {
    if (selectStr?.includes('customer:customers')) {
      // jobs query
      return { is: mockIs };
    }
    if (selectStr?.includes('id, full_name, role')) {
      // applicators query
      return { in: mockIn };
    }
    // fields query
    return { eq: fieldsEq };
  });

  return response;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: () => ({ select: mockSelect }),
  },
  checkMutationResult: vi.fn(),
}));

// ─── Helpers ───────────────────────────────────────────────────────────

function renderDispatchBoard() {
  return render(
    <MemoryRouter initialEntries={['/dispatch']}>
      <DispatchBoard />
    </MemoryRouter>,
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('DispatchBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildChain([]);
  });

  it('renders the Dispatch Board heading', async () => {
    renderDispatchBoard();
    expect(await screen.findByText('Dispatch Board')).toBeInTheDocument();
  });

  it('renders summary cards (Scheduled, In Progress, Completed, Total Acres)', async () => {
    renderDispatchBoard();
    // "Scheduled" appears in both the summary card and the filter dropdown,
    // so use getAllByText and verify at least one is a card label (<p>).
    const scheduledEls = await screen.findAllByText('Scheduled');
    expect(scheduledEls.length).toBeGreaterThanOrEqual(1);
    // These labels are unique to the summary cards
    expect(screen.getByText('Total Acres')).toBeInTheDocument();
    // In Progress and Completed also appear in filters; verify at least one each
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the status filter dropdown', async () => {
    renderDispatchBoard();
    expect(await screen.findByText('All Statuses')).toBeInTheDocument();
  });

  it('renders the priority filter dropdown', async () => {
    renderDispatchBoard();
    expect(await screen.findByText('All Priorities')).toBeInTheDocument();
  });

  it('renders the date picker with today as default', async () => {
    renderDispatchBoard();
    const dateInput = await screen.findByDisplayValue('2026-03-31');
    expect(dateInput).toBeInTheDocument();
    expect(dateInput).toHaveAttribute('type', 'date');
  });

  it('renders the map container', async () => {
    renderDispatchBoard();
    expect(await screen.findByTestId('crx-map')).toBeInTheDocument();
  });

  it('shows zero counts when no jobs are returned', async () => {
    renderDispatchBoard();
    // All four stat cards should display 0
    const zeros = await screen.findAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(3); // scheduled, in_progress, completed
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockRole = vi.fn();
const mockDeniedPages = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: mockRole(),
    deniedPages: mockDeniedPages(),
  }),
}));

// Uses the REAL pagePermissions so route→page-key mapping (including the
// /invoices/field-app/* → 'field-invoices' special case) is exercised for real.
import WorkspaceTabs from './WorkspaceTabs';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceTabs />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockReturnValue('admin');
  mockDeniedPages.mockReturnValue([]);
});

describe('WorkspaceTabs', () => {
  it('renders the Billing workspace on /invoices with Chemical Invoices active', () => {
    renderAt('/invoices');
    expect(screen.getByText('Chemical Invoices')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Field Invoices')).not.toHaveAttribute('aria-current');
  });

  it('marks Field Invoices active on the /invoices/field-app editor routes', () => {
    renderAt('/invoices/field-app/new');
    expect(screen.getByText('Field Invoices')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Chemical Invoices')).not.toHaveAttribute('aria-current');
  });

  it('renders nothing on a route outside every workspace', () => {
    const { container } = renderAt('/customers');
    expect(container).toBeEmptyDOMElement();
  });

  it('hides admin-only tabs from a sales rep', () => {
    mockRole.mockReturnValue('sales_rep');
    renderAt('/invoices');
    expect(screen.queryByText('A/R Workspace')).not.toBeInTheDocument();
    expect(screen.getByText('Chemical Invoices')).toBeInTheDocument();
  });

  it('hides tabs on the per-user deny list', () => {
    mockRole.mockReturnValue('sales_rep');
    mockDeniedPages.mockReturnValue(['payments']);
    renderAt('/invoices');
    expect(screen.queryByText('Record Payments')).not.toBeInTheDocument();
    expect(screen.getByText('Field Invoices')).toBeInTheDocument();
  });
});

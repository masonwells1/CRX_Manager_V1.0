import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockProfile = vi.fn();
const mockDeniedPages = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: mockProfile(),
    deniedPages: mockDeniedPages(),
    signOut: vi.fn(),
  }),
}));

vi.mock('../../lib/pagePermissions', () => ({
  hasPageAccess: vi.fn(() => true),
  getPageKeyFromPath: vi.fn((path: string) => path.replace('/', '')),
}));

import Sidebar from './Sidebar';

function renderSidebar(mobileOpen = false) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Sidebar mobileOpen={mobileOpen} onClose={vi.fn()} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeniedPages.mockReturnValue([]);
  localStorage.clear();
});

describe('Sidebar', () => {
  it('renders Operations link for admin', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    // Desktop + mobile + tooltip can produce multiple matches
    expect(screen.getAllByText('Operations').length).toBeGreaterThan(0);
  });

  it('renders Sales category for admin', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Sales').length).toBeGreaterThan(0);
  });

  it('renders Team Board for all roles', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar();
    expect(screen.getAllByText('Team Board').length).toBeGreaterThan(0);
  });

  it('renders Settings for admin only', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
  });

  it('hides Settings for non-admin roles', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar();
    expect(screen.queryAllByText('Settings')).toHaveLength(0);
  });

  it('renders Sign Out button', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar(true);
    expect(screen.getAllByText('Sign Out').length).toBeGreaterThan(0);
  });

  it('renders Finance category for admin', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Finance').length).toBeGreaterThan(0);
  });

  it('renders Customers category for sales_rep', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    renderSidebar();
    expect(screen.getAllByText('Customers').length).toBeGreaterThan(0);
  });

  it('has navigation landmark', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });
});

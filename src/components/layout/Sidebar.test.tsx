import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
import { hasPageAccess } from '../../lib/pagePermissions';

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
  it('renders Sell & Deliver category for admin', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    // Desktop + mobile + tooltip can produce multiple matches
    expect(screen.getAllByText('Sell & Deliver').length).toBeGreaterThan(0);
  });

  it('renders Today and To-Ship as the office standalones', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
    expect(screen.getAllByText('To-Ship (Load-Out Board)').length).toBeGreaterThan(0);
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

  it('renders Money category for admin', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Money').length).toBeGreaterThan(0);
  });

  it('renders Customers & Fields category for sales_rep', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    renderSidebar();
    expect(screen.getAllByText('Customers & Fields').length).toBeGreaterThan(0);
  });

  it('shows only the driver phone menu, not office categories', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar();
    expect(screen.getAllByText('My Route').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Deliveries').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Team Board').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Help').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sell & Deliver')).not.toBeInTheDocument();
  });

  it('has navigation landmark', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });

  it('closes the mobile drawer with Escape', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar mobileOpen onClose={onClose} />
      </MemoryRouter>
    );

    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a workspace entry visible when only its lead page is denied, linking to the first allowed sibling', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    vi.mocked(hasPageAccess).mockImplementation(
      (_role, _denied, pageKey) => pageKey !== 'products' && pageKey !== 'supplier-pricing'
    );
    renderSidebar(true);

    const links = screen.getAllByText('Products & Pricing').map((el) => el.closest('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/brand-vs-generic');
    }
  });

  it('hides a workspace entry when every sibling page is denied', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    const denied = new Set(['products', 'supplier-pricing', 'brand-vs-generic']);
    vi.mocked(hasPageAccess).mockImplementation((_role, _denied, pageKey) => !denied.has(pageKey));
    renderSidebar(true);

    expect(screen.queryAllByText('Products & Pricing')).toHaveLength(0);
  });

  it('keeps the Insights standalone visible when only /dashboard is denied, linking to Reports', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    vi.mocked(hasPageAccess).mockImplementation((_role, _denied, pageKey) => pageKey !== 'dashboard');
    renderSidebar(true);

    const links = screen.getAllByText('Insights').map((el) => el.closest('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/reports');
    }
  });

  it('traps focus within the open mobile drawer', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar(true);

    const closeButton = screen.getByRole('button', { name: 'Close navigation menu' });
    const signOutButton = screen.getAllByRole('button', { name: 'Sign Out' })[0];
    signOutButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(closeButton).toHaveFocus();
  });
});

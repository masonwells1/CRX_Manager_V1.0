import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockProfile = vi.fn();
const mockDeniedPages = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: mockProfile(),
    deniedPages: mockDeniedPages(),
  }),
}));

vi.mock('../../lib/pagePermissions', () => ({
  hasPageAccess: vi.fn((role: string | null, deniedPages: string[], pageKey: string) =>
    role === 'admin' || !deniedPages.includes(pageKey)
  ),
}));

import MobileBottomNav from './MobileBottomNav';

function renderBottomNav(path = '/office-cockpit', moreOpen = false) {
  const onMoreClick = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <MobileBottomNav onMoreClick={onMoreClick} moreOpen={moreOpen} />
    </MemoryRouter>
  );
  return onMoreClick;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
  mockDeniedPages.mockReturnValue([]);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
});

describe('MobileBottomNav', () => {
  it('renders the five mobile navigation actions with 44px touch targets', () => {
    renderBottomNav();

    expect(screen.getByRole('navigation', { name: 'Mobile primary navigation' })).toHaveClass('md:hidden', 'pb-[env(safe-area-inset-bottom)]');
    expect(screen.getByRole('link', { name: 'Today' })).toHaveClass('min-h-11');
    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveClass('min-h-11');
    expect(screen.getByRole('link', { name: 'Inventory' })).toHaveClass('min-h-11');
    expect(screen.getByRole('link', { name: 'Field Invoices' })).toHaveClass('min-h-11');
    expect(screen.getByRole('button', { name: 'Open navigation menu' })).toHaveClass('min-h-11');
  });

  it('marks the current primary route as active', () => {
    renderBottomNav('/jobs/123');

    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
  });

  it('keeps Field Invoices active in its editor route', () => {
    renderBottomNav('/invoices/field-app/new');

    expect(screen.getByRole('link', { name: 'Field Invoices' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides denied page links while keeping More available', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    mockDeniedPages.mockReturnValue(['inventory']);
    renderBottomNav();

    expect(screen.queryByRole('link', { name: 'Inventory' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open navigation menu' })).toBeInTheDocument();
  });

  it('opens the full drawer through More', () => {
    const onMoreClick = renderBottomNav('/jobs', true);
    const moreButton = screen.getByRole('button', { name: 'Open navigation menu' });

    fireEvent.click(moreButton);
    expect(onMoreClick).toHaveBeenCalledOnce();
    expect(moreButton).toHaveAttribute('aria-expanded', 'true');
  });
});

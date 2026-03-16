import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./Sidebar', () => ({
  default: ({ mobileOpen }: { mobileOpen: boolean }) => (
    <div data-testid="sidebar" data-mobile-open={mobileOpen}>Sidebar</div>
  ),
}));

vi.mock('./TopBar', () => ({
  default: ({ title }: { title: string }) => (
    <div data-testid="topbar">{title}</div>
  ),
}));

vi.mock('../ui/OfflineBanner', () => ({
  default: () => <div data-testid="offline-banner">OfflineBanner</div>,
}));

vi.mock('../../hooks/usePageMeta', () => ({
  usePageMeta: () => ({ title: 'Test Page', accent: 'Accent' }),
}));

import AppLayout from './AppLayout';

function renderLayout() {
  return render(
    <MemoryRouter>
      <AppLayout />
    </MemoryRouter>
  );
}

describe('AppLayout', () => {
  it('renders Sidebar', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders TopBar with page title', () => {
    renderLayout();
    expect(screen.getByTestId('topbar')).toHaveTextContent('Test Page');
  });

  it('renders OfflineBanner', () => {
    renderLayout();
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  it('has skip-to-content link for accessibility', () => {
    renderLayout();
    const skipLink = screen.getByText('Skip to main content');
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute('href', '#main-content');
  });

  it('renders main content area with correct id', () => {
    renderLayout();
    const main = document.getElementById('main-content');
    expect(main).toBeTruthy();
    expect(main?.tagName).toBe('MAIN');
  });

  it('sidebar starts with mobileOpen=false', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-mobile-open', 'false');
  });
});

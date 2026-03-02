import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Breadcrumbs from './Breadcrumbs';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderBreadcrumbs(items: Array<{ label: string; href?: string }>) {
  return render(
    <MemoryRouter>
      <Breadcrumbs items={items} />
    </MemoryRouter>
  );
}

describe('Breadcrumbs', () => {
  beforeEach(() => mockNavigate.mockClear());

  it('renders all items', () => {
    renderBreadcrumbs([
      { label: 'Orders', href: '/orders' },
      { label: 'ORD-1234' },
    ]);
    expect(screen.getByText('Orders')).toBeInTheDocument();
    expect(screen.getByText('ORD-1234')).toBeInTheDocument();
  });

  it('last item is not a link', () => {
    renderBreadcrumbs([
      { label: 'Orders', href: '/orders' },
      { label: 'ORD-1234' },
    ]);
    const lastItem = screen.getByText('ORD-1234');
    expect(lastItem.tagName).toBe('SPAN');
  });

  it('clicking a link navigates', () => {
    renderBreadcrumbs([
      { label: 'Orders', href: '/orders' },
      { label: 'ORD-1234' },
    ]);
    fireEvent.click(screen.getByText('Orders'));
    expect(mockNavigate).toHaveBeenCalledWith('/orders');
  });

  it('renders accessibility landmark', () => {
    renderBreadcrumbs([{ label: 'Home' }]);
    expect(screen.getByLabelText('Breadcrumb')).toBeInTheDocument();
  });
});

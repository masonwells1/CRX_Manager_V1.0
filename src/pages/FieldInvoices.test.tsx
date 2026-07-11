import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FieldInvoices from './FieldInvoices';
import listPanelSource from '../components/field-invoices/FieldInvoicesListPanel.tsx?raw';
import postedPanelSource from '../components/field-invoices/FieldInvoicesPostedPanel.tsx?raw';
import unpostedPanelSource from '../components/field-invoices/FieldInvoicesUnpostedPanel.tsx?raw';
import unbilledPanelSource from '../components/field-invoices/UnbilledApplicationsPanel.tsx?raw';

const query = {
  select: vi.fn(),
  eq: vi.fn(),
  in: vi.fn(),
  is: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
};

query.select.mockReturnValue(query);
query.eq.mockReturnValue(query);
query.in.mockReturnValue(query);
query.is.mockReturnValue(query);
query.gte.mockReturnValue(query);
query.lte.mockResolvedValue({ count: 0, error: null });

vi.mock('../lib/db', () => ({
  supabase: { from: vi.fn(() => query) },
}));

vi.mock('../components/field-invoices/UnbilledApplicationsPanel', () => ({
  default: () => <p>Unbilled panel</p>,
}));
vi.mock('../components/field-invoices/FieldInvoicesUnpostedPanel', () => ({
  default: () => <p>Draft invoices panel</p>,
}));
vi.mock('../components/field-invoices/FieldInvoicesPostedPanel', () => ({
  default: () => <p>Posted invoices panel</p>,
}));
vi.mock('../components/field-invoices/CustomerInvoiceSummaryPanel', () => ({
  default: () => <p>Customer invoices panel</p>,
}));
vi.mock('../components/field-invoices/FieldInvoicesListPanel', () => ({
  default: () => <p>All invoices panel</p>,
}));

describe('FieldInvoices', () => {
  it('shows the four workflow tabs and switches their panels', async () => {
    render(
      <MemoryRouter initialEntries={['/field-invoices?tab=unbilled']}>
        <FieldInvoices />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Unbilled' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Drafts/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Posted/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'By Customer' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Unbilled panel');

    await waitFor(() => expect(screen.getByRole('tab', { name: /Posted/ })).toHaveTextContent('0'));

    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Draft invoices panel');

    fireEvent.click(screen.getByRole('tab', { name: /Posted/ }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Posted invoices panel');

    fireEvent.click(screen.getByRole('tab', { name: 'By Customer' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Customer invoices panel');
  });

  it('accepts legacy tab query aliases', async () => {
    render(
      <MemoryRouter initialEntries={['/field-invoices?tab=summary']}>
        <FieldInvoices />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'By Customer' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Customer invoices panel');
    await waitFor(() => expect(screen.getByRole('tab', { name: /Drafts/ })).toHaveTextContent('0'));
  });

  it('keeps the workflow constrained and horizontally scrollable at 375px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    window.dispatchEvent(new Event('resize'));

    const { container } = render(
      <MemoryRouter initialEntries={['/field-invoices?tab=unbilled']}>
        <FieldInvoices />
      </MemoryRouter>
    );

    expect(container.firstElementChild).toHaveClass('min-w-0');
    expect(screen.getByRole('tablist')).toHaveClass('overflow-x-auto', 'flex-nowrap');
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Drafts/ })).toHaveTextContent('0'));
  });

  it('keeps mobile card fallbacks and bounded scroll containers on invoice panels', () => {
    expect(listPanelSource).toContain('<MobileCardList');
    expect(postedPanelSource).toContain('<MobileCardList');
    expect(unpostedPanelSource).toContain('<MobileCardList');
    expect(unbilledPanelSource).toContain('max-w-full overflow-x-auto');
  });
});

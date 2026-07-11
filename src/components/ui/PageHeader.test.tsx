import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PageHeader from './PageHeader';

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="Orders" />);
    expect(screen.getByRole('heading', { name: 'Orders' })).toHaveClass(
      'font-heading',
      'text-nav-dark'
    );
  });

  it('renders an accent word alongside the title', () => {
    render(<PageHeader title="Field" accent="Invoices" />);
    const heading = screen.getByRole('heading', { name: 'Field Invoices' });
    expect(heading).toHaveTextContent('Field Invoices');
    expect(screen.getByText('Invoices')).toHaveClass('split-heading-accent');
  });

  it('renders a subtitle when provided', () => {
    render(<PageHeader title="Receiving" subtitle="Review inbound shipments." />);
    expect(screen.getByText('Review inbound shipments.')).toBeInTheDocument();
  });

  it('does not render a subtitle when omitted', () => {
    render(<PageHeader title="Receiving" />);
    expect(screen.queryByText(/Review inbound/)).not.toBeInTheDocument();
  });

  it('renders the actions slot', () => {
    render(<PageHeader title="Prepay" actions={<button>New</button>} />);
    const action = screen.getByRole('button', { name: 'New' });

    expect(action).toBeInTheDocument();
    expect(action.parentElement).toHaveClass('flex', 'flex-wrap', 'justify-end');
  });
});

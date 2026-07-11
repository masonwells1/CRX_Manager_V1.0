import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Receiving from './Receiving';

vi.mock('../components/receiving/ReceivingHubPanel', () => ({
  default: () => <p>Receiving hub panel</p>,
}));
vi.mock('../components/receiving/QuickReceivePanel', () => ({
  default: () => <p>Quick receive panel</p>,
}));
vi.mock('../components/receiving/ReceivingLogPanel', () => ({
  default: () => <p>Receiving log panel</p>,
}));

describe('Receiving', () => {
  it('renders the receiving workflow tabs and switches their panels', () => {
    render(
      <MemoryRouter initialEntries={['/receiving?tab=hub']}>
        <Receiving />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Receiving' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hub' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Quick Receive' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Log' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Receiving hub panel');

    fireEvent.click(screen.getByRole('tab', { name: 'Quick Receive' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Quick receive panel');

    fireEvent.click(screen.getByRole('tab', { name: 'Log' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Receiving log panel');
  });

  it('opens the quick tab from a query-addressable link', () => {
    render(
      <MemoryRouter initialEntries={['/receiving?tab=quick']}>
        <Receiving />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Quick Receive' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Quick receive panel');
  });

  it('falls back to the hub for an unknown tab', () => {
    render(
      <MemoryRouter initialEntries={['/receiving?tab=unknown']}>
        <Receiving />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Hub' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Receiving hub panel');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Integrity from './Integrity';

vi.mock('../components/integrity/IntegrityReportPanel', () => ({
  default: () => <p>Integrity report panel</p>,
}));
vi.mock('../components/integrity/IntegrityCleanupPanel', () => ({
  default: () => <p>Integrity cleanup panel</p>,
}));

describe('Integrity', () => {
  it('renders the integrity tabs and switches their panels', () => {
    render(
      <MemoryRouter initialEntries={['/integrity?tab=report']}>
        <Integrity />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Data Integrity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Cleanup' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Integrity report panel');

    fireEvent.click(screen.getByRole('tab', { name: 'Cleanup' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Integrity cleanup panel');
  });

  it('opens cleanup from a query-addressable link', () => {
    render(
      <MemoryRouter initialEntries={['/integrity?tab=cleanup']}>
        <Integrity />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Cleanup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Integrity cleanup panel');
  });

  it('falls back to the report for an unknown tab', () => {
    render(
      <MemoryRouter initialEntries={['/integrity?tab=unknown']}>
        <Integrity />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true');
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Jobs from './Jobs';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'viewer', profile: { id: 'user-1', role: 'viewer' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: (() => {
    const toast = vi.fn();
    return () => ({ toast });
  })(),
}));

vi.mock('../lib/db', () => {
  const job = {
    id: 'job-1',
    job_number: 'JOB-001',
    status: 'scheduled',
    job_date: '2026-07-11',
    total_acres: 40,
    remaining_acres: 40,
    customer: { farm_name: 'Acme Acres', account_number: '1001', phone: null },
    vehicle: null,
    job_fields: [{ crop: 'Corn', field: { field_name: 'North 40', crop_type: 'Corn', county: null, state: null } }],
    job_chemicals: [{ rate_per_acre: 1, rate_unit: 'gal/ac', product: { product_name: 'Test Blend' } }],
    job_tag_assignments: [],
    batch: null,
    job_location_dispatches: [],
    applicator_id: null,
    created_by: null,
    updated_by: null,
    last_printed_by: null,
  };
  const dataFor = (table: string) => table === 'jobs' ? [job] : [];
  const chain = (table: string) => {
    const value: Record<string, unknown> = {};
    const self = () => value;
    for (const method of ['select', 'is', 'eq', 'in', 'gte', 'lte', 'ilike', 'or', 'order', 'limit']) value[method] = self;
    value.maybeSingle = () => Promise.resolve({ data: null, error: null });
    value.then = (resolve: (result: { data: unknown[]; error: null }) => unknown) => resolve({ data: dataFor(table), error: null });
    return value;
  };
  return {
    supabase: { from: (table: string) => chain(table), rpc: vi.fn().mockResolvedValue({ data: [], error: null }) },
    checkMutationResult: vi.fn(),
    assertRpcResult: <T,>(data: T) => data,
  };
});

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

describe('Jobs mobile cards', () => {
  it('shows the required fields in a 375px card, collapses filters, and opens the existing detail route', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Jobs />
        <CurrentPath />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('button', { name: 'Open job JOB-001' });
    expect(card).toHaveClass('min-h-[44px]');
    expect(card).toHaveTextContent('Acme Acres');
    expect(card).toHaveTextContent('North 40');
    expect(card).toHaveTextContent('Test Blend');
    expect(card).toHaveTextContent('scheduled');
    expect(card).toHaveTextContent('Scheduled:');

    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(card);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/jobs/job-1');
  });
});

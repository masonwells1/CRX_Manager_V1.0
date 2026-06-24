/**
 * CustomerDrawer self-guard — regression test for the round-5 P1 leak.
 *
 * The drawer renders CustomerSummaryBar (AR balance + credit tier). It must refuse
 * to render that finance data to anyone without customers-page access, regardless of
 * which list mounts it — a driver (not in the customers-page roles) or a sales_rep
 * with /customers in their deny-list. Uses the REAL hasPageAccess (pure, already
 * tested); only useAuth/navigation/the summary bar are mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import CustomerDrawer from './CustomerDrawer';

let authValue: { role: 'admin' | 'sales_rep' | 'driver' | null; deniedPages: string[] };

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authValue }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./CustomerSummaryBar', () => ({ default: () => <div data-testid="customer-summary" /> }));

afterEach(cleanup);

const props = { open: true, customerId: 'c1', customerName: 'Acme Farms', onClose: () => {} };

describe('CustomerDrawer self-guard (round-5 P1: no customer finances to drivers / denied reps)', () => {
  it('renders NOTHING for a driver (drivers are not a customers-page role)', () => {
    authValue = { role: 'driver', deniedPages: [] };
    const { container } = render(<CustomerDrawer {...props} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.queryByTestId('customer-summary')).toBeNull();
  });

  it('renders NOTHING for a sales_rep who is denied /customers', () => {
    authValue = { role: 'sales_rep', deniedPages: ['customers'] };
    const { container } = render(<CustomerDrawer {...props} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.queryByTestId('customer-summary')).toBeNull();
  });

  it('renders the summary for an admin', () => {
    authValue = { role: 'admin', deniedPages: [] };
    render(<CustomerDrawer {...props} />);
    expect(screen.getByTestId('customer-summary')).toBeTruthy();
  });

  it('renders the summary for a sales_rep WITH customers access', () => {
    authValue = { role: 'sales_rep', deniedPages: [] };
    render(<CustomerDrawer {...props} />);
    expect(screen.getByTestId('customer-summary')).toBeTruthy();
  });
});

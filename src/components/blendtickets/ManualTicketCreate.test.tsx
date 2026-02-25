/**
 * ManualTicketCreate.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Test User' } }),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../../lib/blendMathValidator', () => ({
  validateBlendMath: vi.fn(() => ({ valid: true, errors: [] })),
}));

import { ManualTicketCreate } from './ManualTicketCreate';

describe('ManualTicketCreate', () => {
  const defaultProps = {
    customers: [{ id: 'c1', farm_name: 'Smith Farm' }] as Array<{ id: string; farm_name: string }>,
    onComplete: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('renders the form', () => {
    render(<ManualTicketCreate {...defaultProps} />);
    expect(screen.getAllByText(/customer/i).length).toBeGreaterThan(0);
  });

  it('renders product section', () => {
    render(<ManualTicketCreate {...defaultProps} />);
    expect(screen.getAllByText(/product/i).length).toBeGreaterThan(0);
  });
});

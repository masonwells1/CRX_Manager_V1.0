/**
 * BulkProductImport.test.tsx — Basic render + behavior tests
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

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isCSVFile: vi.fn(() => true),
  isOCRSupported: vi.fn(() => false),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import BulkProductImport from './BulkProductImport';

describe('BulkProductImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => vi.clearAllMocks());

  it('renders when open', () => {
    render(<BulkProductImport {...defaultProps} />);
    expect(screen.getByText(/bulk product/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkProductImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/bulk product/i)).not.toBeInTheDocument();
  });

  it('shows file upload area', () => {
    render(<BulkProductImport {...defaultProps} />);
    expect(screen.getAllByText(/csv/i).length).toBeGreaterThan(0);
  });
});

/**
 * BulkTicketUpload.test.tsx — Basic render + behavior tests
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
  supabase: {
    from: vi.fn(() => chainable()),
    rpc: vi.fn(() => chainable()),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'http://example.com/img.png' } })),
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'http://example.com/signed' }, error: null }),
      })),
    },
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Test User' } }),
}));

vi.mock('../../lib/imageCompression', () => ({
  compressImage: vi.fn(async (file: File) => file),
}));

import { BulkTicketUpload } from './BulkTicketUpload';

describe('BulkTicketUpload', () => {
  const defaultProps = {
    customers: [{ id: 'c1', farm_name: 'Smith Farm' }] as Array<{ id: string; farm_name: string }>,
    onUploadComplete: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('renders the upload interface', () => {
    render(<BulkTicketUpload {...defaultProps} />);
    expect(screen.getAllByText(/upload/i).length).toBeGreaterThan(0);
  });

  it('renders customer selection', () => {
    render(<BulkTicketUpload {...defaultProps} />);
    expect(screen.getAllByText(/customer/i).length).toBeGreaterThan(0);
  });
});

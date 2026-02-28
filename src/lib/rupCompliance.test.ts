import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase before importing
vi.mock('./db', () => {
  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);
    chain.gt = vi.fn().mockReturnValue(chain);
    chain.gte = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn();
    chain.maybeSingle = vi.fn();
    // Default: resolves to empty
    chain.then = vi.fn().mockImplementation((resolve) =>
      resolve({ data: [], error: null })
    );
    return chain;
  };
  return {
    supabase: {
      from: vi.fn().mockReturnValue(createChain()),
    },
    sanitizeError: vi.fn((e: unknown) => String(e)),
  };
});

import { checkRUPCompliance } from './rupCompliance';
import { supabase } from './db';

function mockSupabaseFrom(responses: Record<string, { data: unknown[] | null; error: null }>) {
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    const response = responses[table] || { data: [], error: null };

    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);

    // Make the chain thenable (awaitable) returning the response
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(response));

    return chain;
  });
}

describe('checkRUPCompliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no warnings when no products are RUP', async () => {
    mockSupabaseFrom({
      products: { data: [], error: null },
    });

    const result = await checkRUPCompliance('customer-1', ['prod-1', 'prod-2']);
    expect(result.hasRUPProducts).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns no warnings when productIds is empty', async () => {
    const result = await checkRUPCompliance('customer-1', []);
    expect(result.hasRUPProducts).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns when RUP product and customer has no license', async () => {
    mockSupabaseFrom({
      products: { data: [{ id: 'rup-1', product_name: 'Atrazine' }], error: null },
      applicator_licenses: { data: [], error: null },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.missingLicense).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Atrazine');
    expect(result.warnings[0]).toContain('No license on file');
  });

  it('warns when RUP product and customer license is expired', async () => {
    mockSupabaseFrom({
      products: { data: [{ id: 'rup-1', product_name: 'Paraquat' }], error: null },
      applicator_licenses: {
        data: [{ id: 'lic-1', expiry_date: '2020-01-01' }],
        error: null,
      },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.expiredLicense).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('expired');
  });

  it('returns no warnings when RUP product and license is valid', async () => {
    mockSupabaseFrom({
      products: { data: [{ id: 'rup-1', product_name: 'Atrazine' }], error: null },
      applicator_licenses: {
        data: [{ id: 'lic-1', expiry_date: '2030-12-31' }],
        error: null,
      },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1']);
    expect(result.hasRUPProducts).toBe(true);
    expect(result.hasValidLicense).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns multiple RUP product names in warnings', async () => {
    mockSupabaseFrom({
      products: {
        data: [
          { id: 'rup-1', product_name: 'Atrazine' },
          { id: 'rup-2', product_name: 'Paraquat' },
        ],
        error: null,
      },
      applicator_licenses: { data: [], error: null },
    });

    const result = await checkRUPCompliance('customer-1', ['rup-1', 'rup-2']);
    expect(result.rupProductNames).toEqual(['Atrazine', 'Paraquat']);
    expect(result.warnings[0]).toContain('Atrazine');
    expect(result.warnings[0]).toContain('Paraquat');
  });
});

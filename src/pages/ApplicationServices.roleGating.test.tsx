/**
 * ApplicationServices.roleGating.test.tsx — regression guard for the two bugs the
 * adversarial review of PR #267 caught in the cost carve-out's frontend half.
 *
 * Migration 20260729015706 revoked `application_services.cost_per_acre_cents` from
 * the shared `authenticated` role and put it behind `admin_get_application_service_costs`,
 * which raises 42501 for everyone else. The first cut of the page called that RPC
 * unconditionally, which produced two distinct failures:
 *
 *   1. Every driver / sales-rep page load fired a guaranteed-denied request, captured
 *      a Sentry exception and toasted an error about a column they are not meant to
 *      see. (Noise, and it teaches staff to ignore error toasts.)
 *   2. `assertRpcResult` THROWS when an RPC resolves with `data === null`. The throw
 *      escaped `fetchServices`, skipping `setLoading(false)` — the page sat on its
 *      loading skeleton forever, with an unhandled rejection behind it.
 *
 * These assertions fail if either regression returns. They drive the real page
 * component and the REAL `assertRpcResult`, so case 2 exercises the actual throw
 * rather than a stub of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const SERVICE_ROW = {
  id: 'svc-1',
  name: 'Y-Drop Nitrogen',
  vehicle_id: null,
  default_rate_per_acre_cents: 1200,
  is_active: true,
  sort_order: 0,
  created_by: 'u',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  vehicle: null,
};

const H = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: { current: 'admin' as string | null },
  toast: vi.fn(),
  captureException: vi.fn(),
}));

// Chainable stub: .from().select().order() awaits to the service list.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const rows = [SERVICE_ROW];
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'eq', 'in']) builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
  return {
    ...actual, // keeps the REAL assertRpcResult — its throw is what case 2 tests
    supabase: { from: () => builder, rpc: H.rpc },
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: H.role.current,
    profile: { id: 'u', full_name: 'Test', role: H.role.current, is_active: true },
    user: { id: 'u' },
    loading: false,
  }),
}));

const STABLE_TOAST = { toast: H.toast };
vi.mock('../components/ui/Toast', () => ({ useToast: () => STABLE_TOAST }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: H.captureException } }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

async function renderPage() {
  const { default: ApplicationServices } = await import('./ApplicationServices');
  return render(<ApplicationServices />, { wrapper });
}

beforeEach(() => {
  H.rpc.mockReset();
  H.toast.mockReset();
  H.captureException.mockReset();
  H.role.current = 'admin';
});
afterEach(cleanup);

describe('ApplicationServices cost gating', () => {
  it('does NOT call the admin-only cost RPC for a non-admin', async () => {
    H.role.current = 'driver';
    await renderPage();

    // The row loaded, so the page finished its fetch and left the skeleton.
    expect(await screen.findByText('Y-Drop Nitrogen')).toBeTruthy();
    expect(H.rpc).not.toHaveBeenCalled();
    // No denied-RPC noise for a column they were never meant to see.
    expect(H.toast).not.toHaveBeenCalled();
    expect(H.captureException).not.toHaveBeenCalled();
    // …and the permanently-blank Cost/Acre column is not advertised to them.
    expect(screen.queryByText('Cost/Acre')).toBeNull();
  });

  it('calls the cost RPC for an admin and merges the cents into the table', async () => {
    H.rpc.mockResolvedValue({ data: [{ service_id: 'svc-1', cost_per_acre_cents: '650' }], error: null });
    await renderPage();

    expect(await screen.findByText('$6.50/ac')).toBeTruthy();
    expect(H.rpc).toHaveBeenCalledTimes(1);
    expect(H.rpc.mock.calls[0][0]).toBe('admin_get_application_service_costs');
    expect(screen.queryByText('Cost/Acre')).toBeTruthy();
  });

  it('still finishes loading when the RPC resolves null and assertRpcResult throws', async () => {
    // The exact shape that stranded the page: no error object, but a null payload.
    H.rpc.mockResolvedValue({ data: null, error: null });
    await renderPage();

    // Row rendered => setLoading(false) ran => the throw did not escape fetchServices.
    expect(await screen.findByText('Y-Drop Nitrogen')).toBeTruthy();
    // Cost is UNKNOWN, rendered as '-', never as $0.00/ac (which would read as 100% margin).
    expect(screen.queryByText('$0.00/ac')).toBeNull();
    await waitFor(() => expect(H.captureException).toHaveBeenCalled());
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load application service costs');
  });
});

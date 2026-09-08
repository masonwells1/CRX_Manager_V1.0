/**
 * Fields.refreshContract.test.tsx — the refresh callback handed to the bulk import must say
 * whether the field list on screen is actually current.
 *
 * The import's results screen tells the operator to look a row up in this list before
 * re-importing it, because re-importing a row that already committed creates a duplicate field
 * a sales_rep cannot delete. That advice is only safe if the list was really reloaded.
 *
 * fetchFields handles its own RPC error — it toasts and returns — so a caller CANNOT learn
 * about a failed refresh from a rejection. A test that mocked the callback as rejecting would
 * be describing a contract this page does not have. This test drives the REAL callback and
 * asserts the value it resolves to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const rpc = vi.fn();
const fromSelect = vi.fn();

vi.mock('../lib/db', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ select: (...args: unknown[]) => fromSelect(...args) }),
  },
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data;
  },
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
  initSentry: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'user-1' } }) }));

/** Captures the refresh callback the page hands to the import modal. */
let capturedOnSuccess: (() => boolean | void | Promise<boolean | void>) | null = null;

vi.mock('../components/fields/BulkFieldImport', () => ({
  default: (props: { onSuccess: () => boolean | void | Promise<boolean | void> }) => {
    capturedOnSuccess = props.onSuccess;
    return <div data-testid="stub-import" />;
  },
}));

// The page renders a map and several heavy children; none of them are what this test is about.
vi.mock('../components/fields/FieldsMap', () => ({ default: () => <div /> }));
vi.mock('../components/fields/FieldDetailModal', () => ({ default: () => <div /> }));

import Fields from './Fields';

describe('Fields — the refresh contract the bulk import depends on', () => {
  beforeEach(() => {
    rpc.mockReset();
    fromSelect.mockReset();
    capturedOnSuccess = null;
    fromSelect.mockResolvedValue({ data: [], error: null });
  });

  it('resolves TRUE when the list really reloaded', async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    render(<MemoryRouter><Fields /></MemoryRouter>);
    await waitFor(() => expect(capturedOnSuccess).not.toBeNull());

    await expect(capturedOnSuccess!()).resolves.toBe(true);
  });

  it('resolves FALSE when the reload failed, instead of rejecting', async () => {
    // This is the shape that matters. fetchFields catches the Supabase error itself, so it
    // never rejects — a caller waiting for a throw would conclude the refresh succeeded and
    // send the operator to a stale list.
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });

    render(<MemoryRouter><Fields /></MemoryRouter>);
    await waitFor(() => expect(capturedOnSuccess).not.toBeNull());

    const result = capturedOnSuccess!();
    await expect(result).resolves.toBe(false);
  });
});

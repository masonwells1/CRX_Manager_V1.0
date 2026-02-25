/**
 * ActivityFeed.test.tsx — Tests for the activity feed component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── Chainable supabase query mock ──────────────────────────────────────────
// ActivityFeed calls: supabase.from(...).select(...).order(...).limit(...)
// then optionally: .eq(...)
// Every method must return the same builder object so chaining works.
let resolveValue: { data: unknown[] | null; error: null } = { data: [], error: null };

const queryBuilder: Record<string, unknown> = {};
queryBuilder.select = vi.fn(() => queryBuilder);
queryBuilder.order = vi.fn(() => queryBuilder);
queryBuilder.limit = vi.fn(() => queryBuilder);
queryBuilder.eq = vi.fn(() => queryBuilder);
// Make it thenable so `await query` resolves
queryBuilder.then = vi.fn((resolve: (v: unknown) => void) => {
  resolve(resolveValue);
});

vi.mock('../../lib/db', () => ({
  supabase: {
    from: vi.fn(() => queryBuilder),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../hooks/useRealtimeSubscription', () => ({
  useRealtimeActivity: vi.fn(),
}));

import ActivityFeed from './ActivityFeed';

describe('ActivityFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveValue = { data: [], error: null };
    // Re-wire .then after clearAllMocks
    (queryBuilder.then as ReturnType<typeof vi.fn>).mockImplementation(
      (resolve: (v: unknown) => void) => { resolve(resolveValue); },
    );
  });

  it('shows empty state when no activities', async () => {
    render(<ActivityFeed noteId="note-1" />);
    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeInTheDocument();
    });
  });

  it('renders activity entries', async () => {
    resolveValue = {
      data: [
        {
          id: '1',
          note_id: 'note-1',
          user_id: 'u1',
          action_type: 'created',
          changes: null,
          created_at: new Date().toISOString(),
          user: { full_name: 'Mason Wells' },
        },
      ],
      error: null,
    };

    render(<ActivityFeed noteId="note-1" />);
    await waitFor(() => {
      expect(screen.getByText('Mason Wells')).toBeInTheDocument();
      expect(screen.getByText(/created this note/i)).toBeInTheDocument();
    });
  });

  it('renders Activity heading', async () => {
    render(<ActivityFeed noteId="note-1" />);
    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });
  });

  it('renders "just now" for recent timestamps', async () => {
    resolveValue = {
      data: [
        {
          id: '2',
          note_id: 'note-1',
          user_id: 'u1',
          action_type: 'updated',
          changes: null,
          created_at: new Date().toISOString(),
          user: { full_name: 'Test User' },
        },
      ],
      error: null,
    };

    render(<ActivityFeed noteId="note-1" />);
    await waitFor(() => {
      expect(screen.getByText('just now')).toBeInTheDocument();
    });
  });

  it('handles null noteId', async () => {
    render(<ActivityFeed noteId={null} />);
    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeInTheDocument();
    });
  });
});

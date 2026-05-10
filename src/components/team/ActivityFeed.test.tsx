/**
 * ActivityFeed.test.tsx — Tests for the activity feed component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── Chainable supabase query mock ──────────────────────────────────────────
// ActivityFeed calls supabase.from(...).select(...).order(...).limit(...) with
// optional .eq(...) for note_activity_log, then a second
// supabase.from('profile_public_view').select(...).in(...) for actor names
// (PR-07 follow-up). Every chain method returns the same builder; the resolved
// value is keyed by the last table name passed to `from()`.
let tableData: Record<string, { data: unknown[] | null; error: null }> = {
  note_activity_log: { data: [], error: null },
  profile_public_view: { data: [], error: null },
};
let lastTable = '';

const queryBuilder: Record<string, unknown> = {};
queryBuilder.select = vi.fn(() => queryBuilder);
queryBuilder.order = vi.fn(() => queryBuilder);
queryBuilder.limit = vi.fn(() => queryBuilder);
queryBuilder.eq = vi.fn(() => queryBuilder);
queryBuilder.in = vi.fn(() => queryBuilder);
// Make it thenable so `await query` resolves with the table-specific data.
queryBuilder.then = vi.fn((resolve: (v: unknown) => void) => {
  resolve(tableData[lastTable] || { data: [], error: null });
});

vi.mock('../../lib/db', () => ({
  supabase: {
    from: vi.fn((table: string) => { lastTable = table; return queryBuilder; }),
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
    tableData = {
      note_activity_log: { data: [], error: null },
      profile_public_view: { data: [], error: null },
    };
    // Re-wire .then after clearAllMocks
    (queryBuilder.then as ReturnType<typeof vi.fn>).mockImplementation(
      (resolve: (v: unknown) => void) => { resolve(tableData[lastTable] || { data: [], error: null }); },
    );
  });

  it('shows empty state when no activities', async () => {
    render(<ActivityFeed noteId="note-1" />);
    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeInTheDocument();
    });
  });

  it('renders activity entries', async () => {
    tableData = {
      note_activity_log: {
        data: [
          {
            id: '1',
            note_id: 'note-1',
            user_id: 'u1',
            action_type: 'created',
            changes: null,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
      profile_public_view: {
        data: [{ id: 'u1', full_name: 'Mason Wells' }],
        error: null,
      },
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
    tableData = {
      note_activity_log: {
        data: [
          {
            id: '2',
            note_id: 'note-1',
            user_id: 'u1',
            action_type: 'updated',
            changes: null,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
      profile_public_view: {
        data: [{ id: 'u1', full_name: 'Test User' }],
        error: null,
      },
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

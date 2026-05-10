/**
 * CommentsSection.test.tsx — Tests for the comments section component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ── Chainable supabase query mock ──────────────────────────────────────────
let commentsData: unknown[] = [];
let profilesData: unknown[] = [];

function makeBuilder(resolveWith: () => { data: unknown[] | null; error: null }) {
  const b: Record<string, unknown> = {};
  b.select = vi.fn(() => b);
  b.order = vi.fn(() => b);
  b.limit = vi.fn(() => b);
  b.eq = vi.fn(() => b);
  b.is = vi.fn(() => b);
  b.in = vi.fn(() => b);
  b.insert = vi.fn().mockResolvedValue({ error: null });
  b.update = vi.fn(() => b);
  b.then = vi.fn((resolve: (v: unknown) => void) => {
    resolve(resolveWith());
  });
  return b;
}

vi.mock('../../lib/db', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'profiles' || table === 'profile_public_view') {
        return makeBuilder(() => ({ data: profilesData, error: null }));
      }
      // team_note_comments
      return makeBuilder(() => ({ data: commentsData, error: null }));
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  },
  checkMutationResult: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', full_name: 'Test User' },
  }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../../hooks/useRealtimeSubscription', () => ({
  useRealtimeComments: vi.fn(),
}));

import CommentsSection from './CommentsSection';

describe('CommentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commentsData = [];
    profilesData = [];
  });

  it('shows empty state when no comments', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
    });
  });

  it('renders Comments heading', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByText('Comments')).toBeInTheDocument();
    });
  });

  it('renders the comment textarea', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/write a comment/i)).toBeInTheDocument();
    });
  });

  it('renders Send button', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    });
  });

  it('Send button is disabled when textarea is empty', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      const sendBtn = screen.getByRole('button', { name: /send/i });
      expect(sendBtn).toBeDisabled();
    });
  });

  it('enables Send button when text is entered', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/write a comment/i)).toBeInTheDocument();
    });
    const textarea = screen.getByPlaceholderText(/write a comment/i);
    fireEvent.change(textarea, { target: { value: 'Hello world' } });
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect(sendBtn).not.toBeDisabled();
  });

  it('renders mention tip text', async () => {
    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByText(/use @name to mention/i)).toBeInTheDocument();
    });
  });

  it('renders comments when data is returned', async () => {
    commentsData = [
      {
        id: 'c1',
        note_id: 'note-1',
        parent_id: null,
        created_by: 'user-2',
        content: 'Great progress today!',
        mentions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      },
    ];
    // PR-07 follow-up: creator names now resolved via profile_public_view post-fetch.
    profilesData = [{ id: 'user-2', full_name: 'Jane Doe' }];

    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByText('Jane Doe')).toBeInTheDocument();
      expect(screen.getByText('Great progress today!')).toBeInTheDocument();
    });
  });

  it('shows comment count in heading when comments exist', async () => {
    commentsData = [
      {
        id: 'c1',
        note_id: 'note-1',
        parent_id: null,
        created_by: 'user-2',
        content: 'A comment',
        mentions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      },
    ];
    profilesData = [{ id: 'user-2', full_name: 'Someone' }];

    render(<CommentsSection noteId="note-1" noteTitle="Test Note" />);
    await waitFor(() => {
      expect(screen.getByText('Comments (1)')).toBeInTheDocument();
    });
  });
});

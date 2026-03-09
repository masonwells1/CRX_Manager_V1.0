/**
 * AuthContext.test.tsx — Tests for AuthProvider + useAuth
 *
 * Mocks Supabase auth methods (getSession, signInWithPassword, signOut,
 * onAuthStateChange) and the profiles query to test the full auth lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

// ── Mock Supabase (vi.hoisted to avoid hoisting issues) ──────────────────

const {
  mockGetSession,
  mockSignIn,
  mockSignOut,
  mockOnAuthStateChange,
  mockUnsubscribe,
  mockMaybeSingle: _mockMaybeSingle,
  mockFrom,
  triggerAuthChange,
} = vi.hoisted(() => {
  const mockUnsubscribe = vi.fn();
  let authChangeCallback: ((event: string, session: unknown) => void) | undefined;

  const mockGetSession = vi.fn().mockResolvedValue({
    data: { session: null },
    error: null,
  });
  const mockSignIn = vi.fn().mockResolvedValue({ data: {}, error: null });
  const mockSignOut = vi.fn().mockResolvedValue({ error: null });
  const mockOnAuthStateChange = vi.fn((cb: (event: string, session: unknown) => void) => {
    authChangeCallback = cb;
    return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
  });

  const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockEq = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
  const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });

  return {
    mockGetSession,
    mockSignIn,
    mockSignOut,
    mockOnAuthStateChange,
    mockUnsubscribe,
    mockMaybeSingle,
    mockFrom,
    triggerAuthChange: (event: string, session: unknown) => {
      authChangeCallback?.(event, session);
    },
  };
});

vi.mock('../lib/db', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      signInWithPassword: mockSignIn,
      signOut: mockSignOut,
      onAuthStateChange: mockOnAuthStateChange,
    },
    from: mockFrom,
  },
}));

import { AuthProvider, useAuth } from './AuthContext';

// ── Helpers ──────────────────────────────────────────────────────────────

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-123',
  email: 'test@example.com',
  full_name: 'Test User',
  role: 'admin',
  phone: null,
  is_active: true,
  denied_pages: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'user-123', email: 'test@example.com' },
  access_token: 'token-abc',
  ...overrides,
});

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/** Helper to mock the full Supabase from().select().eq().maybeSingle() chain */
function mockProfileQuery(result: { data: unknown; error: unknown }) {
  const mockMaybeSingleLocal = vi.fn().mockResolvedValue(result);
  const mockEqLocal = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingleLocal });
  const mockSelectLocal = vi.fn().mockReturnValue({ eq: mockEqLocal });
  mockFrom.mockReturnValue({ select: mockSelectLocal });
  return { mockMaybeSingle: mockMaybeSingleLocal };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no session, no profile
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockProfileQuery({ data: null, error: null });
  });

  // ── Initial State ────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with loading=true, session=null, profile=null', async () => {
      // Suppress act warnings — we intentionally read synchronous initial state
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderHook(() => useAuth(), { wrapper });
      expect(result.current.loading).toBe(true);
      expect(result.current.session).toBeNull();
      expect(result.current.profile).toBeNull();
      expect(result.current.role).toBeNull();
      expect(result.current.deniedPages).toEqual([]);
      consoleSpy.mockRestore();
      // Flush pending promises
      await act(async () => {});
    });
  });

  // ── Session Loading ──────────────────────────────────────────────────

  describe('session loading', () => {
    it('calls getSession on mount', async () => {
      renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });

    it('sets loading=false when no session exists', async () => {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      expect(result.current.loading).toBe(false);
      expect(result.current.session).toBeNull();
    });

    it('loads profile when session exists', async () => {
      const session = makeSession();
      const profile = makeProfile();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      expect(result.current.session).toBeTruthy();
      expect(result.current.profile?.full_name).toBe('Test User');
      expect(result.current.loading).toBe(false);
    });

    it('sets role from profile', async () => {
      const session = makeSession();
      const profile = makeProfile({ role: 'driver' });
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      expect(result.current.role).toBe('driver');
    });

    it('sets deniedPages from profile', async () => {
      const session = makeSession();
      const profile = makeProfile({ denied_pages: ['/reports', '/settings'] });
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      expect(result.current.deniedPages).toEqual(['/reports', '/settings']);
    });

    it('handles getSession network error gracefully', async () => {
      mockGetSession.mockRejectedValue(new Error('Network error'));
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});

      expect(result.current.loading).toBe(false);
      expect(result.current.session).toBeNull();
    });

    it('handles null profile (profile not found)', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: null, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      expect(result.current.profile).toBeNull();
      expect(result.current.role).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  // ── Auth State Change ────────────────────────────────────────────────

  describe('onAuthStateChange', () => {
    it('subscribes to auth state changes on mount', async () => {
      renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      expect(mockOnAuthStateChange).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes on unmount', async () => {
      const { unmount } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      unmount();
      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });

    it('sets session on SIGNED_IN event', async () => {
      const session = makeSession();
      const profile = makeProfile();
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});

      await act(async () => {
        triggerAuthChange('SIGNED_IN', session);
      });
      await act(async () => {});
      await act(async () => {});

      expect(result.current.session).toBeTruthy();
      expect(result.current.profile?.full_name).toBe('Test User');
    });

    it('clears session on SIGNED_OUT event', async () => {
      // Start with a session
      const session = makeSession();
      const profile = makeProfile();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      // Now trigger sign out
      await act(async () => {
        triggerAuthChange('SIGNED_OUT', null);
      });
      await act(async () => {});

      expect(result.current.session).toBeNull();
      expect(result.current.profile).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    it('updates session silently on TOKEN_REFRESHED (no loading flash)', async () => {
      // Start with a real session so we can verify loading stays false
      const session = makeSession();
      const profile = makeProfile();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      expect(result.current.loading).toBe(false);

      // Simulate a token refresh with a new access token
      const refreshedSession = makeSession({ access_token: 'new-token-xyz' });
      await act(async () => {
        triggerAuthChange('TOKEN_REFRESHED', refreshedSession);
      });

      // Session should update BUT loading should never have been set to true
      expect(result.current.session?.access_token).toBe('new-token-xyz');
      expect(result.current.loading).toBe(false);
      // Profile stays the same — no re-fetch needed for a token refresh
      expect(result.current.profile?.full_name).toBe('Test User');
    });

    it('skips INITIAL_SESSION (handled by getSession)', async () => {
      const session = makeSession();
      mockProfileQuery({ data: makeProfile(), error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});

      // Trigger INITIAL_SESSION — should be a no-op
      await act(async () => {
        triggerAuthChange('INITIAL_SESSION', session);
      });
      await act(async () => {});

      // Loading should still be false (not flipped to true)
      expect(result.current.loading).toBe(false);
    });
  });

  // ── signIn ───────────────────────────────────────────────────────────

  describe('signIn', () => {
    it('calls signInWithPassword with email and password', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});

      await act(async () => {
        await result.current.signIn('test@example.com', 'password123');
      });

      expect(mockSignIn).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'password123',
      });
    });

    it('returns error:null on success', async () => {
      mockSignIn.mockResolvedValue({ data: {}, error: null });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});

      let signInResult: { error: string | null } | undefined;
      await act(async () => {
        signInResult = await result.current.signIn('test@example.com', 'pass');
      });

      expect(signInResult?.error).toBeNull();
    });

    it('returns error message on failure', async () => {
      mockSignIn.mockResolvedValue({
        data: {},
        error: { message: 'Invalid login credentials' },
      });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});

      let signInResult: { error: string | null } | undefined;
      await act(async () => {
        signInResult = await result.current.signIn('bad@email.com', 'wrong');
      });

      expect(signInResult?.error).toBe('Invalid login credentials');
    });
  });

  // ── signOut ──────────────────────────────────────────────────────────

  describe('signOut', () => {
    it('calls supabase.auth.signOut', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});

      await act(async () => {
        await result.current.signOut();
      });

      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });

    it('clears profile and session immediately', async () => {
      // Start with a session
      const session = makeSession();
      const profile = makeProfile();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});
      expect(result.current.session).toBeTruthy();

      await act(async () => {
        await result.current.signOut();
      });

      expect(result.current.session).toBeNull();
      expect(result.current.profile).toBeNull();
    });

    it('handles signOut network error gracefully (still clears state)', async () => {
      mockSignOut.mockRejectedValue(new Error('Network error'));

      // Start with a session
      const session = makeSession();
      const profile = makeProfile();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      await act(async () => {
        await result.current.signOut();
      });

      // State should be cleared even though signOut threw
      expect(result.current.session).toBeNull();
      expect(result.current.profile).toBeNull();
    });
  });

  // ── fetchProfile retry logic ─────────────────────────────────────────

  describe('fetchProfile retry logic', () => {
    it('retries on profile fetch failure', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });

      // First two calls fail, third succeeds
      let callCount = 0;
      const mockMaybeSingleRetry = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({ data: null, error: { message: 'DB error' } });
        }
        return Promise.resolve({ data: makeProfile(), error: null });
      });
      const mockEqRetry = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingleRetry });
      const mockSelectRetry = vi.fn().mockReturnValue({ eq: mockEqRetry });
      mockFrom.mockReturnValue({ select: mockSelectRetry });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();
      const { result } = renderHook(() => useAuth(), { wrapper });

      // Flush getSession promise
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // First attempt fails, waits 1s
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      // Second attempt fails, waits 2s
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      // Third attempt succeeds
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(mockMaybeSingleRetry).toHaveBeenCalledTimes(3);
      expect(result.current.profile?.full_name).toBe('Test User');

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });

    it('sets profile=null after all retries exhausted', async () => {
      const session = makeSession();
      mockGetSession.mockResolvedValue({ data: { session }, error: null });

      const mockMaybeSingleFail = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB error' },
      });
      const mockEqFail = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingleFail });
      const mockSelectFail = vi.fn().mockReturnValue({ eq: mockEqFail });
      mockFrom.mockReturnValue({ select: mockSelectFail });

      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // 3 attempts (initial + 2 retries)
      expect(mockMaybeSingleFail).toHaveBeenCalledTimes(3);
      expect(result.current.profile).toBeNull();
      expect(result.current.loading).toBe(false);

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  // ── Role derivation ──────────────────────────────────────────────────

  describe('role derivation', () => {
    it('derives role from profile.role', async () => {
      const session = makeSession();
      const profile = makeProfile({ role: 'sales_rep' });
      mockGetSession.mockResolvedValue({ data: { session }, error: null });
      mockProfileQuery({ data: profile, error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});
      await act(async () => {});

      expect(result.current.role).toBe('sales_rep');
    });

    it('role is null when profile is null', async () => {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await act(async () => {});
      await act(async () => {});

      expect(result.current.role).toBeNull();
    });
  });
});

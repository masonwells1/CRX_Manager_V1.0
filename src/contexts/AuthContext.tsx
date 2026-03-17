import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { supabase } from '../lib/db';
import { setUserContext, clearUserContext } from '../lib/metrics';
import type { Profile, UserRole } from '../types';
import type { Session } from '@supabase/supabase-js';

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  role: UserRole | null;
  deniedPages: string[];
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  profile: null,
  role: null,
  deniedPages: [],
  loading: true,
  signIn: async () => ({ error: null }),
  signOut: async () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (userId: string, retries = 2) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (!error) {
        setProfile(data ?? null);
        if (data) setUserContext(data.id, data.role ?? 'unknown');
        return;
      }
      Sentry.captureException(new Error(error.message), { extra: { context: `Profile fetch attempt ${attempt + 1} failed` } });
      if (attempt < retries) {
        // Wait 1s before retry (doubles each attempt)
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // All retries exhausted — set null so ProtectedRoute can handle it
    setProfile(null);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) {
        fetchProfile(s.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    }).catch(() => {
      // Network error during initial session check — show login
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      // TOKEN_REFRESHED fires periodically and on tab-switch — never unmount the
      // page for it, otherwise the user loses all unsaved form data.
      if (event === 'TOKEN_REFRESHED') {
        setSession(s);
        return;
      }

      // INITIAL_SESSION is handled by getSession() above — skip the duplicate.
      if (event === 'INITIAL_SESSION') return;

      // SIGNED_IN / SIGNED_OUT — these are real auth changes that justify a
      // loading state because the user/role may be different.
      setLoading(true);
      setSession(s);
      if (s?.user) {
        (async () => {
          try {
            await fetchProfile(s.user.id);
          } finally {
            setLoading(false);
          }
        })();
      } else {
        setProfile(null);
        clearUserContext();
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    // Clear local state immediately so the UI goes to login
    clearUserContext();
    setProfile(null);
    setSession(null);
    try {
      await supabase.auth.signOut();
    } catch {
      // Offline or network error — local state is already cleared,
      // so user still gets redirected to login. Session cookie will
      // expire naturally on its own.
    }
  }, []);

  // Memoize the context value so child components only re-render when
  // actual auth data changes — not on every AuthProvider render.
  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      profile,
      role: profile?.role ?? null,
      deniedPages: profile?.denied_pages ?? [],
      loading,
      signIn,
      signOut,
    }),
    [session, profile, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sentry } from '../lib/sentry';
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

function profilesMatch(left: Profile | null, right: Profile | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.email === right.email &&
    left.full_name === right.full_name &&
    left.role === right.role &&
    left.phone === right.phone &&
    left.is_active === right.is_active &&
    left.applicator_license_number === right.applicator_license_number &&
    left.faa_certificate_number === right.faa_certificate_number &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    left.denied_pages.length === right.denied_pages.length &&
    left.denied_pages.every((page, index) => page === right.denied_pages[index])
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const activeUserIdRef = useRef<string | null>(null);
  const signedOutLocallyRef = useRef(false);

  const fetchProfile = async (userId: string, retries = 2, preserveExisting = false) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (!error) {
        // Ignore a response that finished after sign-out or a different user
        // took over the session.
        if (signedOutLocallyRef.current || activeUserIdRef.current !== userId) return;
        const nextProfile = (data as Profile | null) ?? null;
        setProfile((currentProfile) =>
          profilesMatch(currentProfile, nextProfile) ? currentProfile : nextProfile,
        );
        if (data) setUserContext(data.id, data.role ?? 'unknown');
        return;
      }
      Sentry.captureException(new Error(error.message), { extra: { context: `Profile fetch attempt ${attempt + 1} failed` } });
      if (attempt < retries) {
        // Wait 1s before retry (doubles each attempt)
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // Initial/auth-change failures must fail closed. A silent same-user refresh
    // keeps the existing profile so a brief network problem cannot erase forms.
    if (
      !preserveExisting &&
      !signedOutLocallyRef.current &&
      activeUserIdRef.current === userId
    ) {
      setProfile(null);
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      activeUserIdRef.current = s?.user.id ?? null;
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
      // INITIAL_SESSION is handled by getSession() above — skip the duplicate.
      if (event === 'INITIAL_SESSION') return;

      // If signOut failed because the network dropped, Supabase may still emit
      // a refresh for the stored session. Do not silently sign the user back in;
      // only an explicit signIn call clears this local sign-out intent.
      if (signedOutLocallyRef.current && event !== 'SIGNED_OUT') return;

      const nextUserId = s?.user.id ?? null;
      const isSameUser = nextUserId !== null && activeUserIdRef.current === nextUserId;
      activeUserIdRef.current = nextUserId;
      setSession(s);

      // Supabase may emit SIGNED_IN again when an existing session is
      // re-confirmed (including when a browser tab regains focus). Updating the
      // session is enough for the same user. Entering the loading state here
      // would make ProtectedRoute unmount the page and erase unsaved form data.
      if (isSameUser) {
        // Keep deactivation and page-permission changes timely without showing
        // the global loader. On failure, retain the last known profile.
        if (event === 'SIGNED_IN') void fetchProfile(nextUserId, 0, true);
        return;
      }

      if (s?.user) {
        // A genuinely different user signed in, so reload the authorization
        // profile while the previous user's page is hidden.
        setLoading(true);
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
    const wasSignedOutLocally = signedOutLocallyRef.current;
    signedOutLocallyRef.current = false;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      signedOutLocallyRef.current = wasSignedOutLocally;
      return { error: error.message };
    }
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    // Clear local state immediately so the UI goes to login
    clearUserContext();
    signedOutLocallyRef.current = true;
    activeUserIdRef.current = null;
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

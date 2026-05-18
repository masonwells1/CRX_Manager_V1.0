import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getPageKeyFromPath, hasPageAccess, isExemptRoute } from '../../lib/pagePermissions';
import type { UserRole } from '../../types';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: UserRole[];
}

export default function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { session, profile, deniedPages, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-crx-green" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  // Session exists but profile failed to load — block access
  if (!profile) {
    return <Navigate to="/login" replace />;
  }

  // T1-004: Deactivated users must be blocked even with valid JWT
  if (!profile.is_active) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/" replace />;
  }

  // Per-user page permission check (deny-list)
  const pageKey = getPageKeyFromPath(location.pathname);
  if (pageKey) {
    if (!hasPageAccess(profile.role, deniedPages, pageKey)) {
      return <Navigate to="/" replace />;
    }
  } else if (!isExemptRoute(location.pathname)) {
    // PR-11: a wrapped-in-ProtectedRoute path with no PAGE_PERMISSIONS entry
    // and not on the exempt list is a routing bug — the deny-list silently
    // does nothing for it. Fail-closed: redirect to dashboard. The
    // pagePermissions.test.ts coverage test catches this at build time.
    console.warn(
      `[ProtectedRoute] Path "${location.pathname}" has no PAGE_PERMISSIONS entry ` +
        `and is not in EXEMPT_ROUTE_SEGMENTS. Add an entry to src/lib/pagePermissions.ts.`,
    );
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getPageKeyFromPath, hasPageAccess } from '../../lib/pagePermissions';
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

  // T1-004: Deactivated users must be blocked even with valid JWT
  if (profile && !profile.is_active) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && profile && !allowedRoles.includes(profile.role)) {
    return <Navigate to="/" replace />;
  }

  // Per-user page permission check (deny-list)
  const pageKey = getPageKeyFromPath(location.pathname);
  if (pageKey && profile && !hasPageAccess(profile.role, deniedPages, pageKey)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

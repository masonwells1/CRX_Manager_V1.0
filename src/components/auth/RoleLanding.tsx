import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess } from '../../lib/pagePermissions';

/**
 * Role-based landing for "/". The root route is deliberately redirect-only:
 * office users begin on Today, while phone roles begin on their daily screen.
 * Check the deny-list here: ProtectedRoute redirects denied pages back to "/"
 * (Codex U12 P2), so an unchecked landing target would create a redirect loop.
 */
export default function RoleLanding() {
  const { profile, deniedPages } = useAuth();
  const role = profile?.role;

  if (role === 'driver' && hasPageAccess(role, deniedPages, 'my-route')) {
    return <Navigate to="/my-route" replace />;
  }
  if (role === 'applicator' && hasPageAccess(role, deniedPages, 'field')) {
    return <Navigate to="/field" replace />;
  }
  if ((role === 'admin' || role === 'sales_rep') && hasPageAccess(role, deniedPages, 'office-cockpit')) {
    return <Navigate to="/office-cockpit" replace />;
  }

  // Team Board is all-role and exempt from the deny-list, so this fallback cannot loop.
  return <Navigate to="/team-board" replace />;
}

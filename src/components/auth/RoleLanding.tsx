import { useAuth } from '../../contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { hasPageAccess } from '../../lib/pagePermissions';

/**
 * Role-based landing for "/" (U12 — applicator "My Day" rebuild).
 *
 * Office roles (admin/sales_rep) keep the existing Dashboard — pass it in as
 * `officeElement` so App.tsx keeps full control of its lazy-loading (this
 * component must NOT import Dashboard directly, which would defeat the
 * `lazy()` split — CLAUDE.md rule "Lazy-load all pages").
 *
 * A driver's primary job is running today's delivery route, so "/" now sends
 * them straight to /my-route instead of the office Dashboard. An applicator's
 * primary job is running today's field jobs, so "/" sends them to /field
 * (FieldView / "My Day"). Both routes were already reachable via direct nav
 * for these roles (App.tsx allowedRoles already include them) — this only
 * changes what "/" resolves to, so they aren't dropped on an office screen
 * with mostly-inaccessible links every time they open the app.
 *
 * Deny-list guard (Codex U12 P2): the target page can be in the profile's
 * denied_pages (an admin can deny 'my-route' to a driver / 'field' to an
 * applicator). Redirecting there anyway would bounce off ProtectedRoute's
 * hasPageAccess check back to "/" — an infinite redirect loop. So this
 * component runs the SAME hasPageAccess(role, deniedPages, pageKey) check
 * ProtectedRoute uses (identical helper, identical page keys), and falls back
 * to the office Dashboard when the role's landing page is denied.
 *
 * This component is mounted UNDER the existing <ProtectedRoute> (no
 * allowedRoles — every authenticated role reaches "/"), which already blocks
 * on `loading`/`!session`/`!profile` before rendering its children — so by
 * the time RoleLanding renders, `profile` is guaranteed non-null.
 */
export default function RoleLanding({ officeElement }: { officeElement: ReactNode }) {
  const { profile, deniedPages } = useAuth();
  if (profile?.role === 'driver' && hasPageAccess(profile.role, deniedPages, 'my-route')) {
    return <Navigate to="/my-route" replace />;
  }
  if (profile?.role === 'applicator' && hasPageAccess(profile.role, deniedPages, 'field')) {
    return <Navigate to="/field" replace />;
  }
  return <>{officeElement}</>;
}

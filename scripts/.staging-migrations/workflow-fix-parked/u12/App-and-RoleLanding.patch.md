# New file: src/components/auth/RoleLanding.tsx

Verified live: NOTHING today redirects a driver or applicator away from the
office Dashboard at `/`. `App.tsx`'s index route is a bare
`{ index: true, element: <Dashboard /> }` with no role check; `Dashboard.tsx`'s
`isDriver`/`showFull` (lines 380-382) only HIDE some office widgets FOR a
driver who is already looking at the Dashboard — they do not redirect. Grepping
the whole `src/` tree for `role === 'driver'` / `role === 'applicator'` found
no `navigate('/my-route')` / `navigate('/field')` anywhere. So the report's
citation of "Dashboard.tsx:381-382 sends applicators to office dashboard" is
inaccurate (that code doesn't send anyone anywhere) — but the underlying
finding (applicators land on an office-oriented screen with links they mostly
can't use) is real and verified. This is a NEW file, not a patch.

```typescript
import { useAuth } from '../../contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';

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
 * This component is mounted UNDER the existing <ProtectedRoute> (no
 * allowedRoles — every authenticated role reaches "/"), which already blocks
 * on `loading`/`!session`/`!profile` before rendering its children — so by
 * the time RoleLanding renders, `profile` is guaranteed non-null.
 */
export default function RoleLanding({ officeElement }: { officeElement: ReactNode }) {
  const { profile } = useAuth();
  if (profile?.role === 'driver') return <Navigate to="/my-route" replace />;
  if (profile?.role === 'applicator') return <Navigate to="/field" replace />;
  return <>{officeElement}</>;
}
```

---

# Patch: src/App.tsx

## 1) Import (near the other auth component imports, line ~9)

```diff
 import ProtectedRoute from './components/auth/ProtectedRoute';
+import RoleLanding from './components/auth/RoleLanding';
 import AppLayout from './components/layout/AppLayout';
```

## 2) Index route (line 186)

Old:
```typescript
          { index: true, element: <Dashboard /> },
```

New:
```typescript
          { index: true, element: <RoleLanding officeElement={<Dashboard />} /> },
```

`Dashboard` stays the exact same lazy-imported const from the top of App.tsx
(`const Dashboard = lazy(() => import('./pages/Dashboard'));`, line 16) — only
WHERE it's rendered changes, not how it's loaded. Its own `<Suspense>` boundary
is `<RouteShell>` (the parent route, unchanged), so the lazy-load fallback
still applies identically to the office path.

No other route changes. `/my-route` and `/field` already allow `driver` /
`applicator` respectively (verified live in App.tsx lines 262-263 and 270) —
this patch only adds a REDIRECT into paths that were already reachable.

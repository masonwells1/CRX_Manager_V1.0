import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';

// Mock the AuthContext
const mockAuth = {
  session: null as any,
  profile: null as any,
  role: null as any,
  loading: false,
  signIn: vi.fn(),
  signOut: vi.fn(),
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

function renderWithRouter(ui: React.ReactElement, { route = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      {ui}
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  it('shows loading spinner when auth is loading', () => {
    mockAuth.loading = true;
    mockAuth.session = null;
    mockAuth.profile = null;

    const { container } = renderWithRouter(
      <ProtectedRoute><div>Content</div></ProtectedRoute>
    );

    const spinner = container.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
    expect(screen.queryByText('Content')).not.toBeInTheDocument();

    mockAuth.loading = false;
  });

  it('redirects to /login when no session', () => {
    mockAuth.loading = false;
    mockAuth.session = null;
    mockAuth.profile = null;

    renderWithRouter(
      <ProtectedRoute><div>Protected</div></ProtectedRoute>
    );

    // Navigate component renders nothing visible; the child shouldn't render
    expect(screen.queryByText('Protected')).not.toBeInTheDocument();
  });

  it('renders children when session exists and no role restriction', () => {
    mockAuth.loading = false;
    mockAuth.session = { user: { id: '123' } };
    mockAuth.profile = { id: '123', role: 'admin', is_active: true };

    renderWithRouter(
      <ProtectedRoute><div>Protected Content</div></ProtectedRoute>
    );

    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });

  it('renders children when user role is in allowedRoles', () => {
    mockAuth.loading = false;
    mockAuth.session = { user: { id: '123' } };
    mockAuth.profile = { id: '123', role: 'admin', is_active: true };

    renderWithRouter(
      <ProtectedRoute allowedRoles={['admin', 'sales_rep']}>
        <div>Admin Only</div>
      </ProtectedRoute>
    );

    expect(screen.getByText('Admin Only')).toBeInTheDocument();
  });

  it('redirects when user role is NOT in allowedRoles', () => {
    mockAuth.loading = false;
    mockAuth.session = { user: { id: '123' } };
    mockAuth.profile = { id: '123', role: 'driver', is_active: true };

    renderWithRouter(
      <ProtectedRoute allowedRoles={['admin']}>
        <div>Admin Only</div>
      </ProtectedRoute>
    );

    expect(screen.queryByText('Admin Only')).not.toBeInTheDocument();
  });

  it('redirects deactivated users to /login (T1-004)', () => {
    mockAuth.loading = false;
    mockAuth.session = { user: { id: '123' } };
    mockAuth.profile = { id: '123', role: 'admin', is_active: false };

    renderWithRouter(
      <ProtectedRoute><div>Content</div></ProtectedRoute>
    );

    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });
});

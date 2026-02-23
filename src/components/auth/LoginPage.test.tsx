import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from './LoginPage';

const mockSignIn = vi.fn();
const mockNavigate = vi.fn();
let mockSession: { user: { id: string } } | null = null;

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    signIn: mockSignIn,
    session: mockSession,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <LoginPage />
    </MemoryRouter>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = null;
  });

  it('renders the login form', () => {
    renderLogin();
    expect(screen.getByLabelText('Email Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });

  it('renders welcome heading', () => {
    renderLogin();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  it('submits form and navigates on successful login', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    renderLogin();

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'test@test.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByText('Sign In'));

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith('test@test.com', 'password123');
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('shows error message on failed login', async () => {
    mockSignIn.mockResolvedValue({ error: 'Invalid credentials' });
    renderLogin();

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'bad@test.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByText('Sign In'));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  it('disables submit button while loading', async () => {
    // Make signIn hang
    mockSignIn.mockReturnValue(new Promise(() => {}));
    renderLogin();

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'test@test.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'pass' },
    });
    fireEvent.click(screen.getByText('Sign In'));

    await waitFor(() => {
      const submitBtn = screen.getByRole('button', { name: '' });
      expect(submitBtn).toBeDisabled();
    });
  });

  it('redirects to / if already has session', () => {
    mockSession = { user: { id: '123' } };
    renderLogin();
    // LoginPage returns <Navigate to="/" /> so the form shouldn't render
    expect(screen.queryByLabelText('Email Address')).not.toBeInTheDocument();
  });
});

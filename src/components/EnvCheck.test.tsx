import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EnvErrorScreen } from './EnvCheck';

// Note: checkEnvVars uses import.meta.env which is hard to mock in vitest,
// so we test the EnvErrorScreen component directly.

describe('EnvErrorScreen', () => {
  it('renders configuration error heading', () => {
    render(<EnvErrorScreen missing={['VITE_SUPABASE_URL']} />);
    expect(screen.getByText('Configuration Error')).toBeInTheDocument();
  });

  it('renders the missing variable names', () => {
    render(<EnvErrorScreen missing={['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']} />);
    expect(screen.getByText('VITE_SUPABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('VITE_SUPABASE_ANON_KEY')).toBeInTheDocument();
  });

  it('shows the "Missing variables" label', () => {
    render(<EnvErrorScreen missing={['VITE_SUPABASE_URL']} />);
    expect(screen.getByText('Missing variables:')).toBeInTheDocument();
  });

  it('shows fix instructions', () => {
    render(<EnvErrorScreen missing={['VITE_SUPABASE_URL']} />);
    expect(screen.getByText('How to fix this:')).toBeInTheDocument();
    expect(screen.getByText('Restart the development server')).toBeInTheDocument();
  });

  it('links to Supabase dashboard', () => {
    render(<EnvErrorScreen missing={['VITE_SUPABASE_URL']} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://supabase.com/dashboard');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders only the provided missing variables', () => {
    const { container } = render(<EnvErrorScreen missing={['VITE_SUPABASE_URL']} />);
    const listItems = container.querySelectorAll('li.font-mono');
    expect(listItems).toHaveLength(1);
  });
});

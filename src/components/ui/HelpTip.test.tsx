import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HelpTip from './HelpTip';

describe('HelpTip', () => {
  it('renders the help icon', () => {
    render(<HelpTip text="Test tip" />);
    expect(screen.getByRole('button', { name: /help/i })).toBeInTheDocument();
  });

  it('shows tip text when clicked', () => {
    render(<HelpTip text="Test tip content" />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getByText('Test tip content')).toBeInTheDocument();
  });

  it('hides tip when clicked again', () => {
    render(<HelpTip text="Test tip content" />);
    const btn = screen.getByRole('button', { name: /help/i });
    fireEvent.click(btn);
    expect(screen.getByText('Test tip content')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText('Test tip content')).not.toBeInTheDocument();
  });
});

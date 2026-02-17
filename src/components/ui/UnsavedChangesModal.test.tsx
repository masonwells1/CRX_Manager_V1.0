import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UnsavedChangesModal from './UnsavedChangesModal';

describe('UnsavedChangesModal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <UnsavedChangesModal open={false} onStay={() => {}} onLeave={() => {}} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders modal content when open', () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
    expect(screen.getByText(/unsaved changes that will be lost/i)).toBeInTheDocument();
  });

  it('has role="alertdialog" and aria-modal="true"', () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('shows Leave and Stay buttons', () => {
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={() => {}} />
    );
    expect(screen.getByText('Leave')).toBeInTheDocument();
    expect(screen.getByText('Stay')).toBeInTheDocument();
  });

  it('calls onLeave when Leave button is clicked', () => {
    const onLeave = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={() => {}} onLeave={onLeave} />
    );
    fireEvent.click(screen.getByText('Leave'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('calls onStay when Stay button is clicked', () => {
    const onStay = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={onStay} onLeave={() => {}} />
    );
    fireEvent.click(screen.getByText('Stay'));
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it('calls onStay when Escape key is pressed', () => {
    const onStay = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={onStay} onLeave={() => {}} />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it('calls onStay when backdrop is clicked', () => {
    const onStay = vi.fn();
    render(
      <UnsavedChangesModal open={true} onStay={onStay} onLeave={() => {}} />
    );
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onStay).toHaveBeenCalledTimes(1);
  });
});

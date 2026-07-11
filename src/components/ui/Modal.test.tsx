import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Modal from './Modal';

describe('Modal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Test">
        Content
      </Modal>
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders content when open is true', () => {
    render(
      <Modal open={true} onClose={() => {}} title="Test Modal">
        <p>Modal content here</p>
      </Modal>
    );
    expect(screen.getByText('Modal content here')).toBeInTheDocument();
  });

  it('uses a full-height mobile panel with a scrollable body and sticky footer', () => {
    window.innerWidth = 375;
    render(
      <Modal
        open={true}
        onClose={() => {}}
        title="Mobile Modal"
        footer={<button type="button">Save</button>}
      >
        <p>Scrollable content</p>
      </Modal>
    );

    const panel = document.querySelector('[data-modal-panel]');
    const body = document.querySelector('[data-modal-body]');
    const footer = document.querySelector('[data-modal-footer]');

    expect(panel).toHaveClass('h-[100dvh]', 'max-w-full', 'md:h-auto');
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(footer).toHaveClass('sticky', 'shrink-0', 'pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });

  it('renders the title', () => {
    render(
      <Modal open={true} onClose={() => {}} title="My Title">
        Content
      </Modal>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders the accent text after the title', () => {
    render(
      <Modal open={true} onClose={() => {}} title="My" accent="Title">
        Content
      </Modal>
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>
    );

    const closeButton = screen.getByLabelText('Close');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>
    );

    // The backdrop has aria-hidden="true"
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has role="dialog" and aria-modal="true"', () => {
    render(
      <Modal open={true} onClose={() => {}} title="Accessible">
        Content
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('sets body overflow to hidden when open', () => {
    render(
      <Modal open={true} onClose={() => {}} title="Test">
        Content
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores body overflow when closed', () => {
    const { rerender } = render(
      <Modal open={true} onClose={() => {}} title="Test">
        Content
      </Modal>
    );

    rerender(
      <Modal open={false} onClose={() => {}} title="Test">
        Content
      </Modal>
    );

    expect(document.body.style.overflow).toBe('');
  });
});

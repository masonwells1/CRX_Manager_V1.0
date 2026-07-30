import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RecordVersionConflictDialog from './RecordVersionConflictDialog';

describe('RecordVersionConflictDialog (used by QuoteBuilder and CustomerDetail)', () => {
  it.each(['quote', 'customer'] as const)('offers the %s reload without retrying its stale save', (entityLabel) => {
    const keepEditing = vi.fn();
    const reload = vi.fn().mockResolvedValue(true);
    render(<RecordVersionConflictDialog open entityLabel={entityLabel} onKeepEditing={keepEditing} onReload={reload} />);
    const reloadLabel = `Reload ${entityLabel === 'quote' ? 'Quote' : 'Customer'}`;

    expect(screen.getByRole('dialog')).toHaveTextContent('needs a refresh before saving');
    expect(screen.getByRole('dialog')).toHaveTextContent('may have changed in another workflow');
    fireEvent.click(screen.getByText('Keep editing'));
    expect(keepEditing).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(reloadLabel));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps both actions full-width and touch-sized for phone layouts', () => {
    const { container } = render(<RecordVersionConflictDialog open entityLabel="quote" onKeepEditing={vi.fn()} onReload={vi.fn().mockResolvedValue(true)} />);
    expect(container.querySelector('[data-modal-panel]')?.className).toContain('max-w-full');
    for (const label of ['Keep editing', 'Reload Quote']) {
      const button = screen.getByText(label).closest('button');
      expect(button?.className).toContain('min-h-11');
      expect(button?.className).toContain('w-full');
    }
  });

  it('keeps the dialog open and surfaces an asynchronous reload rejection', async () => {
    render(<RecordVersionConflictDialog
      open
      entityLabel="customer"
      onKeepEditing={vi.fn()}
      onReload={vi.fn().mockRejectedValue(new Error('offline'))}
    />);

    fireEvent.click(screen.getByText('Reload Customer'));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Reload could not finish'));
    expect(screen.getByRole('button', { name: 'Reload Customer' })).toBeEnabled();
  });

  it('blocks every close path while reloading and treats a false reload result as failure', async () => {
    let finishReload!: (value: boolean) => void;
    const keepEditing = vi.fn();
    const reload = vi.fn(() => new Promise<boolean>((resolve) => { finishReload = resolve; }));
    const { container } = render(
      <RecordVersionConflictDialog
        open
        entityLabel="quote"
        onKeepEditing={keepEditing}
        onReload={reload}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload Quote' }));
    expect(screen.getByRole('button', { name: 'Reload Quote' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(container.querySelector('[aria-hidden="true"]') as HTMLElement);
    expect(keepEditing).not.toHaveBeenCalled();

    await act(async () => { finishReload(false); });
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Reload could not finish'));
    expect(screen.getByRole('button', { name: 'Reload Quote' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeEnabled();
  });
});

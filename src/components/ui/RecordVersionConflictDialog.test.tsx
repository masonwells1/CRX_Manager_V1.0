import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RecordVersionConflictDialog from './RecordVersionConflictDialog';

describe('RecordVersionConflictDialog (used by QuoteBuilder and CustomerDetail)', () => {
  it.each(['quote', 'customer'] as const)('offers the %s reload without retrying its stale save', (entityLabel) => {
    const keepEditing = vi.fn();
    const reload = vi.fn();
    render(<RecordVersionConflictDialog open entityLabel={entityLabel} onKeepEditing={keepEditing} onReload={reload} />);
    const reloadLabel = `Reload ${entityLabel === 'quote' ? 'Quote' : 'Customer'}`;

    expect(screen.getByRole('dialog')).toHaveTextContent('changed in another tab');
    fireEvent.click(screen.getByText('Keep editing'));
    expect(keepEditing).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(reloadLabel));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps both actions reachable at phone width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const { container } = render(<RecordVersionConflictDialog open entityLabel="quote" onKeepEditing={vi.fn()} onReload={vi.fn()} />);
    expect(container.querySelector('[data-modal-panel]')?.className).toContain('max-w-full');
    for (const label of ['Keep editing', 'Reload Quote']) {
      const button = screen.getByText(label).closest('button');
      expect(button?.className).toContain('min-h-11');
      expect(button?.className).toContain('w-full');
    }
  });
});

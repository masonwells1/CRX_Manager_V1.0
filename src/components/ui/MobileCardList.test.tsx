import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MobileCardList from './MobileCardList';

describe('MobileCardList', () => {
  it('renders tappable 44px cards at a narrow viewport and preserves the desktop slot for md+', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const onRowClick = vi.fn();

    render(
      <MobileCardList
        rows={[{ id: 'job-1', customer: 'Acme Acres' }]}
        getRowKey={(row) => row.id}
        getRowLabel={(row) => `Open ${row.customer}`}
        onRowClick={onRowClick}
        renderCard={(row) => <span>{row.customer}</span>}
        desktop={<table><tbody><tr><td>Desktop table</td></tr></tbody></table>}
      />,
    );

    const card = screen.getByRole('button', { name: 'Open Acme Acres' });
    expect(card).toHaveClass('min-h-[44px]');
    expect(card.parentElement).toHaveClass('md:hidden');
    expect(screen.getByText('Desktop table').parentElement?.parentElement?.parentElement?.parentElement).toHaveClass('md:block');

    fireEvent.click(card);
    expect(onRowClick).toHaveBeenCalledWith({ id: 'job-1', customer: 'Acme Acres' });
  });
});

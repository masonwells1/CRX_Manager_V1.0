import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import JobTagChip from './JobTagChip';

describe('JobTagChip', () => {
  it('renders the tag name', () => {
    render(<JobTagChip tag={{ name: 'Fungicide', color: '#10b981' }} />);
    expect(screen.getByText('Fungicide')).toBeInTheDocument();
  });

  it('uses the tag color for its text + tint (per-tag color)', () => {
    render(<JobTagChip tag={{ name: 'Y-Drop', color: '#3b82f6' }} />);
    const chip = screen.getByText('Y-Drop');
    // text color is the tag color; background is the same hue at low alpha
    expect(chip.style.color).toBe('rgb(59, 130, 246)');
    expect(chip.style.backgroundColor).toContain('rgba(59, 130, 246');
  });

  it('shows a remove button only when onRemove is provided', () => {
    const onRemove = vi.fn();
    const { rerender } = render(<JobTagChip tag={{ name: 'Pre-Emerge', color: '#ef4444' }} />);
    expect(screen.queryByLabelText('Remove Pre-Emerge')).not.toBeInTheDocument();

    rerender(<JobTagChip tag={{ name: 'Pre-Emerge', color: '#ef4444' }} onRemove={onRemove} />);
    const btn = screen.getByLabelText('Remove Pre-Emerge');
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

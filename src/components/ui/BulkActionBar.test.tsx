import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BulkActionBar, { type BulkAction } from './BulkActionBar';

const mockActions: BulkAction[] = [
  { key: 'csv', label: 'Export CSV', icon: <span data-testid="csv-icon" />, onClick: vi.fn() },
  { key: 'pdf', label: 'Download PDF', icon: <span data-testid="pdf-icon" />, onClick: vi.fn() },
  { key: 'delete', label: 'Delete', icon: <span data-testid="del-icon" />, onClick: vi.fn(), variant: 'danger' },
];

describe('BulkActionBar', () => {
  it('renders nothing when selectedCount is 0', () => {
    const { container } = render(
      <BulkActionBar selectedCount={0} actions={mockActions} onDeselectAll={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders selection count badge', () => {
    render(
      <BulkActionBar selectedCount={5} actions={mockActions} onDeselectAll={vi.fn()} />
    );
    expect(screen.getByText('5 selected')).toBeInTheDocument();
  });

  it('renders all action buttons', () => {
    render(
      <BulkActionBar selectedCount={3} actions={mockActions} onDeselectAll={vi.fn()} />
    );
    expect(screen.getByText('Export CSV')).toBeInTheDocument();
    expect(screen.getByText('Download PDF')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls action onClick when button is clicked', () => {
    render(
      <BulkActionBar selectedCount={2} actions={mockActions} onDeselectAll={vi.fn()} />
    );
    fireEvent.click(screen.getByText('Export CSV'));
    expect(mockActions[0].onClick).toHaveBeenCalledTimes(1);
  });

  it('calls onDeselectAll when Deselect is clicked', () => {
    const onDeselect = vi.fn();
    render(
      <BulkActionBar selectedCount={3} actions={mockActions} onDeselectAll={onDeselect} />
    );
    fireEvent.click(screen.getByText('Deselect'));
    expect(onDeselect).toHaveBeenCalledTimes(1);
  });

  it('shows singular count correctly', () => {
    render(
      <BulkActionBar selectedCount={1} actions={mockActions} onDeselectAll={vi.fn()} />
    );
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

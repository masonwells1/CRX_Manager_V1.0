import { type ReactNode } from 'react';
import { X } from 'lucide-react';
import Button from './Button';
import Badge from './Badge';

export interface BulkAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}

interface BulkActionBarProps {
  selectedCount: number;
  actions: BulkAction[];
  onDeselectAll: () => void;
}

/**
 * Inline action bar that appears when items are selected in a DataTable.
 * Shows selection count + action buttons. Slots into page header area.
 */
export default function BulkActionBar({ selectedCount, actions, onDeselectAll }: BulkActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Badge variant="info" size="md">
        {selectedCount} selected
      </Badge>
      <button
        onClick={onDeselectAll}
        className="inline-flex items-center gap-1 text-xs text-secondary hover:text-nav-dark transition-colors"
      >
        <X className="w-3.5 h-3.5" />
        Deselect
      </button>
      <div className="w-px h-5 bg-gray-200 mx-1" />
      {actions.map((action) => (
        <Button
          key={action.key}
          variant={action.variant || 'secondary'}
          size="sm"
          icon={action.icon}
          onClick={action.onClick}
          loading={action.loading}
          disabled={action.disabled}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

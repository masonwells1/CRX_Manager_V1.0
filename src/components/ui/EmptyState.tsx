import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        {icon || <Inbox className="w-6 h-6 text-gray-400" />}
      </div>
      <h3 className="text-base font-semibold text-nav-dark mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-secondary mb-4 text-center max-w-sm">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}

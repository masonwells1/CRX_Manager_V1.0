import type { ReactNode } from 'react';

export type BadgeVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'danger';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-200',
  success: 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200',
  warning: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200',
  error: 'bg-red-100 text-red-800 ring-1 ring-inset ring-red-200',
  info: 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200',
  draft: 'bg-gray-100 text-gray-700 ring-1 ring-inset ring-gray-200',
  sent: 'bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-200',
  accepted: 'bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-200',
  declined: 'bg-red-100 text-red-800 ring-1 ring-inset ring-red-200',
  expired: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200',
  danger: 'bg-red-100 text-red-800 ring-1 ring-inset ring-red-200',
};

// eslint-disable-next-line react-refresh/only-export-components
export const statusToBadgeVariant: Record<string, BadgeVariant> = {
  draft: 'draft',
  sent: 'sent',
  revised: 'info',
  accepted: 'accepted',
  declined: 'declined',
  expired: 'expired',
  confirmed: 'success',
  partially_fulfilled: 'warning',
  fulfilled: 'success',
  cancelled: 'error',
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  submitted: 'info',
  partially_received: 'warning',
  fully_received: 'success',
  pending: 'warning',
  paid: 'success',
  overdue: 'error',
  posted: 'success',
  unposted: 'warning',
  voided: 'error',
  invoiced: 'success',
  requested: 'warning',
  approved: 'info',
  received: 'info',
  credited: 'success',
  rejected: 'error',
  unpaid: 'warning',
  partially_paid: 'info',
};

export default function Badge({ variant = 'default', children, size = 'sm', className = '' }: BadgeProps) {
  return (
    <span
      className={`
        inline-flex items-center font-medium rounded-full capitalize
        ${variantClasses[variant]}
        ${size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'}
        ${className}
      `}
    >
      {children}
    </span>
  );
}

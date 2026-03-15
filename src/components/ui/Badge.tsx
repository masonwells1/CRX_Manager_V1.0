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
  default: 'bg-gray-100 text-gray-700',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
  draft: 'bg-gray-100 text-gray-600',
  sent: 'bg-blue-50 text-blue-700',
  accepted: 'bg-emerald-50 text-emerald-700',
  declined: 'bg-red-50 text-red-700',
  expired: 'bg-orange-50 text-orange-700',
  danger: 'bg-red-50 text-red-700',
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

import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: boolean;
  hover?: boolean;
}

export default function Card({
  children,
  padding = true,
  hover = false,
  className = '',
  ...props
}: CardProps) {
  return (
    <div
      className={`
        bg-white rounded-xl border border-gray-200 shadow-card
        ${hover ? 'transition-shadow duration-200 hover:shadow-card-hover' : ''}
        ${padding ? 'p-5' : ''}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  accent?: string;
  action?: ReactNode;
}

export function CardHeader({ title, accent, action }: CardHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-semibold font-heading text-nav-dark">
        {title}
        {accent && <span className="split-heading-accent"> {accent}</span>}
      </h3>
      {action}
    </div>
  );
}

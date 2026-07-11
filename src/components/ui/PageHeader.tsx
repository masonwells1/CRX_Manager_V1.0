import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  accent?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

/**
 * Single page-title component for office pages, built on the SplitHeading
 * brand motif (Barlow Semi Condensed heading + crx-green accent word).
 * Pure presentational shell — pages keep their own data/handlers below it.
 */
export default function PageHeader({ title, accent, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
      <div>
        <h1 className="text-2xl font-semibold font-heading text-nav-dark">
          {title}
          {accent && (
            <>
              {' '}
              <span className="split-heading-accent">{accent}</span>
            </>
          )}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </header>
  );
}

import type { ReactNode } from 'react';

interface MobileCardListProps<T> {
  /** The same filtered/sorted rows used by the desktop representation. */
  rows: readonly T[];
  /** Stable key for each row. */
  getRowKey: (row: T) => string;
  /** Short accessible description of what opening the card will do. */
  getRowLabel: (row: T) => string;
  /** Mobile-only card contents. Keep interactive controls in the detail view. */
  renderCard: (row: T) => ReactNode;
  /** The existing desktop table or board. It is not changed by this primitive. */
  desktop: ReactNode;
  /** Mirrors the desktop row action. */
  onRowClick: (row: T) => void;
  /** Lets a screen retain its own visual system (for example Dispatch's dark cards). */
  cardClassName?: string;
  className?: string;
}

/**
 * Presents a data set as full-width, tappable cards below Tailwind's `md`
 * breakpoint, while leaving the supplied desktop representation untouched.
 */
export default function MobileCardList<T>({
  rows,
  getRowKey,
  getRowLabel,
  renderCard,
  desktop,
  onRowClick,
  cardClassName = '',
  className = '',
}: MobileCardListProps<T>) {
  return (
    <>
      <div className={`space-y-3 md:hidden ${className}`.trim()}>
        {rows.map((row) => (
          <button
            key={getRowKey(row)}
            type="button"
            onClick={() => onRowClick(row)}
            aria-label={getRowLabel(row)}
            className={`block min-h-[44px] w-full rounded-xl border border-gray-200 bg-white p-4 text-left shadow-card transition-colors hover:bg-crx-green-tint focus:outline-none focus:ring-2 focus:ring-crx-green/40 ${cardClassName}`}
          >
            {renderCard(row)}
          </button>
        ))}
      </div>
      <div className="hidden md:block">{desktop}</div>
    </>
  );
}

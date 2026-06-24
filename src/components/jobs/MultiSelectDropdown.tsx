import { Check, X } from 'lucide-react';

/**
 * Field-app parity #6: a compact checkbox multi-select used across the job-list
 * filter bar (Customers, Applicators, Vehicles, Type, Ground Crew, Status). It
 * matches the `<details>` dropdown pattern introduced for the Job Tags filter in
 * #4 — no new dependency, Tailwind + Lucide only. Built to stay usable with many
 * options (scrollable body, inline clear).
 *
 * Shared by the filter bar today and available to #3 (batches) / #7 (mass-edit)
 * which also drive multi-selection off the same list.
 */
export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional swatch color (e.g. a tag/status color) shown before the label. */
  color?: string;
}

interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Shown when nothing is selected. */
  placeholder?: string;
  /** Empty-list message. */
  emptyText?: string;
  /** Width class for the trigger (defaults to a sensible min). */
  triggerClassName?: string;
}

export default function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  placeholder = 'All',
  emptyText = 'No options',
  triggerClassName = 'min-w-[10rem]',
}: MultiSelectDropdownProps) {
  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  const summaryText =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? `${selected.length} selected`
        : `${selected.length} selected`;

  return (
    <div>
      <label className="block text-xs font-medium text-secondary mb-1">{label}</label>
      <details className="relative group">
        <summary
          className={`flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg cursor-pointer list-none hover:border-crx-green ${triggerClassName}`}
        >
          <span className={selected.length === 0 ? 'text-secondary' : 'text-nav-dark'}>
            {summaryText}
          </span>
        </summary>
        <div className="absolute z-20 mt-1 w-56 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg p-2 space-y-0.5">
          {options.length === 0 ? (
            <p className="text-xs text-secondary px-2 py-3 text-center">{emptyText}</p>
          ) : (
            <>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-secondary hover:bg-gray-50 rounded"
                >
                  <X className="w-3 h-3" /> Clear
                </button>
              )}
              {options.map((o) => {
                const checked = selected.includes(o.value);
                return (
                  <label
                    key={o.value}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.value)}
                      className="rounded border-gray-300 text-crx-green focus:ring-crx-green/30"
                    />
                    {o.color && (
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: o.color }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="text-sm text-nav-dark flex-1">{o.label}</span>
                    {checked && <Check className="w-3.5 h-3.5 text-crx-green flex-shrink-0" />}
                  </label>
                );
              })}
            </>
          )}
        </div>
      </details>
    </div>
  );
}

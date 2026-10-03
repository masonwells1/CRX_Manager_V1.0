import { useEffect, useRef, useState, useCallback } from 'react';

interface ComboboxProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  className?: string;
}

export default function Combobox({
  label,
  value,
  onChange,
  options,
  placeholder = '',
  disabled = false,
  error = '',
  className = '',
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputId = label?.toLowerCase().replace(/\s+/g, '-');

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(value.toLowerCase())
  );

  // Close on outside click
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [value]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      const item = listRef.current.children[highlightIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightIndex]);

  const selectOption = useCallback(
    (opt: string) => {
      onChange(opt);
      setOpen(false);
      setHighlightIndex(-1);
    },
    [onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!open) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIndex((i) => (i > 0 ? i - 1 : filtered.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < filtered.length) {
          selectOption(filtered[highlightIndex]);
        } else {
          setOpen(false);
        }
        break;
      case 'Escape':
        setOpen(false);
        setHighlightIndex(-1);
        break;
    }
  };

  return (
    <div className="w-full" ref={wrapperRef}>
      {label && (
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-secondary mb-1"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!disabled) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className={`
            w-full px-3 py-2 text-sm text-nav-dark bg-white
            border border-gray-200 rounded-lg
            placeholder:text-gray-400
            focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
            disabled:opacity-50 disabled:bg-gray-50
            transition-colors duration-150
            ${error ? 'border-red-400 focus:ring-red-200 focus:border-red-400' : ''}
            ${className}
          `}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={inputId ? `${inputId}-listbox` : undefined}
          aria-activedescendant={
            highlightIndex >= 0 && inputId
              ? `${inputId}-option-${highlightIndex}`
              : undefined
          }
        />

        {/* Dropdown chevron */}
        <svg
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>

        {open && filtered.length > 0 && !disabled && (
          <ul
            ref={listRef}
            id={inputId ? `${inputId}-listbox` : undefined}
            role="listbox"
            className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
          >
            {filtered.map((opt, i) => (
              <li
                key={opt}
                id={inputId ? `${inputId}-option-${i}` : undefined}
                role="option"
                aria-selected={i === highlightIndex}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent blur before selection
                  selectOption(opt);
                }}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`
                  w-full text-left px-3 py-2 text-sm cursor-pointer
                  ${i === highlightIndex
                    ? 'bg-crx-green/10 text-crx-green font-medium'
                    : 'text-nav-dark hover:bg-gray-50'}
                `}
              >
                {opt}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

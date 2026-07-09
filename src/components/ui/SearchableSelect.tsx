import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  /** Commits only selected options and deliberate blur-with-empty-text clears; typing only filters. */
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  id?: string;
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select an option...',
  disabled = false,
  required = false,
  label,
  id,
}: SearchableSelectProps) {
  const generatedId = useId();
  const inputId = id || `searchable-select-${generatedId}`;
  const listId = `${inputId}-listbox`;
  const selectedOption = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selectedOption?.label || '');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  useEffect(() => {
    setQuery(selectedOption?.label || '');
  }, [selectedOption?.label, value]);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return options;

    return options.filter((option) =>
      `${option.label} ${option.sublabel || ''}`.toLowerCase().includes(normalizedQuery)
    );
  }, [options, query]);

  useEffect(() => {
    setHighlightedIndex((current) => Math.min(current, Math.max(filteredOptions.length - 1, 0)));
  }, [filteredOptions.length]);

  const selectOption = (option: SearchableSelectOption) => {
    onChange(option.value);
    setQuery(option.label);
    setIsOpen(false);
  };

  const handleInputChange = (nextQuery: string) => {
    setQuery(nextQuery);
    setIsOpen(true);
    setHighlightedIndex(0);
  };

  const handleBlur = () => {
    window.setTimeout(() => {
      if (!query.trim() && value) {
        setQuery('');
        onChange('');
      } else if (value && query !== selectedOption?.label) {
        setQuery(selectedOption?.label || '');
      }

      setIsOpen(false);
    }, 150);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((current) => Math.min(current + 1, filteredOptions.length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === 'Enter') {
      if (!isOpen || !filteredOptions[highlightedIndex]) return;
      event.preventDefault();
      selectOption(filteredOptions[highlightedIndex]);
      return;
    }

    if (event.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div className="relative">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-nav-dark mb-1">
          {label}{required && ' *'}
        </label>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={isOpen && filteredOptions[highlightedIndex] ? `${listId}-option-${highlightedIndex}` : undefined}
          value={query}
          onChange={(event) => handleInputChange(event.target.value)}
          onFocus={() => {
            setIsOpen(true);
            setHighlightedIndex(0);
          }}
          onClick={() => {
            setIsOpen(true);
            setHighlightedIndex(0);
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className="w-full pl-9 pr-9 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-100 disabled:text-gray-500"
        />
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
      </div>
      {isOpen && !disabled && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-30 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option, index) => (
              <button
                id={`${listId}-option-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(option)}
                className={`w-full text-left px-3 py-2 text-sm flex justify-between items-center ${
                  index === highlightedIndex ? 'bg-gray-50' : 'hover:bg-gray-50'
                }`}
              >
                <span className="font-medium text-nav-dark">{option.label}</span>
                {option.sublabel && <span className="text-xs text-secondary">{option.sublabel}</span>}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-secondary">No matches found</div>
          )}
        </div>
      )}
    </div>
  );
}

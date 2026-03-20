import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  text: string;
  className?: string;
}

export default function HelpTip({ text, className = '' }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="help"
        className="text-gray-400 hover:text-crx-green transition-colors p-0.5"
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 bg-white border border-gray-200 rounded-lg shadow-lg text-sm text-gray-700 leading-relaxed">
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-white" />
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-200" />
          {text}
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  text: string;
  className?: string;
}

export default function HelpTip({ text, className = '' }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'above' | 'below' }>({ top: 0, left: 0, placement: 'below' });

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const popoverHeight = 120; // approximate max height
    const popoverWidth = 288; // w-72 = 18rem = 288px
    const spaceAbove = rect.top;
    const placement = spaceAbove > popoverHeight + 8 ? 'above' : 'below';
    let left = rect.left + rect.width / 2 - popoverWidth / 2;
    // Keep popover within viewport horizontally
    if (left < 8) left = 8;
    if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8;
    const top = placement === 'above' ? rect.top - 8 : rect.bottom + 8;
    setPos({ top, left, placement });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    function handleClickOutside(e: MouseEvent) {
      if (
        buttonRef.current && !buttonRef.current.contains(e.target as Node) &&
        popoverRef.current && !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  return (
    <span className={`inline-flex items-center ${className}`}>
      <span
        ref={buttonRef}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
        aria-label="help"
        className="text-gray-400 hover:text-crx-green transition-colors p-0.5 cursor-pointer"
      >
        <HelpCircle className="w-4 h-4" />
      </span>
      {open && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            top: pos.placement === 'above' ? undefined : pos.top,
            bottom: pos.placement === 'above' ? `${window.innerHeight - pos.top}px` : undefined,
            left: pos.left,
            zIndex: 9999,
          }}
          className="w-72 p-3 bg-white border border-gray-200 rounded-lg shadow-lg text-sm text-gray-700 leading-relaxed"
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

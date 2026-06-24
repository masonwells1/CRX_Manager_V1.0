import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ArrowRight } from 'lucide-react';
import CustomerSummaryBar from './CustomerSummaryBar';
import { useAuth } from '../../contexts/AuthContext';
import { hasPageAccess } from '../../lib/pagePermissions';

interface CustomerDrawerProps {
  open: boolean;
  customerId: string;
  customerName: string;
  onClose: () => void;
}

/**
 * Customer 360 slide-over (F2). Peek a customer's key numbers from any list row
 * without leaving the list. Reuses the already-styled CustomerSummaryBar; the
 * full 8-tab profile is one click away. Read-only — no writes here.
 */
export default function CustomerDrawer({ open, customerId, customerName, onClose }: CustomerDrawerProps) {
  const navigate = useNavigate();
  const { role, deniedPages } = useAuth();
  // Self-guard (defense-in-depth): this drawer renders CustomerSummaryBar, which
  // exposes AR balance + credit tier. Callers gate the open-button, but gate it HERE
  // too so the finance data can NEVER render to someone without customers-page access
  // (a driver, or a sales_rep denied /customers) regardless of which list mounts it.
  // This is the structural fix for the round-5 P1 leak — safe by construction.
  const canViewCustomer = hasPageAccess(role, deniedPages, 'customers');
  // `shown` drives the slide-in: mount off-screen (translate-x-full), then flip on next frame.
  const [shown, setShown] = useState(false);

  // Close on Escape + lock body scroll while open; trigger the enter transition.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open || !customerId || !canViewCustomer) return null;

  const openProfile = () => {
    onClose();
    navigate(`/customers/${customerId}`);
  };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={`${customerName} details`}>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — slides in from the right (plain-Tailwind transform, like the mobile sidebar) */}
      <aside
        className={`fixed top-0 right-0 h-full w-full max-w-md bg-white shadow-2xl flex flex-col transition-transform duration-200 ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-secondary uppercase tracking-wide">Customer</p>
            <h2 className="text-lg font-semibold font-heading text-nav-dark truncate">{customerName}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close customer panel"
            className="p-1.5 rounded-lg text-gray-400 hover:text-nav-dark hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <CustomerSummaryBar customerId={customerId} />
        </div>

        {/* Footer action */}
        <div className="px-5 py-4 border-t border-gray-200">
          <button
            onClick={openProfile}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-crx-green text-white text-sm font-medium hover:bg-crx-green/90 transition-colors"
          >
            Open full profile
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </aside>
    </div>
  );
}

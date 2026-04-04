import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileText, ClipboardList, Truck, Receipt, ChevronDown } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────

interface ThreadEntity {
  id: string;
  number: string;
}

export interface TransactionThreadProps {
  quoteId?: string;
  quoteNumber?: string;
  orderId?: string;
  orderNumber?: string;
  orders?: ThreadEntity[];  // For quotes with multiple orders
  deliveries?: ThreadEntity[];
  invoices?: ThreadEntity[];
  currentEntity: 'quote' | 'order' | 'delivery' | 'invoice';
  currentEntityId?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function StepArrow() {
  return (
    <span className="text-gray-300 mx-1 flex-shrink-0" aria-hidden="true">→</span>
  );
}

interface MultiDropdownProps {
  items: ThreadEntity[];
  basePath: string;
  label: string;
  currentId?: string;
  icon: React.ReactNode;
  activeColor: string;
}

function MultiDropdown({ items, basePath, label, currentId, icon, activeColor }: MultiDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium transition-colors ${activeColor}`}
      >
        {icon}
        {items.length} {label}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20 min-w-[180px]">
          {items.map((item) => (
            <Link
              key={item.id}
              to={`${basePath}/${item.id}`}
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 text-sm transition-colors ${
                item.id === currentId
                  ? 'text-crx-green font-semibold bg-crx-green/5'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {item.number}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────

export default function TransactionThread({
  quoteId,
  quoteNumber,
  orderId,
  orderNumber,
  orders = [],
  deliveries = [],
  invoices = [],
  currentEntity,
  currentEntityId,
}: TransactionThreadProps) {
  const hasQuote = !!quoteId;
  const hasOrder = !!orderId || orders.length > 0;
  const hasDeliveries = deliveries.length > 0;
  const hasInvoices = invoices.length > 0;

  // Don't render if there's nothing to link (single entity with no related entities)
  const linkCount = [hasQuote, hasOrder, hasDeliveries, hasInvoices].filter(Boolean).length;
  if (linkCount <= 1) return null;

  const isActive = (entity: string, id?: string) =>
    currentEntity === entity && (!id || id === currentEntityId);

  const activeClass = 'text-crx-green font-semibold bg-crx-green/10';
  const inactiveClass = 'text-gray-600 hover:text-crx-green hover:bg-gray-50';
  const missingClass = 'text-gray-300 cursor-default';

  return (
    <div className="flex items-center flex-wrap gap-1 px-3 py-2 bg-white rounded-lg border border-gray-100 shadow-sm mb-4" aria-label="Transaction thread">
      {/* Quote step */}
      {hasQuote ? (
        <Link
          to={`/quotes/${quoteId}`}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium transition-colors ${
            isActive('quote') ? activeClass : inactiveClass
          }`}
        >
          <FileText className="w-4 h-4" />
          {quoteNumber || 'Quote'}
        </Link>
      ) : (
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-sm ${missingClass}`}>
          <FileText className="w-4 h-4" />
          No quote
        </span>
      )}

      <StepArrow />

      {/* Order step — supports both single order (orderId) and multi-order (orders[]) */}
      {orders.length > 1 ? (
        <MultiDropdown
          icon={<ClipboardList className="w-4 h-4" />}
          label={`${orders.length} Orders`}
          items={orders}
          basePath="/orders"
          isActive={(id) => isActive('order', id)}
          activeClass={activeClass}
          inactiveClass={inactiveClass}
        />
      ) : hasOrder ? (
        <Link
          to={`/orders/${orders[0]?.id || orderId}`}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium transition-colors ${
            isActive('order', orders[0]?.id || orderId) ? activeClass : inactiveClass
          }`}
        >
          <ClipboardList className="w-4 h-4" />
          {orders[0]?.number || orderNumber || 'Order'}
        </Link>
      ) : (
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-sm ${missingClass}`}>
          <ClipboardList className="w-4 h-4" />
          No order
        </span>
      )}

      <StepArrow />

      {/* Deliveries step */}
      {hasDeliveries ? (
        deliveries.length === 1 ? (
          <Link
            to={`/deliveries/${deliveries[0].id}`}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium transition-colors ${
              isActive('delivery', deliveries[0].id) ? activeClass : inactiveClass
            }`}
          >
            <Truck className="w-4 h-4" />
            {deliveries[0].number}
          </Link>
        ) : (
          <MultiDropdown
            items={deliveries}
            basePath="/deliveries"
            label="Deliveries"
            currentId={currentEntityId}
            icon={<Truck className="w-4 h-4" />}
            activeColor={currentEntity === 'delivery' ? activeClass : inactiveClass}
          />
        )
      ) : (
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-sm ${missingClass}`}>
          <Truck className="w-4 h-4" />
          No deliveries
        </span>
      )}

      <StepArrow />

      {/* Invoices step */}
      {hasInvoices ? (
        invoices.length === 1 ? (
          <Link
            to={`/invoices/${invoices[0].id}`}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium transition-colors ${
              isActive('invoice', invoices[0].id) ? activeClass : inactiveClass
            }`}
          >
            <Receipt className="w-4 h-4" />
            {invoices[0].number}
          </Link>
        ) : (
          <MultiDropdown
            items={invoices}
            basePath="/invoices"
            label="Invoices"
            currentId={currentEntityId}
            icon={<Receipt className="w-4 h-4" />}
            activeColor={currentEntity === 'invoice' ? activeClass : inactiveClass}
          />
        )
      ) : (
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-sm ${missingClass}`}>
          <Receipt className="w-4 h-4" />
          No invoices
        </span>
      )}
    </div>
  );
}

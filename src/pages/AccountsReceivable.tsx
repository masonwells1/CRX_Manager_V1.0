import { useSearchParams } from 'react-router-dom';
import ARaging from './ARaging';
import PaymentHistory from './PaymentHistory';
import PrepaymentManager from './PrepaymentManager';
import CustomerTransactionReview from './CustomerTransactionReview';

// F4: one Accounts Receivable workspace that gathers the four previously-separate
// admin-only money screens (Aging / Payment History / Prepayments / Ledger) under
// one tabbed page. This v1 renders each existing page as-is in a tab (only the
// active tab mounts, so each fetches only when shown) — it does NOT change any
// page's logic or roles. The old routes still work; converting them to redirects
// and sharing a single customer picker across tabs are follow-ups for Mason.
// NOTE: /payments (PaymentAllocation) is intentionally NOT merged here — it is
// admin+sales_rep and must stay its own page (CLAUDE.md red line).

const TABS = [
  { key: 'aging', label: 'AR Aging' },
  { key: 'payments', label: 'Payment History' },
  { key: 'prepayments', label: 'Prepayments' },
  { key: 'ledger', label: 'Transactions' },
] as const;

export default function AccountsReceivable() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab = TABS.some((t) => t.key === raw) ? (raw as (typeof TABS)[number]['key']) : 'aging';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold font-heading text-nav-dark">Accounts Receivable</h2>
        <p className="text-xs text-secondary mt-0.5">
          Aging, payments, prepayments, and the customer ledger — in one place.
        </p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSearchParams({ tab: t.key })}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-crx-green text-crx-green'
                : 'border-transparent text-secondary hover:text-nav-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div>
        {tab === 'aging' && <ARaging />}
        {tab === 'payments' && <PaymentHistory />}
        {tab === 'prepayments' && <PrepaymentManager />}
        {tab === 'ledger' && <CustomerTransactionReview />}
      </div>
    </div>
  );
}

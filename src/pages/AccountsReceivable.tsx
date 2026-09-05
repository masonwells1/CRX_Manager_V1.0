import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase, assertRpcResult } from '../lib/db';
import { formatUSD } from '../lib/money';
import Card from '../components/ui/Card';
import PageHeader from '../components/ui/PageHeader';
import ARaging from './ARaging';
import PaymentHistory from './PaymentHistory';
import PrepaymentManagerPanel from '../components/prepay/PrepaymentManagerPanel';
import CustomerTransactionReview from './CustomerTransactionReview';

// F4: one Accounts Receivable workspace that gathers the four previously-separate
// admin-only money screens (Aging / Payment History / Prepayments / Ledger) under
// one tabbed page, with a "Net Money Position" summary strip on top. This v1
// renders each existing page as-is in a tab (only the active tab mounts) — it does
// NOT change any page's logic or roles. The old routes still work; converting them
// to redirects and sharing a single customer picker across tabs are follow-ups.
// NOTE: /payments (PaymentAllocation) is intentionally NOT merged here — it is
// admin+sales_rep and must stay its own page (AGENTS.md CRX Hard Rule).

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

  // Net Money Position: total owed (get_ar_aging, dollars) minus unused customer
  // prepay credits (prepay_credits.balance_cents) and open credit memos
  // (Option B, 2026-07-11: credit shows separately, never silently netted
  // per-invoice). Read-only summary, zero DB.
  const [owed, setOwed] = useState<number | null>(null);
  const [prepay, setPrepay] = useState<number>(0);
  const [openCredit, setOpenCredit] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const { data: arData } = await supabase.rpc('get_ar_aging', { p_as_of_date: today });
        const arRows = assertRpcResult<Array<{ total_outstanding?: number }>>(arData, 'get_ar_aging');
        const owedSum = (arRows || []).reduce((s, r) => s + Number(r.total_outstanding || 0), 0);
        // A failed prepay load must NOT silently become $0 — that would overstate
        // the Net Position finance total. Throw so the whole card is suppressed
        // (catch sets owed=null) rather than showing a wrong number (Codex P2).
        const { data: prepayRows, error: prepayErr } = await supabase.from('prepay_credits').select('balance_cents');
        if (prepayErr) throw prepayErr;
        const prepaySum = (prepayRows || []).reduce((s, r) => s + Number(r.balance_cents || 0), 0) / 100;
        // Open credit memos: posted credit_memo invoices whose (negative)
        // balance hasn't been fully applied. Same suppress-on-error rule as
        // prepay — a wrong $0 here would overstate Net Position.
        const { data: creditRows, error: creditErr } = await supabase
          .from('invoices')
          .select('balance_cents')
          .eq('invoice_type', 'credit_memo')
          .eq('status', 'posted')
          .lt('balance_cents', 0)
          .is('deleted_at', null);
        if (creditErr) throw creditErr;
        const creditSum = (creditRows || []).reduce((s, r) => s + -Number(r.balance_cents ?? 0), 0) / 100;
        if (!cancelled) {
          setOwed(owedSum);
          setPrepay(prepaySum);
          setOpenCredit(creditSum);
        }
      } catch {
        if (!cancelled) setOwed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const net = owed !== null ? owed - prepay - openCredit : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Accounts"
        accent="Receivable"
        subtitle="Aging, payments, prepayments, and the customer ledger — in one place."
      />

      {owed !== null && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <p className="text-[11px] font-medium text-secondary uppercase tracking-wide">Total Owed</p>
            <p className={`text-2xl font-semibold font-heading mt-1 ${owed > 0 ? 'text-red-600' : 'text-crx-green'}`}>
              {formatUSD(owed)}
            </p>
            <p className="text-xs text-secondary mt-1">outstanding on open invoices</p>
          </Card>
          <Card>
            <p className="text-[11px] font-medium text-secondary uppercase tracking-wide">Unused Prepay</p>
            <p className="text-2xl font-semibold font-heading mt-1 text-crx-green">{formatUSD(prepay)}</p>
            <p className="text-xs text-secondary mt-1">customer credits not yet applied</p>
          </Card>
          <Card>
            <p className="text-[11px] font-medium text-secondary uppercase tracking-wide">Credit Memos</p>
            <p className="text-2xl font-semibold font-heading mt-1 text-amber-600">{formatUSD(openCredit)}</p>
            <p className="text-xs text-secondary mt-1">open credit memos not yet applied</p>
          </Card>
          <Card>
            <p className="text-[11px] font-medium text-secondary uppercase tracking-wide">Net Position</p>
            <p className={`text-2xl font-semibold font-heading mt-1 ${(net ?? 0) > 0 ? 'text-red-600' : 'text-crx-green'}`}>
              {formatUSD(net ?? 0)}
            </p>
            <p className="text-xs text-secondary mt-1">true exposure = owed minus unused prepay & credit</p>
          </Card>
        </div>
      )}

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
        {tab === 'prepayments' && <PrepaymentManagerPanel />}
        {tab === 'ledger' && <CustomerTransactionReview />}
      </div>
    </div>
  );
}

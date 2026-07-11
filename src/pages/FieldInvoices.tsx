import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Tabs, { type TabItem } from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import { supabase } from '../lib/db';
import { getSeasonDates } from '../utils/season';
import FieldInvoicesListPanel from '../components/field-invoices/FieldInvoicesListPanel';
import FieldInvoicesUnpostedPanel from '../components/field-invoices/FieldInvoicesUnpostedPanel';
import FieldInvoicesPostedPanel from '../components/field-invoices/FieldInvoicesPostedPanel';
import CustomerInvoiceSummaryPanel from '../components/field-invoices/CustomerInvoiceSummaryPanel';
import UnbilledApplicationsPanel from '../components/field-invoices/UnbilledApplicationsPanel';

type FieldInvoiceTab = 'unbilled' | 'drafts' | 'posted' | 'customer' | 'all';

const TAB_ALIASES: Record<string, FieldInvoiceTab> = {
  unbilled: 'unbilled',
  drafts: 'drafts',
  unposted: 'drafts',
  posted: 'posted',
  customer: 'customer',
  summary: 'customer',
  all: 'all',
};

interface InvoiceCounts {
  drafts?: number;
  posted?: number;
}

/**
 * Single workflow surface for every field-invoice task. The pre-existing page
 * bodies remain independently mounted tab panels, preserving their filters,
 * print/email actions, posting safeguards, and customer-summary workflow.
 */
export default function FieldInvoices() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [counts, setCounts] = useState<InvoiceCounts>({});
  const activeTab = TAB_ALIASES[searchParams.get('tab') ?? 'unbilled'] ?? 'unbilled';

  useEffect(() => {
    let cancelled = false;

    const loadCounts = async () => {
      const { start: seasonStart, end: seasonEnd } = getSeasonDates();
      const countInvoices = (statuses: string[]) =>
        supabase
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('invoice_type', 'field_application')
          .in('status', statuses)
          .is('deleted_at', null)
          .gte('invoice_date', seasonStart)
          .lte('invoice_date', seasonEnd);

      // These are independent, read-only count queries. They intentionally do
      // not use RPCs, and a count failure only omits a nonessential badge.
      const [draftsResult, postedResult] = await Promise.all([
        countInvoices(['draft', 'unposted']),
        countInvoices(['posted', 'overdue', 'paid']),
      ]);

      if (cancelled) return;
      setCounts({
        drafts: draftsResult.error ? undefined : (draftsResult.count ?? 0),
        posted: postedResult.error ? undefined : (postedResult.count ?? 0),
      });
    };

    void loadCounts();
    return () => { cancelled = true; };
  }, []);

  const tabs: TabItem[] = [
    { key: 'unbilled', label: 'Unbilled', content: <UnbilledApplicationsPanel /> },
    { key: 'drafts', label: 'Drafts', count: counts.drafts, content: <FieldInvoicesUnpostedPanel /> },
    { key: 'posted', label: 'Posted', count: counts.posted, content: <FieldInvoicesPostedPanel /> },
    { key: 'customer', label: 'By Customer', content: <CustomerInvoiceSummaryPanel /> },
    // Retains the original all-status list, including CSV/report actions and
    // its status/card filters. The first four tabs are the daily workflow.
    { key: 'all', label: 'All Invoices', content: <FieldInvoicesListPanel /> },
  ];

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    setSearchParams(params);
  };

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title="Field"
        accent="Invoices"
        subtitle="Move applied work from unbilled through draft and posted invoices, then review by customer."
      />

      <Tabs
        tabs={tabs}
        activeKey={activeTab}
        onChange={handleTabChange}
        ariaLabel="Field invoice workflow"
      />
    </div>
  );
}

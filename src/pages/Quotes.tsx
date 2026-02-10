import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Copy } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkQuoteImport from '../components/quotes/BulkQuoteImport';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import type { Quote } from '../types';

export default function Quotes() {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { toast } = useToast();

  // === GAP FIX #7: Duplicate a quote ===
  const handleDuplicate = async (quoteId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const [quoteRes, sectionsRes, itemsRes] = await Promise.all([
      supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle(),
      supabase.from('quote_sections').select('*').eq('quote_id', quoteId).order('sort_order'),
      supabase.from('quote_items').select('*').eq('quote_id', quoteId).order('sort_order'),
    ]);
    if (!quoteRes.data) { toast('error', 'Could not find quote to duplicate'); return; }
    const orig = quoteRes.data;
    const year = new Date().getFullYear();
    const { count } = await supabase.from('quotes').select('*', { count: 'exact', head: true }).like('quote_number', `Q-${year}-%`);
    const newQuoteNumber = `Q-${year}-${String((count || 0) + 1).padStart(4, '0')}`;
    const { data: newQuote, error } = await supabase.from('quotes').insert({
      quote_number: newQuoteNumber, customer_id: orig.customer_id, created_by: orig.created_by,
      tier: orig.tier, status: 'draft', commission_split: orig.commission_split,
      total_price: orig.total_price, total_cost: orig.total_cost, total_profit: orig.total_profit,
      total_margin_pct: orig.total_margin_pct, valid_days: orig.valid_days,
      expires_at: new Date(Date.now() + (orig.valid_days || 15) * 86400000).toISOString(),
      header_notes: orig.header_notes, footer_notes: orig.footer_notes,
    }).select().maybeSingle();
    if (error || !newQuote) { toast('error', 'Failed to duplicate quote'); return; }
    const origSections = sectionsRes.data || [];
    const origItems = itemsRes.data || [];
    for (const sec of origSections) {
      const { data: newSec } = await supabase.from('quote_sections').insert({
        quote_id: newQuote.id, section_name: sec.section_name, sort_order: sec.sort_order, section_notes: sec.section_notes,
      }).select().maybeSingle();
      if (newSec) {
        const sectionItems = origItems.filter((i: any) => i.section_id === sec.id).map((i: any) => ({
          quote_id: newQuote.id, section_id: newSec.id, product_id: i.product_id, sort_order: i.sort_order,
          notes: i.notes, price_per_unit: i.price_per_unit, current_cost: i.current_cost,
          suggested_rate: i.suggested_rate, actual_rate: i.actual_rate, rate_unit: i.rate_unit,
          oz_per_acre: i.oz_per_acre, price_per_acre: i.price_per_acre, acres: i.acres,
          total_units_needed: i.total_units_needed, unit_size: i.unit_size, profit: i.profit,
          total_price: i.total_price, net_margin: i.net_margin,
        }));
        if (sectionItems.length > 0) await supabase.from('quote_items').insert(sectionItems);
      }
    }
    toast('success', `Quote duplicated as ${newQuoteNumber}`);
    navigate(`/quotes/${newQuote.id}`);
  };

  useEffect(() => {
    fetchQuotes();
  }, []);

  const fetchQuotes = async () => {
    const { data, error } = await supabase
      .from('quotes')
      .select('*, customer:customers(farm_name)')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Failed to load quotes:', error.message);
      toast('error', 'Failed to load quotes. Please try again.');
      setLoading(false);
      return;
    }
    setQuotes((data || []) as Quote[]);
    setLoading(false);
  };

  const filtered = quotes.filter((q) => {
    if (statusFilter && q.status !== statusFilter) return false;
    return true;
  });

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const columns: Column<Quote>[] = [
    {
      key: 'quote_number',
      header: 'Quote #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.quote_number}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (row.customer as unknown as { farm_name: string })?.farm_name || '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
          {row.status.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortable: true,
      render: (row) => <span>Tier {row.tier}</span>,
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (row) => new Date(row.created_at).toLocaleDateString(),
    },
    {
      key: 'expires_at',
      header: 'Expires',
      sortable: true,
      render: (row) => (row.expires_at ? new Date(row.expires_at).toLocaleDateString() : '-'),
    },
    {
      key: 'id',
      header: '',
      render: (row) => (
        <button
          onClick={(e) => handleDuplicate(row.id, e)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-crx-green hover:bg-crx-green-light transition-colors"
          title="Duplicate this quote"
        >
          <Copy className="w-4 h-4" />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          icon={<Upload className="w-4 h-4" />}
          onClick={() => setImportModalOpen(true)}
        >
          Bulk Import
        </Button>
        <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
          New Quote
        </Button>
      </div>

      <BulkQuoteImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchQuotes}
      />

      <Card padding={false}>
        <div className="p-5">
          <DataTable<Quote>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search by quote # or customer..."
            searchKeys={['quote_number']}
            onRowClick={(row) => navigate(`/quotes/${row.id}`)}
            emptyTitle="No quotes yet"
            emptyDescription="Create your first quote to get started"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                New Quote
              </Button>
            }
            loading={loading}
            filters={
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="sent">Sent</option>
                <option value="revised">Revised</option>
                <option value="accepted">Accepted</option>
                <option value="declined">Declined</option>
                <option value="expired">Expired</option>
              </select>
            }
          />
        </div>
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Copy } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkQuoteImport from '../components/quotes/BulkQuoteImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import type { Quote } from '../types';

export default function Quotes() {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { toast } = useToast();
  const { profile } = useAuth();

  // === GAP FIX #7: Duplicate a quote ===
  const handleDuplicate = async (quoteId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const idemKey = generateIdempotencyKey('duplicate_quote', profile!.id);
      const { data: result, error } = await supabase.rpc('duplicate_quote', {
        p_source_quote_id: quoteId,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });
      if (error) {
        toast('error', `Failed to duplicate quote: ${error.message}`);
        return;
      }
      const dupResult = assertRpcResult<{ quote_id: string; quote_number: string }>(result, 'duplicate_quote');
      toast('success', `Quote duplicated as ${dupResult.quote_number}`);
      navigate(`/quotes/${dupResult.quote_id}`);
    } catch (err: unknown) {
      toast('error', `Failed to duplicate quote: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    fetchQuotes();
  }, []);

  const fetchQuotes = async () => {
    const { data, error } = await supabase
      .from('quotes')
      .select('*, customer:customers(farm_name)')
      .order('created_at', { ascending: false })
      .limit(500);
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
                aria-label="Filter by quote status"
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

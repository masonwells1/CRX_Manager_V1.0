import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkQuoteImport from '../components/quotes/BulkQuoteImport';
import { supabase } from '../lib/db';
import type { Quote } from '../types';

export default function Quotes() {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [importModalOpen, setImportModalOpen] = useState(false);

  useEffect(() => {
    fetchQuotes();
  }, []);

  const fetchQuotes = async () => {
    const { data } = await supabase
      .from('quotes')
      .select('*, customer:customers(farm_name)')
      .order('created_at', { ascending: false });
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
          <DataTable
            data={filtered as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search by quote # or customer..."
            searchKeys={['quote_number']}
            onRowClick={(row) => navigate(`/quotes/${(row as unknown as Quote).id}`)}
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

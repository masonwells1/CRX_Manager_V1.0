/**
 * DesignPreview — DEV-ONLY component gallery.
 *
 * Renders the shared UI components in one place so the design system / visual refresh
 * can be verified visually WITHOUT logging in (the rest of the app is behind auth).
 * Mounted at /design-preview, gated by import.meta.env.DEV, and excluded from
 * production builds. Pure presentational: no auth, no Supabase, mock data only.
 */
import { useState } from 'react';
import { Plus, Download, Trash2, Package } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Select from '../components/ui/Select';
import EmptyState from '../components/ui/EmptyState';
import DataTable, { type Column } from '../components/ui/DataTable';

interface SampleRow {
  id: string;
  name: string;
  tier: number;
  balance: number;
  status: string;
}

const SAMPLE_ROWS: SampleRow[] = [
  { id: '1', name: 'Diamond R Farms', tier: 1, balance: 12450, status: 'overdue' },
  { id: '2', name: 'Klein Ag LLC', tier: 2, balance: 3200, status: 'paid' },
  { id: '3', name: 'Buckeye Acres', tier: 3, balance: 8750, status: 'partially_paid' },
  { id: '4', name: 'Sycamore Hill Farm', tier: 1, balance: 0, status: 'paid' },
];

const BADGES: BadgeVariant[] = ['default', 'success', 'warning', 'error', 'info', 'draft', 'sent', 'accepted', 'declined', 'expired', 'danger'];

export default function DesignPreview() {
  const [tier, setTier] = useState('');

  const columns: Column<SampleRow>[] = [
    { key: 'name', header: 'Customer', sortable: true },
    { key: 'tier', header: 'Tier', sortable: true, render: (r) => `Tier ${r.tier}` },
    { key: 'balance', header: 'Balance', sortable: true, className: 'text-right', render: (r) => '$' + r.balance.toLocaleString() },
    { key: 'status', header: 'Status', render: (r) => <Badge variant="info">{r.status.replace('_', ' ')}</Badge> },
  ];

  return (
    <div className="min-h-screen bg-cream p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold font-heading text-nav-dark">Design System Preview</h1>
          <p className="text-sm text-secondary mt-1">Dev-only gallery for verifying the visual refresh. Not shipped to production.</p>
        </div>

        <Card>
          <CardHeader title="Buttons" accent="& actions" />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost" showChevron={false}>Ghost</Button>
            <Button variant="danger" showChevron={false} icon={<Trash2 className="w-4 h-4" />}>Delete</Button>
            <Button variant="primary" showChevron={false} icon={<Plus className="w-4 h-4" />}>New order</Button>
            <Button variant="secondary" icon={<Download className="w-4 h-4" />}>Export</Button>
            <Button variant="primary" loading>Saving</Button>
            <Button variant="primary" disabled>Disabled</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <Button size="sm" showChevron={false}>Small</Button>
            <Button size="md" showChevron={false}>Medium</Button>
            <Button size="lg" showChevron={false}>Large</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Status" accent="badges" />
          <div className="flex flex-wrap items-center gap-2">
            {BADGES.map((v) => (
              <Badge key={v} variant={v}>{v}</Badge>
            ))}
          </div>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card hover>
            <CardHeader title="Card" accent="with hover" action={<Button size="sm" variant="ghost" showChevron={false}>Action</Button>} />
            <p className="text-sm text-secondary">A standard card surface with a header and an action. Hover to see the elevation.</p>
          </Card>
          <Card>
            <CardHeader title="Metric" accent="example" />
            <p className="text-3xl font-semibold font-heading text-nav-dark">$541,085</p>
            <p className="text-sm text-secondary mt-1">Total to ship</p>
          </Card>
        </div>

        <Card>
          <CardHeader title="Inputs" accent="& selects" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input label="Customer name" placeholder="Type a name…" />
            <Input label="Email" type="email" placeholder="you@example.com" required />
            <Input label="With error" defaultValue="bad value" error="Something is wrong" />
            <Select label="Tier" placeholder="Choose a tier" options={[{ value: '1', label: 'Tier 1' }, { value: '2', label: 'Tier 2' }, { value: '3', label: 'Tier 3' }]} value={tier} onChange={(e) => setTier(e.target.value)} />
            <Input label="Disabled" placeholder="Can't type" disabled />
            <Input label="Number" type="number" placeholder="0" />
          </div>
        </Card>

        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Data" accent="table" />
            <DataTable<SampleRow>
              data={SAMPLE_ROWS}
              columns={columns}
              searchable
              searchPlaceholder="Search customers…"
              searchKeys={['name']}
              onRowClick={() => {}}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Empty" accent="state" />
          <EmptyState
            icon={<Package className="w-6 h-6 text-gray-400" />}
            title="Nothing here yet"
            description="When there's data, it shows up here with a helpful action."
            action={<Button size="sm" showChevron={false} icon={<Plus className="w-4 h-4" />}>Add the first one</Button>}
          />
        </Card>
      </div>
    </div>
  );
}

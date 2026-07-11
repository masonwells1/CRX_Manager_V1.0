import { useSearchParams } from 'react-router-dom';
import PrepayWorkspacePanel from '../components/prepay/PrepayWorkspacePanel';
import PrepaymentManagerPanel from '../components/prepay/PrepaymentManagerPanel';
import Tabs, { type TabItem } from '../components/ui/Tabs';

type PrepayTab = 'workspace' | 'manager';

const TAB_ALIASES: Record<string, PrepayTab> = {
  workspace: 'workspace',
  allocate: 'workspace',
  manager: 'manager',
  prepayments: 'manager',
};

/**
 * Single surface for reviewing prepay credits and manually allocating them.
 * The pre-existing page bodies remain separate tab panels so their money
 * calculations, queries, RPC calls, and modal state stay unchanged.
 */
export default function Prepay() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = TAB_ALIASES[searchParams.get('tab') ?? 'workspace'] ?? 'workspace';

  const tabs: TabItem[] = [
    { key: 'workspace', label: 'Workspace', content: <PrepayWorkspacePanel /> },
    { key: 'manager', label: 'Manager', content: <PrepaymentManagerPanel /> },
  ];

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    setSearchParams(params);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold font-heading text-nav-dark">Prepay</h1>
        <p className="mt-1 text-sm text-secondary">
          Allocate customer prepay buckets and manage available prepayment credits.
        </p>
      </div>

      <Tabs
        tabs={tabs}
        activeKey={activeTab}
        onChange={handleTabChange}
        ariaLabel="Prepay workflow"
      />
    </div>
  );
}

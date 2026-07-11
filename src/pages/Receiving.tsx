import { useSearchParams } from 'react-router-dom';
import ReceivingHubPanel from '../components/receiving/ReceivingHubPanel';
import ReceivingLogPanel from '../components/receiving/ReceivingLogPanel';
import QuickReceivePanel from '../components/receiving/QuickReceivePanel';
import Tabs, { type TabItem } from '../components/ui/Tabs';

type ReceivingTab = 'hub' | 'quick' | 'log';

const TAB_ALIASES: Record<string, ReceivingTab> = {
  hub: 'hub',
  quick: 'quick',
  receive: 'quick',
  log: 'log',
  history: 'log',
};

/**
 * Single workflow surface for inbound inventory. The pre-existing page bodies
 * stay independently mounted as tab panels so their queries, filters, receive
 * safeguards, exports, and wizard state remain unchanged.
 */
export default function Receiving() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = TAB_ALIASES[searchParams.get('tab') ?? 'hub'] ?? 'hub';

  const tabs: TabItem[] = [
    { key: 'hub', label: 'Hub', content: <ReceivingHubPanel /> },
    { key: 'quick', label: 'Quick Receive', content: <QuickReceivePanel /> },
    { key: 'log', label: 'Log', content: <ReceivingLogPanel /> },
  ];

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', tab);
    setSearchParams(params);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold font-heading text-nav-dark">Receiving</h1>
        <p className="mt-1 text-sm text-secondary">
          Review inbound purchase orders, receive shipments, and audit receiving history.
        </p>
      </div>

      <Tabs
        tabs={tabs}
        activeKey={activeTab}
        onChange={handleTabChange}
        ariaLabel="Receiving workflow"
      />
    </div>
  );
}
